import { createHash, randomBytes } from 'node:crypto'

import { FINGERPRINT_USER_AGENT } from './fingerprint.ts'

/**
 * Request identity for the Zen free lane.
 *
 * The upstream reads THREE things from the identity headers (measured live
 * 2026-10-26, see adapter/fingerprint.ts): a v2 `opencode/.../cli` user agent,
 * a canonical `ses_<12 hex><14 base62>` session, and the correlation headers a
 * real CLI sends. The session's hex prefix is decoded as a timestamp: random
 * hex (what this module used to derive by hashing the conversation) is refused
 * with 429, so ids are minted from the clock and memoised per conversation.
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex + 14 Base62.
 * The hex prefix is `~(timeMs * 0x1000 + counter)` masked to 48 bits — the CLI
 * decodes it back to a timestamp and refuses ids whose time is in the future or
 * older than the free-tier window (live probes 2026-10-25: -60d answers 200,
 * -100d and +30d answer 429).
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_PREFIX_MASK = (1n << 48n) - 1n

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/** `~(timeMs * 0x1000 + counter)` low 48 bits, 12 lowercase hex digits. */
function descendingTimeHex(timeMs: number, counterValue: number): string {
  return (~(BigInt(timeMs) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK).toString(16).padStart(12, '0')
}

let lastMintedAt = 0
let mintCounter = 0

/**
 * Mint one canonical session id for `now`. The counter keeps ids minted in the
 * same millisecond distinct (the CLI sends a small counter; probes show 0-16
 * pass and large values are refused, so it is reset per millisecond).
 */
export function mintSessionID(now: number = Date.now()): string {
  if (now !== lastMintedAt) {
    lastMintedAt = now
    mintCounter = 0
  }
  mintCounter += 1
  const random = base62Fixed(BigInt('0x' + randomBytes(10).toString('hex')), 14)
  return `ses_${descendingTimeHex(now, mintCounter)}${random}`
}

/**
 * Memoised session per conversation: a conversation must keep ONE stable id so
 * the upstream's prompt-cache affinity and per-session routing survive across
 * turns, while different conversations stay separated. Bounded so a long
 * lived host does not grow without limit.
 */
const sessionBySeed = new Map<string, string>()
const MAX_SESSIONS = 2000

export function sessionForSeed(seed: string, now: number = Date.now()): string {
  const key = seed.length > 0 ? seed : randomID('seed', 8)
  const existing = sessionBySeed.get(key)
  if (existing !== undefined) return existing
  const minted = mintSessionID(now)
  if (sessionBySeed.size >= MAX_SESSIONS) {
    const oldest = sessionBySeed.keys().next().value
    if (oldest !== undefined) sessionBySeed.delete(oldest)
  }
  sessionBySeed.set(key, minted)
  return minted
}

/** Test seam: forget every memoised conversation session. */
export function resetSessionMemo(): void {
  sessionBySeed.clear()
  lastMintedAt = 0
  mintCounter = 0
}

/**
 * A canonical id for a signal. An input that already carries the canonical
 * shape passes through unchanged (a pinned `gatewaySession`); anything else is
 * memoised into a freshly minted id keyed by that signal.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  return sessionForSeed(signal)
}

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: sessionForSeed(signal),
    request: randomID('req', 16),
    project: projectID(),
    parentSession: '',
  }
}

/** Stable 32-hex project id (the CLI sends a plain hex digest, not a prefix). */
function projectID(): string {
  return createHash('sha256').update('project\x00dsh-plugin-adapter').digest('hex').slice(0, 32)
}

/** CLI-identical user agent: the v2 channel/version/client shape. */
export function opencodeUserAgent(): string {
  return FINGERPRINT_USER_AGENT
}

/**
 * The full disguise header set sent with every upstream request (design.md 2.4;
 * gateway.go newUpstreamRequest:640-669, aligned to the v2 client 2026-10-26).
 * The session headers are what the gate reads; `x-opencode-request` is kept for
 * correlation only and never carries a `msg_` id.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'x-session-id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
