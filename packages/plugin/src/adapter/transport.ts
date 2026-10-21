/**
 * Zen-lane transport hardening.
 *
 * WHY (live-observed 2026-10-21): the ambient dispatcher
 * (dsh-plugin-proxy's `EnvHttpProxyAgent`) keeps the proxy-side CONNECT
 * tunnel alive between requests. Clash/v2rayN silently close idle tunnels,
 * and the NEXT request on the dead tunnel dies with `UND_ERR_SOCKET`
 * (wrote 905 bytes, read 0) or `ECONNRESET` instead of opening a fresh
 * CONNECT. Measured through the default agent: 2 of 12 requests failed that
 * way; with `pipelining: 0` (fresh tunnel per request) the same probe
 * produced 0 socket errors.
 *
 * WHAT: the Zen lane gets its OWN dispatcher, so the fix does not depend on
 * the proxy plugin's build. The hardened dispatcher is only used for the
 * Zen host; every other request keeps the ambient path (the proxy plugin
 * still owns the global dispatcher for the rest of the process).
 *
 * MECHANICS: pi-ai talks to the upstream through the OpenAI SDK, which
 * calls `globalThis.fetch`. Node's built-in fetch REJECTS a dispatcher
 * instance that comes from another undici module copy
 * (`UND_ERR_INVALID_ARG`, measured), so the hardened path calls THIS
 * module's `undici.fetch` with `dispatcher` in the init — that is the same
 * trick the IP-pool installer uses (pool/installer.ts:124-129).
 *
 * FAIL-SAFE: the hardened path must never be the reason the lane dies. A
 * failure there falls back once to the ambient fetch, and a wrong proxy
 * URL therefore degrades to today's behaviour instead of breaking the
 * provider.
 */

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

import { ZEN_BASE_URL } from './catalog.ts'

export interface ZenTransportOptions {
  /** Proxy URI for the Zen lane (http/https). Empty = no hardening. */
  proxyUrl?: string
  /**
   * Force a fresh CONNECT tunnel per request (default true). Set false to
   * keep connection reuse but still route the Zen lane through the proxy.
   */
  noReuse?: boolean
  /** Host whose traffic is rerouted (defaults to the Zen base host). */
  host?: string
  /** Injected ambient fetch (tests). */
  ambientFetch?: typeof globalThis.fetch
}

export interface ZenTransport {
  /** Install the hardened fetch (idempotent; never fights a foreign owner). */
  ensure(): void
  /** Restore the ambient fetch. */
  restore(): void
  /** One-line description for the boot log. */
  describe(): string
  /** The dispatcher the Zen lane uses (diagnostics). */
  readonly dispatcher: Dispatcher | null
}

/** Accept only the proxy schemes undici's ProxyAgent can CONNECT through. */
function normalizeProxyUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/** The host part of the request URL we reroute (accepts "host:port"). */
function normalizeHost(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  const candidate = value === ''
    ? ZEN_BASE_URL
    : /^[a-z0-9+.-]+:\/\//i.test(value) ? value : `http://${value}`
  try {
    return new URL(candidate).host
  } catch {
    return new URL(ZEN_BASE_URL).host
  }
}

/** Extract the request URL from the shapes fetch accepts. */
function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    const maybe = input as { url?: unknown; href?: unknown }
    if (typeof maybe?.url === 'string') return new URL(maybe.url)
    if (typeof maybe?.href === 'string') return new URL(maybe.href)
  } catch {
    return null
  }
  return null
}

/**
 * Build the Zen-lane transport. Returns null when there is nothing to do
 * (no proxy URL, or an unsupported scheme) so the caller can keep the
 * ambient behaviour untouched.
 */
export function createZenTransport(options: ZenTransportOptions = {}): ZenTransport | null {
  const proxyUrl = normalizeProxyUrl(options.proxyUrl)
  if (proxyUrl === null) return null
  const noReuse = options.noReuse ?? true
  const host = normalizeHost(options.host)

  // Same shape as the IP-pool dispatcher (pool/dispatcher.ts:168-174): the
  // proxy agent's client factory pins pipelining to 0, so every request
  // opens a fresh CONNECT tunnel instead of inheriting a dead one.
  const dispatcher: Dispatcher = noReuse
    ? new ProxyAgent({
      uri: proxyUrl,
      clientFactory: (origin: URL | string, opts?: unknown) =>
        new Agent({ ...(opts as object), pipelining: 0 }),
    })
    : new ProxyAgent({ uri: proxyUrl })

  const ambient = options.ambientFetch ?? globalThis.fetch
  /** What the global slot held when this transport was built. */
  const slot = globalThis.fetch
  let installed = false

  const hardened: typeof globalThis.fetch = async (input: unknown, init?: unknown) => {
    const url = requestUrl(input)
    if (url === null || url.host !== host) {
      return (ambient as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
    }
    try {
      return await (undiciFetch as unknown as (i: unknown, n?: unknown) => Promise<Response>)(
        input,
        { ...(init as object), dispatcher },
      )
    } catch (err) {
      // Never let the hardened path be the reason the lane dies: retry once
      // through the ambient dispatcher (it may route through another proxy
      // or go direct).
      try {
        return await (ambient as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
      } catch {
        throw err
      }
    }
  }

  return {
    dispatcher,
    describe: () => `zen transport: ${proxyUrl} (${noReuse ? 'fresh tunnel per request' : 'connection reuse'}), host=${host}`,
    ensure() {
      const current = globalThis.fetch
      if (current === (hardened as unknown as typeof globalThis.fetch)) {
        installed = true
        return
      }
      // Only take the slot when it still holds the fetch we captured at
      // build time: another plugin that swapped the global fetch (the IP
      // pool does) keeps ownership — clobbering it would break its routing.
      if (installed) return
      if (current !== slot) return
      ;(globalThis as { fetch: unknown }).fetch = hardened
      installed = true
    },
    restore() {
      if (!installed) return
      if (globalThis.fetch === (hardened as unknown as typeof globalThis.fetch)) {
        ;(globalThis as { fetch: unknown }).fetch = slot
      }
      installed = false
      void dispatcher.close().catch(() => {})
    },
  }
}
