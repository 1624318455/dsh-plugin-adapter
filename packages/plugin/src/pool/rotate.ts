/**
 * Adapter-layer rotate-retry delegate (docs/ip-pool.md §3.4 / §8.1, IP-7).
 *
 * The dispatcher layer only MARKS a degraded exit; the host's own retry loop
 * then re-enters the adapter, which re-picks through the pool — correct, but
 * every attempt burns one of the host's five retries on the same visible
 * error string ("Connection error." streaks in the user's chat). This module
 * lets the ADAPTER itself retry inside one user-visible request: when a
 * stream fails before any content landed, the adapter asks this delegate
 * whether the failure is exit-shaped (transport / 429 / 401/403) and the pool
 * has another candidate — then transparently restarts the pi-ai stream, which
 * re-picks a fresh exit through the same ALS context.
 *
 * The delegate is set by the runtime assembly (ip-pool.ts) and cleared on
 * dispose, so a disabled pool keeps the adapter's behavior unchanged.
 */

import type { ExitPool } from './pool.ts'

export type RotateFailure = 'transport' | 'limited' | 'refused'

export interface RotateDelegate {
  /**
   * Record the failure against the failed exit (passive-signal parity) and
   * decide whether another rotate attempt is worth it.
   * @param failure - what the stream died of (before any content landed).
   * @param model - the in-flight model (ban-level bookkeeping).
   * @param session - the sticky-session key (broken on rotate).
   * @param attempt - 1-based rotate attempt about to run.
   * @returns true to re-pick and restart the stream; false to surface the error.
   */
  decide(failure: RotateFailure, model: string, session: string, attempt: number): boolean
}

let delegate: RotateDelegate | null = null

/** Install the runtime's rotate delegate (startIpPool). */
export function setRotateDelegate(next: RotateDelegate | null): void {
  delegate = next
}

/** True when a runtime delegate is installed (adapter fast-path). */
export function hasRotateDelegate(): boolean {
  return delegate !== null
}

/** Ask the installed delegate; false when no pool is running. */
export function shouldRotate(failure: RotateFailure, model: string, session: string, attempt: number): boolean {
  return delegate?.decide(failure, model, session, attempt) ?? false
}

/** Map a pi-ai error message to the failure taxonomy (adapter-side parse). */
export function classifyStreamFailure(errorMessage: string): RotateFailure | null {
  const text = errorMessage.toLowerCase()
  if (/\b429\b|rate.?limit|freeusagelimit/.test(text)) return 'limited'
  if (/\b(?:401|403)\b/.test(text)) return 'refused'
  if (/\b(?:network|connection|socket|fetch|terminated|premature close)\b|\beconn[a-z]+\b|timeout|timed out/.test(text)) return 'transport'
  return null
}

/**
 * Build the runtime delegate over the live pool (ip-pool.ts assembly).
 * Passive bookkeeping mirrors the dispatcher observer: the stream that died
 * before content already recorded its verdict through the routing layer when
 * it could see it — the sentinel covers the mute-connection case — so this
 * delegate only breaks stickiness and checks whether a usable exit remains.
 */
export function createRotateDelegate(pool: ExitPool, options: { maxAttempts?: number } = {}): RotateDelegate {
  const maxAttempts = options.maxAttempts ?? 3
  return {
    decide(failure, model, session, attempt) {
      if (attempt > maxAttempts) return false
      // Anything usable for this model left? (pick filters cooldowns, bans,
      // dead.) Nothing usable -> let the error surface honestly.
      const usable = pool.list().some((entry) => pool.isUsable(entry.id, model))
      if (!usable) return false
      // Break the sticky binding so the restarted stream picks a different
      // exit instead of landing on the one that just failed.
      pool.rerouteSession(session)
      return true
    },
  }
}
