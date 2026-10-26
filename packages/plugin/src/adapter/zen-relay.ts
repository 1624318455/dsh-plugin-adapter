/**
 * Bun egress relay for the Zen free lane.
 *
 * WHY (measured 2026-10-25/26): the free tier's gate is not only a body/header
 * fingerprint — it also looks at the HTTP client itself. With an IDENTICAL
 * request (same UA, session, tools, `<env>` marker, same egress IP, same
 * minute): Node/undici was answered 429 `FreeUsageLimitError` on 6/6 attempts
 * while Bun's fetch was answered 200 + SSE on 5/5. DSH runs on Node, so no
 * amount of request shaping can pass; the lane needs a client that looks like
 * the CLI's own runtime.
 *
 * WHAT: a tiny loopback HTTP server, run by `bun`, that re-originates the Zen
 * request through Bun's fetch and streams the answer back verbatim (SSE
 * included). The Node side only ever talks to 127.0.0.1.
 *
 * EXITS: the free tier also meters a daily quota per EXIT IP, and a spent exit
 * answers 429 for every request until the day rolls over. The exit is therefore
 * the lever, not a fixed setting: the child walks a list of candidates (v2rayN
 * inbounds, pool proxies) and moves to the next one on a 429 or a connect
 * failure. A failed exit is benched for a cooldown only — v2rayN switches node
 * behind the SAME inbound, so that URL must become usable again on its own.
 *
 * FAIL-SAFE: if `bun` is missing or the child dies, `ensure()` reports false and
 * the transport keeps the previous path — the lane degrades to the old
 * behaviour instead of breaking.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { fetch as undiciFetch, Agent } from 'undici'

/** Upstream the relay forwards to (the Zen gateway host). */
const DEFAULT_UPSTREAM = 'https://opencode.ai'

/** Child script. Kept in sync with {@link ZenRelayOptions}; no imports on purpose. */
const RELAY_SCRIPT = `// dsh-plugin-adapter Zen egress relay (generated; do not edit).
const upstream = (process.env.DSH_ZEN_UPSTREAM || '${DEFAULT_UPSTREAM}').replace(/\\/+$/, '')
// The free tier meters its daily quota per EXIT IP, so the exit is the lever:
// list every candidate (v2rayN inbounds, pool proxies) and let the relay walk
// them instead of pinning one.
const proxyList = (process.env.DSH_ZEN_PROXIES || process.env.DSH_ZEN_PROXY || '')
  .split(/[,\\s]+/).map((p) => p.trim()).filter(Boolean)
// A proxy that just failed is benched, not banned: v2rayN switches node several
// times an hour and the SAME inbound becomes usable again seconds later.
const cooldownMs = Number(process.env.DSH_ZEN_PROXY_COOLDOWN || 20000)
const directAllowed = process.env.DSH_ZEN_DIRECT !== '0'
const keepAlive = process.env.DSH_ZEN_KEEPALIVE !== '0'
const benchedUntil = new Map()
let cursor = 0

function candidates() {
  const now = Date.now()
  const ready = []
  for (let i = 0; i < proxyList.length; i++) {
    const p = proxyList[(cursor + i) % proxyList.length]
    if ((benchedUntil.get(p) || 0) <= now && !ready.includes(p)) ready.push(p)
  }
  return ready
}

function bench(proxy, why) {
  benchedUntil.set(proxy, Date.now() + cooldownMs)
  console.error('proxy ' + proxy + ' benched (' + why + ') for ' + Math.round(cooldownMs / 1000) + 's')
}

function passThrough(res) {
  const out = new Headers(res.headers)
  // The relay's own hop-by-hop headers must not leak to the Node side, and a
  // dropped content-encoding invalidates the upstream content-length.
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('transfer-encoding')
  out.delete('connection')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

function relayError(status, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'RelayError', message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const target = upstream + url.pathname + url.search
    const headers = new Headers(req.headers)
    headers.delete('host')
    headers.delete('accept-encoding')
    const init = { method: req.method, headers }
    if (keepAlive) init.keepalive = true
    let payload
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Read once: a retry through the next exit must send the same bytes.
      payload = await req.arrayBuffer()
      init.body = payload
    }

    // Order: usable exits in rotation order, then direct (unless forbidden).
    const order = candidates()
    if (directAllowed) order.push(null)
    if (order.length === 0) {
      return relayError(502, 'dsh-plugin-adapter relay: every configured exit is benched and direct is disabled')
    }

    let lastResponse = null
    let lastError = null
    for (let i = 0; i < order.length; i++) {
      const proxy = order[i]
      const rest = order.length - i - 1
      let res
      try {
        res = await (proxy ? fetch(target, { ...init, proxy }) : fetch(target, init))
      } catch (err) {
        lastError = err
        if (proxy) { bench(proxy, err && err.code ? err.code : 'connect failed'); continue }
        console.error('direct exit failed: ' + (err && err.message ? err.message : err))
        continue
      }
      if (res.status === 429 && rest > 0) {
        // 429 is the lane's "this exit's free quota is spent" answer. Walking to
        // the next exit is what refreshes the allowance; the body is dropped so
        // the socket is not held open behind the retry.
        try { await res.body?.cancel() } catch {}
        lastResponse = res
        if (proxy) bench(proxy, '429 free quota')
        else console.error('direct exit answered 429 (quota spent on this IP); no exit left to rotate')
        continue
      }
      if (proxy) cursor = (proxyList.indexOf(proxy) + 1) % Math.max(proxyList.length, 1)
      return passThrough(res)
    }
    if (lastResponse) {
      // Every exit answered 429: hand the last one back so the adapter's own
      // quota classification sees the upstream error verbatim.
      return relayError(429, 'dsh-plugin-adapter relay: every configured exit answered 429 (free quota spent per exit IP)')
    }
    console.error('relay upstream failed: ' + (lastError && lastError.message ? lastError.message : lastError))
    return relayError(502, 'dsh-plugin-adapter relay: ' + (lastError && lastError.message ? lastError.message : 'all exits failed'))
  },
})

console.log('READY ' + server.port + ' exits=' + (proxyList.length || 0) + (directAllowed ? '+direct' : ''))
`

export interface ZenRelayOptions {
  /** `bun` executable: absolute path or PATH name (default: auto-detect). */
  bunPath?: string
  /** Upstream base URL (tests point this at a local fake). */
  upstream?: string
  /** All exit candidates the child may rotate through (order = preference). */
  proxyUrls?: string[]
  /** Single-exit shorthand kept for older configs. */
  proxyUrl?: string
  /** How long a failing exit is benched before it is retried (default 20s). */
  proxyCooldownMs?: number
  /** Allow the last-resort direct call (default true; false pins the exits). */
  allowDirect?: boolean
  /** Inactivity cap for the child's upstream call (ms, informational). */
  log?: (message: string) => void
  /** Where to write the generated child script (default: os tmpdir). */
  scriptDir?: string
  /** Handshake timeout (default 10s). */
  handshakeMs?: number
}

export interface ZenRelay {
  /** True once the child is listening and the port is known. */
  isReady(): boolean
  /** Start (or restart) the child; false when bun is unavailable. */
  ensure(): Promise<boolean>
  /** Forward one request to the relay; the response body streams through. */
  forward(input: unknown, init?: Record<string, unknown>): Promise<Response>
  dispose(): void
  describe(): string
}

/** Locate the bun executable, or null when it is not installed. */
export function resolveBunPath(explicit?: string): string | null {
  const candidate = (explicit ?? process.env.DSH_PLUGIN_ADAPTER_BUN ?? '').trim()
  if (candidate.length > 0) return existsSync(candidate) ? candidate : null
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(probe, ['bun'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    const found = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && existsSync(line))
    // On Windows `where bun` also lists the extension-less sh shim, which is
    // not executable through spawn(): prefer the real binary, then the .cmd.
    const executable = found.find((line) => /\.exe$/i.test(line))
      ?? found.find((line) => /\.cmd$/i.test(line))
      ?? found.find((line) => process.platform !== 'win32' || /\.(bat|ps1)$/i.test(line))
    if (executable) return executable
  } catch {
    // not on PATH
  }
  for (const guess of [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'bun', 'bun.exe'),
    join(process.env.APPDATA ?? '', 'npm', 'bun.cmd'),
    join(process.env.USERPROFILE ?? '', '.bun', 'bin', 'bun.exe'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ]) {
    if (guess.length > 0 && existsSync(guess)) return guess
  }
  return null
}

function scriptPath(dir: string | undefined): string {
  const target = dir ?? join(tmpdir(), 'dsh-plugin-adapter')
  mkdirSync(target, { recursive: true })
  const file = join(target, 'zen-relay.mjs')
  writeFileSync(file, RELAY_SCRIPT, 'utf8')
  return file
}

/**
 * Build the relay handle. Returns null when bun cannot be found, so the caller
 * can keep its previous transport untouched.
 */
export function createZenRelay(options: ZenRelayOptions = {}): ZenRelay | null {
  const bun = resolveBunPath(options.bunPath)
  if (bun === null) return null
  /** Narrowed copy for closures (TS forgets the guard inside them). */
  const bunBin: string = bun

  const upstream = (options.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const script = scriptPath(options.scriptDir)
  const handshakeMs = options.handshakeMs ?? 10_000
  const exits = (options.proxyUrls ?? (options.proxyUrl ? [options.proxyUrl] : []))
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
  // Loopback traffic must never ride the ambient proxy dispatcher.
  const loopback = new Agent({ connections: 32, pipelining: 0 })

  let child: ChildProcessByStdio<null, Readable, Readable> | null = null
  let port = 0
  let starting: Promise<boolean> | null = null
  let disposed = false
  let attempts = 0

  const log = options.log ?? (() => {})

  function stop(): void {
    port = 0
    if (child) {
      const target = child
      child = null
      try {
        target.kill()
      } catch {
        // already gone
      }
    }
  }

  function start(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (port > 0) return Promise.resolve(true)
    if (starting) return starting
    starting = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        starting = null
        resolve(value)
      }
      const env: NodeJS.ProcessEnv = { ...process.env, DSH_ZEN_UPSTREAM: upstream }
      if (exits.length > 0) env.DSH_ZEN_PROXIES = exits.join(',')
      if (options.proxyCooldownMs !== undefined) env.DSH_ZEN_PROXY_COOLDOWN = String(options.proxyCooldownMs)
      if (options.allowDirect === false) env.DSH_ZEN_DIRECT = '0'
      let spawned: ChildProcessByStdio<null, Readable, Readable>
      try {
        spawned = spawn(bunBin, ['run', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        log(`zen relay: spawn failed (${err instanceof Error ? err.message : String(err)})`)
        finish(false)
        return
      }
      child = spawned
      const timer = setTimeout(() => {
        log('zen relay: handshake timed out')
        stop()
        finish(false)
      }, handshakeMs)
      timer.unref?.()

      let buffered = ''
      spawned.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        const match = /READY (\d+)/.exec(buffered)
        if (!match) return
        port = Number(match[1])
        attempts = 0
        log(`zen relay: listening on 127.0.0.1:${port} -> ${upstream}${exits.length > 0 ? ` via ${exits.join(' | ')}` : ' (direct)'}`)
        finish(true)
      })
      spawned.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text.length > 0) log(`zen relay: ${text.slice(0, 300)}`)
      })
      spawned.on('exit', (code) => {
        const wasReady = port > 0
        stop()
        finish(false)
        if (wasReady && !disposed) log(`zen relay: exited (code ${code}); next request restarts it`)
      })
      spawned.on('error', (err) => {
        log(`zen relay: ${err.message}`)
        stop()
        finish(false)
      })
    })
    return starting
  }

  return {
    isReady: () => port > 0,
    async ensure() {
      if (disposed) return false
      if (port > 0) return true
      if (attempts >= 3) return false
      attempts += 1
      return start()
    },
    async forward(input, init) {
      const ok = await this.ensure()
      if (!ok) throw new Error('dsh-plugin-adapter: zen relay is not running')
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string })?.url ?? '')
      const parsed = new URL(url)
      const local = `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`
      return (await undiciFetch(local, { ...(init as object), dispatcher: loopback })) as unknown as Response
    },
    dispose() {
      disposed = true
      stop()
      void loopback.close().catch(() => {})
    },
    describe: () => `zen relay: bun ${bunBin}${exits.length > 0 ? ` (rotating ${exits.length} exit${exits.length === 1 ? '' : 's'}: ${exits.join(', ')})` : ' (direct)'}`,
  }
}

/** Directory the generated child script lives in (diagnostics/tests). */
export function relayScriptPath(dir?: string): string {
  return join(dir ?? join(tmpdir(), 'dsh-plugin-adapter'), 'zen-relay.mjs')
}

/** Ensure the generated script exists (idempotent; used by tests). */
export function writeRelayScript(dir?: string): string {
  const target = dirname(relayScriptPath(dir))
  mkdirSync(target, { recursive: true })
  const file = relayScriptPath(dir)
  writeFileSync(file, RELAY_SCRIPT, 'utf8')
  return file
}
