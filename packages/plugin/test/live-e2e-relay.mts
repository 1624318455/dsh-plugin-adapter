/**
 * Live end-to-end for the free-tier fix (2026-10-26).
 *
 * Sends a real message through the actual adapter stack — ZenAdapter ->
 * pi-ai -> global fetch -> zen transport -> Bun relay -> opencode.ai — and
 * asserts a non-empty answer. This is the exact path DSH uses, so it proves
 * the fingerprint + relay combination works, not just the wire shape.
 *
 * Usage: node --experimental-strip-types test/live-e2e-relay.mts
 */
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { createZenRelay } from '../src/adapter/zen-relay.ts'
import { createZenTransport } from '../src/adapter/transport.ts'

const MODEL = process.env.ZEN_MODEL ?? 'deepseek-v4.1-flash-free'
const PROXY = process.env.ZEN_PROXY ?? ''

const log = (message: string): void => console.log(`[live] ${message}`)

const relay = createZenRelay({ proxyUrl: PROXY, log })
if (relay === null) {
  console.error('[live] bun not found; the free lane cannot be reached from Node')
  process.exit(2)
}
const transport = createZenTransport({ proxyUrl: PROXY, relay })
transport?.ensure()
log(`transport: ${transport?.describe() ?? 'none'}`)

const catalog = {
  list: () => [MODEL],
  decision: () => ({ allowed: true, source: 'live', known: true }),
  reasoningCapability: () => ({ reasoning: false, effortValues: [] }),
  modelLimits: () => undefined,
}

const adapter = new ZenAdapter(catalog as never, { firstEventMs: 60_000, bodyIdleMs: 120_000 })

let text = ''
let finish: { kind: string; failure?: { message: string } } | null = null
try {
  const stream = await adapter.stream({
    provider: 'zen-free',
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话回答：你收到这条消息了吗？' }] }],
    system: 'You are a helpful assistant.',
    temperature: 0,
    maxTokens: 256,
  } as never)
  for (;;) {
    const next = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('iteration timeout 90s')), 90_000)),
    ])
    if (next.done) break
    const chunk = next.value as { type: string; text?: string; reason?: { kind: string; failure?: { message: string } } }
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    if (chunk.type === 'finish') {
      finish = { kind: chunk.reason!.kind, failure: chunk.reason!.failure ? { message: chunk.reason!.failure.message } : undefined }
      break
    }
  }
} catch (err) {
  log(`threw: ${err instanceof Error ? err.message : String(err)}`)
}

log(`finish: ${JSON.stringify(finish)}`)
log(`reply: ${text.slice(0, 300)}`)
relay.dispose()
transport?.restore()
const pass = text.trim().length > 0 && finish?.kind !== 'error'
log(pass ? `PASS — ${MODEL} answered through the Bun relay` : 'FAIL')
process.exit(pass ? 0 : 1)
