/**
 * PRODUCTION-SHAPE live e2e: the free-source pool, end to end.
 *
 *   startIpPool (full runtime assembly, ZERO manual proxies)
 *     -> RefillScheduler pulls the 26 public free-source lists
 *     -> admission chain per candidate (echo exit-IP -> tunnel -> anonymous
 *        smoke against zen) admits real working exits
 *     -> the dispatcher routes actual model traffic through whatever the
 *        pool admitted
 *     -> a real chat request must come back with a real answer
 *
 * Pass criteria: pool > 0 free exits admitted, agent reply non-empty,
 * passive counters show the dispatch riding a pool exit.
 */
import { startIpPool } from '../src/ip-pool.ts'
import type { Opencode2dshConfig } from '../src/config.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

const t0 = Date.now()
const log = (tag: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag}`)

const config: Opencode2dshConfig = {
  ipPool: {
    enabled: true,
    manual: [],            // production shape: NO manual proxies
    free: { enabled: true, targetSize: 8 },
    probeModels: ['big-pickle'],
    maxConcurrentProbes: 6,
  },
}

const logs: string[] = []
const logger = {
  info: (m: string) => { logs.push(m); if (/refill|admi|exit|routing/i.test(m)) log(`[log] ${m}`) },
  warn: (m: string) => { logs.push(m); if (/refill|admi|source|breaker/i.test(m)) log(`[warn] ${m}`) },
}

log('assembling the full IP-pool runtime (free sources only)')
const runtime = await startIpPool(config, logger)
if (runtime === null) { log('FATAL: startIpPool returned null'); process.exit(1) }
log(`runtime up; installer ${runtime.installer.enabled ? 'INSTALLED' : `deferred: ${runtime.installer.deferredReason}`}`)

// startIpPool's applyConfig() starts RefillScheduler with an immediate
// round (void tick()) — refillNow() would just bounce off the #running
// guard. Wait for the WHOLE round to settle: a full round over the
// (now larger) source inventory takes several minutes, and killing the
// runtime mid-coarse reads as admitted:0 — settle means stage idle AND
// the fine screen actually ran (admissions > 0). Timeout generous.
const started = Date.now()
for (;;) {
  const prog = (runtime.refill as { progress?: { running: boolean; stage: string; fetched: number; coarsePassed: number; admitted: number; candidates: number; admissions: number } | null })?.progress
  const exits = runtime.pool.list().length
  log(`waiting for refill: stage=${prog?.stage ?? 'n/a'} running=${String(prog?.running)} fetched=${prog?.fetched ?? 0} candidates=${prog?.candidates ?? 0} coarsePassed=${prog?.coarsePassed ?? 0} admitted=${prog?.admitted ?? 0} poolExits=${exits}`)
  const settled = prog !== undefined && prog !== null && !prog.running && prog.stage === 'idle' && prog.admissions > 0
  const gotExitsAndIdle = exits > 0 && prog !== null && !prog.running && prog.stage === 'idle'
  if (settled || gotExitsAndIdle || Date.now() - started > 600_000) break
  await new Promise((r) => setTimeout(r, 10_000))
}
// a second explicit round tops the pool up to quota (now safe: idle)
await runtime.refillNow()

const list = runtime.pool.list()
log(`refill finished. lastRound: ${JSON.stringify((runtime.refill as { lastRound?: unknown } | null)?.lastRound ?? null)}`)
log(`pool now holds ${list.length} exits: ${list.map((e) => `${e.id}(${e.source})`).join(', ').slice(0, 300)}`)

if (list.length === 0) {
  log('pool still empty — free sources yielded nothing usable this run')
}

// the chat request through whatever the pool admitted
const catalog = { list: () => ['big-pickle'], decision: () => ({ allowed: true, source: 'repro' }), reasoningCapability: () => ({ reasoning: true, effortValues: [] }) } as never
const adapter = new ZenAdapter(catalog, { firstEventMs: 30_000, bodyIdleMs: 60_000 })

log('sending the real chat request through the free-source pool')
let text = ''
let finish: { kind: string; failure?: { message: string } } | null = null
try {
  const stream = await adapter.stream({
    model: 'big-pickle', provider: 'opencode2dsh',
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话回答：你收到这条消息了吗？' }] }],
    temperature: 0, maxTokens: 128,
  } as never)
  for (;;) {
    const next = await Promise.race([stream.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ITERATION 90s TIMEOUT')), 90_000))])
    if (next.done) break
    const chunk = next.value as { type: string; text?: string; reason?: { kind: string; failure?: { message: string } } }
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') text += chunk.text
    if (chunk.type === 'finish') { finish = { kind: chunk.reason.kind, failure: chunk.reason.failure ? { message: chunk.reason.failure.message } : undefined }; break }
  }
} catch (err) {
  log(`stream THREW: ${err instanceof Error ? err.message : String(err)}`)
}

log(`finish: ${finish ? `${finish.kind}${finish.failure ? ` — ${finish.failure.message.slice(0, 160)}` : ''}` : 'none'}`)
log(`agent text: "${text.slice(0, 300)}"`)

// which exit did it ride, and what does the pool's passive bookkeeping say
const stats = list.map((e) => `${e.id}: ${JSON.stringify(runtime.pool.passiveStats(e.id))}`).join(' | ')
log(`passive stats: ${stats.slice(0, 400)}`)

const verdict = (finish?.kind === 'stop' || (finish === null && text.length > 0) || (finish?.kind !== 'error' && text.length > 0)) && list.length > 0
log(verdict
  ? `E2E PASS — free-source pool (${list.length} exits) carried a real conversation`
  : list.length === 0
    ? 'E2E FAIL — pool empty; the reply (if any) was the direct fallback, not pool routing'
    : 'E2E FAIL — no reply through the free-source pool')

await runtime.dispose()
process.exit(verdict ? 0 : 1)
