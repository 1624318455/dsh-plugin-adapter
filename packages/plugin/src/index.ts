import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './adapter/catalog.ts'
import { ZenAdapter, PROVIDER_ID, LEGACY_PROVIDER_ID } from './adapter/zen-adapter.ts'
import { createZenTransport } from './adapter/transport.ts'
import { createZenRelay } from './adapter/zen-relay.ts'
import { AgentProcess, type ReadyInfo } from './agent-process.js'
import { configPaths, ensureToken, resolveConfig, writeAgentConfig, type DshPluginAdapterConfig } from './config.js'
import { resolveDataDir } from './data-dir.js'
import { applyIpPoolSettings } from './ip-pool-settings/apply.ts'
import { fetchHealth, fetchModels, registerProvider, removeProviderRoute } from './provider.js'

/**
 * dsh-plugin-adapter DSH cordis plugin entry.
 *
 * Two modes (config.mode, default `adapter`):
 *  - adapter: register a DSH LlmAdapter streaming directly from the Zen
 *    anonymous lane (marketplace shape: no child process, no binary).
 *  - sidecar (legacy/dev): prepare data dir + token + agent-config.json,
 *    spawn the Go agent, wait for READY, register the llm-pi-ai provider
 *    route, schedule model refresh.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  credentials?: { set(ref: string, value: string): Promise<void> }
  settings?: {
    get(ns: string): unknown
    mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>): Promise<void>
    /** Full seam (rc.2): namespace registration + owner scope (docs §5.1). */
    register?(ns: unknown, schema: unknown, options?: { base?: unknown; applies?: 'live' | 'restart' }): {
      get(): unknown
      watch(callback: (next: unknown, prev: unknown) => void | Promise<void>): () => void
    }
  }
  /** Web route registration (dsh-host-webserver service, docs §5.3). */
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
  /** cordis fiber injection: run the callback once every listed service is up. */
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
  effect?(fn: () => () => void): unknown
  on?(event: string, listener: (...args: never[]) => unknown): () => void
}

/** Cordis plugin id. Must match cordis.patch.yml (package + repository). */
export const name = 'dsh-plugin-adapter'
export const inject = ['llm', 'credentials', 'settings'] as const
export function apply(ctx: PluginContext, config: DshPluginAdapterConfig = {}): { ready: Promise<ReadyInfo> } {
  if (resolveConfig(config).mode === 'sidecar') return applySidecar(ctx, config)
  return applyAdapter(ctx, config)
}

/**
 * Adapter mode: catalog + LlmAdapter registration. The adapter registration
 * is disposed with the plugin fiber (registerAdapter uses ctx.effect
 * internally); we only own the catalog refresh loop here.
 */
function applyAdapter(ctx: PluginContext, config: DshPluginAdapterConfig): { ready: Promise<{ port: number; version: string }> } {
  const logger = ctx.logger
  const cfg = resolveConfig(config)
  const ready = Promise.resolve({ port: 0, version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('dsh-plugin-adapter: llm service unavailable; adapter mode cannot register')
    return { ready }
  }

  // IP-pool exit routing (docs/ip-pool.md IP-1..IP-5): manual proxies,
  // pinned, free sources, subscriptions, and (IP-5) the settings namespace
  // with live apply + the /status /probe bridge. Opt-in via settings page or
  // cordis.patch.yml; disabled keeps the process byte-for-byte on direct.
  // Lifecycle (assembly on first enable, live reconfigure, dispose) is owned
  // by applyIpPoolSettings through the plugin fiber.
  // 0.4.0 rename: the data directory moved from ~/.opencode2dsh to
  // ~/.dsh-plugin-adapter; the legacy directory is copied over and parked
  // as a rollback path (data-dir.ts).
  const dataDir = resolveDataDir({ logger }).dir
  const statusPath = join(dataDir, 'adapter-status.json')
  const writeStatus = (status: CatalogSnapshot, lastError: string): void => {
    void writeFile(
      statusPath,
      JSON.stringify({ ...status, lastError, writtenAt: new Date().toISOString() }, null, 2),
      'utf8',
    ).catch(() => {})
  }

  const catalog = new ModelCatalog({
    refreshSeconds: cfg.refreshSeconds,
    cachePath: defaultCachePath(dataDir),
    onRefresh: (status, lastError) => {
      writeStatus(status, lastError)
      if (lastError) logger.warn(`dsh-plugin-adapter: catalog refresh issue: ${lastError}`)
    },
  })
  // Zen-lane transport (adapter/transport.ts + adapter/zen-relay.ts).
  //
  // Two jobs: (1) the free tier refuses Node's own HTTP client whatever the
  // request looks like (measured 2026-10-26: identical body, Node 0/6 vs Bun
  // 5/5), so the lane is re-originated by a loopback relay run by bun;
  // (2) the ambient proxy dispatcher reuses CONNECT tunnels that Clash/v2rayN
  // silently close, so a direct proxy path still pins pipelining: 0.
  // The IP pool owns the dispatcher when it is enabled (and already pins
  // pipelining: 0), so this seam stays off then.
  // The relay is the only client the free-tier gate answers when the host runs
  // on Node, so it stays on unless explicitly disabled — including when the IP
  // pool is enabled (the pool owns the Node dispatcher, which the Zen lane no
  // longer uses). Exit rotation for the Zen lane is the relay's own lever:
  // the free tier meters a daily quota per exit IP.
  const relay = cfg.transport?.relay === 'off'
    ? null
    : createZenRelay({
      bunPath: cfg.transport?.bunPath,
      proxyUrls: cfg.transport?.proxyUrls,
      proxyUrl: cfg.transport?.proxyUrl,
      proxyCooldownMs: cfg.transport?.proxyCooldownMs,
      log: (message) => logger.info(`dsh-plugin-adapter: ${message}`),
    })
  if (cfg.ipPool?.enabled === true && relay !== null) {
    logger.info('dsh-plugin-adapter: ipPool is enabled, but the Zen lane egresses through the relay exits (transport.proxyUrls), not the pool')
  }
  if (relay === null && cfg.transport?.relay !== 'off') {
    logger.warn('dsh-plugin-adapter: bun was not found, so the Zen lane keeps the Node HTTP stack; the free tier currently answers that stack with 429 FreeUsageLimitError (install bun, or set transport.bunPath)')
  }
  const transport = cfg.ipPool?.enabled === true
    ? null
    : createZenTransport({
      proxyUrl: cfg.transport?.proxyUrl,
      noReuse: cfg.transport?.noReuse,
      relay,
    })
  if (transport) {
    logger.info(`dsh-plugin-adapter: ${transport.describe()}`)
  } else if (cfg.transport?.proxyUrl) {
    logger.warn(`dsh-plugin-adapter: transport.proxyUrl "${cfg.transport.proxyUrl}" is not a usable http(s) proxy URI; Zen traffic keeps the ambient dispatcher`)
  }

  // Watchdog windows (config.watchdog): the first-event gate is a
  // time-to-first-token budget, tiered for reasoning models.
  const adapter = new ZenAdapter(catalog, {
    sessionOverride: cfg.gatewaySession,
    firstEventMs: cfg.watchdog?.firstEventMs,
    reasoningFirstEventMs: cfg.watchdog?.reasoningFirstEventMs,
    bodyIdleMs: cfg.watchdog?.bodyIdleMs,
    contextWindowCap: cfg.contextWindow,
    transport,
  })

  // IP-pool exit routing (docs/ip-pool.md IP-1..IP-5): manual proxies,
  // pinned, free sources, subscriptions, and (IP-5) the settings namespace
  // with live apply + the /status /models /probe bridge. Opt-in via settings
  // page or cordis.patch.yml; disabled keeps the process byte-for-byte on
  // direct. Lifecycle (assembly on first enable, live reconfigure, dispose) is
  // owned by applyIpPoolSettings through the plugin fiber. The probe-model
  // dropdown rows include the live catalog, so this must run after the
  // catalog instance exists.
  applyIpPoolSettings(ctx, config, logger, { listLiveModels: () => catalog.list() })

  // Register immediately: the provider must appear in the selector right
  // away, even while the catalog is still warming up (listModels is read
  // live at selector time, so models appear as refreshes land).
  ctx.llm.registerAdapter([PROVIDER_ID, LEGACY_PROVIDER_ID], adapter)
  logger.info(`dsh-plugin-adapter: adapter registered for "${PROVIDER_ID}" (legacy alias "${LEGACY_PROVIDER_ID}", catalog warms up in background)`)
  void catalog.start().catch((err) => {
    logger.error(`dsh-plugin-adapter: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // A sidecar leftover (llm-pi-ai.providers.opencode2dsh pointing at a dead
  // local port) would shadow the adapter registration and fail every dispatch
  // with a connection error. Remove it before the route can be used. The
  // pre-0.4.0 route name is included explicitly: an install that ran the old
  // sidecar still carries `providers.opencode2dsh` in the host settings.
  if (ctx.settings) {
    removeProviderRoute({ settings: ctx.settings }, cfg.providerId, [LEGACY_PROVIDER_ID])
      .then((removed) => {
        if (removed) logger.info(`dsh-plugin-adapter: removed stale sidecar route for "${cfg.providerId}" from llm-pi-ai settings`)
      })
      .catch((err) => {
        logger.warn(`dsh-plugin-adapter: stale route cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      catalog.stop()
      transport?.restore()
      relay?.dispose()
    })
  }
  return { ready }
}

function applySidecar(ctx: PluginContext, config: DshPluginAdapterConfig): { ready: Promise<ReadyInfo> } {
  const cfg = resolveConfig(config)
  const logger = ctx.logger
  const paths = configPaths(resolveDataDir({ logger }).dir)

  let agent: AgentProcess | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  let disposed = false
  let readyResolve: (info: ReadyInfo) => void = () => {}
  const ready = new Promise<ReadyInfo>((resolve) => {
    readyResolve = resolve
  })

  const onLog = (line: string) => {
    // Agent structured logs arrive as single JSON lines on stderr/stdout.
    logger.info(`[agent] ${line}`)
  }

  /**
   * Wait until the agent's model catalog is no longer "pending" (it fetches
   * the live S1 list a moment after listen; registering before that bakes the
   * 3-model static fallback into the DSH provider until the next refresh).
   */
  async function waitCatalogReady(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(port, 2000)
        const status = (health as { models?: { status?: string } })?.models?.status
        if (status && status !== 'pending') return
      } catch {
        // healthz hiccups right after listen are normal; keep polling
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    logger.warn('dsh-plugin-adapter: catalog still pending after timeout; registering whatever the agent exposes now')
  }

  async function refreshModels(info: ReadyInfo, token: string, { waitReady = false } = {}): Promise<void> {
    try {
      if (waitReady) await waitCatalogReady(info.port)
      const models = await fetchModels(info.port, token)
      if (ctx.credentials && ctx.settings) {
        await registerProvider(
          {
            credentials: ctx.credentials,
            settings: ctx.settings,
            logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
          },
          { providerId: cfg.providerId, apiKeyEnv: cfg.apiKeyEnv, port: info.port },
          token,
          models,
        )
      } else {
        logger.warn('dsh-plugin-adapter: credentials/settings services unavailable; provider route not registered')
      }
    } catch (err) {
      logger.warn(`dsh-plugin-adapter: model refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function scheduleRefresh(info: ReadyInfo, token: string): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (disposed) return
      void refreshModels(info, token).then(() => {
        if (!disposed && agent?.getState() === 'ready') scheduleRefresh(info, token)
      })
    }, cfg.refreshSeconds * 1000)
  }

  async function startOnce(): Promise<ReadyInfo> {
    const token = await ensureToken(paths)
    await writeAgentConfig(paths, { token, refreshSeconds: cfg.refreshSeconds })
    const binary = cfg.agentPath ?? defaultAgentPath()
    agent = new AgentProcess(binary, ['--config', paths.configPath, '--print-ready', ...(cfg.agentArgs ?? [])], {
      restartDelayMs: cfg.restartDelayMs,
      restartMaxDelayMs: cfg.restartMaxDelayMs,
      maxConsecutiveCrashes: cfg.maxConsecutiveCrashes,
      onLog,
    })
    agent.on('exit-restart', (delay, crashes) => {
      logger.warn(`dsh-plugin-adapter: agent exited unexpectedly; restarting in ${delay}ms (attempt ${crashes})`)
    })
    agent.on('circuit-tripped', (crashes) => {
      logger.error(`dsh-plugin-adapter: agent crashed ${crashes} times consecutively; giving up`)
    })
    agent.on('state', (state) => {
      if (state === 'ready') logger.info('dsh-plugin-adapter: agent ready')
    })
    const info = await agent.start()
    readyResolve(info)
    await refreshModels(info, token, { waitReady: true })
    scheduleRefresh(info, token)
    return info
  }

  void startOnce().catch((err) => {
    logger.error(`dsh-plugin-adapter: failed to start agent: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Register disposer on the plugin fiber so reload/unload/shutdown reaps the
  // child process (plan.md Phase 1 acceptance: no orphans).
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      void teardown()
    })
  }

  async function teardown(): Promise<void> {
    disposed = true
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (agent) {
      await agent.dispose().catch(() => {})
      agent = null
    }
  }

  return { ready }
}

/**
 * Locate the agent binary (sidecar mode, legacy — the published package does
 * not bundle it): explicit config wins; then a sibling `legacy/agent` dev
 * build; then a bare name on PATH.
 */
export function defaultAgentPath(): string {
  // 0.4.0: the Go tree is still named after the old project (rename deferred
  // to the legacy/ cleanup), so both binary names are probed. The new name
  // wins when both exist.
  const primary = 'dsh-plugin-adapter-agent'
  const names = [primary, 'opencode2dsh-agent']
  const here = __dirnameSafe()
  for (const bin of names) {
    const exe = process.platform === 'win32' ? `${bin}.exe` : bin
    for (const sibling of [
      join(here, '..', '..', '..', 'legacy', 'agent', exe),
      join(here, '..', '..', 'legacy', 'agent', exe),
    ]) {
      if (existsSync(sibling)) return sibling
    }
  }
  return process.platform === 'win32' ? `${primary}.exe` : primary
}

import { fileURLToPath } from 'node:url'

function __dirnameSafe(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return '.'
  }
}

export { AgentProcess } from './agent-process.js'
export { configPaths, ensureToken, resolveConfig, writeAgentConfig, type DshPluginAdapterConfig, type Opencode2dshConfig } from './config.js'
export { fetchHealth, fetchModels, registerProvider, providerBaseURL, toPiAiModels, type DshSeams } from './provider.js'
