/**
 * Full-path live e2e (user's requested test): send a real message through
 * ZenAdapter -> pi-ai -> fetch -> installed router -> real 7897 exit ->
 * Zen anonymous lane, and check the agent's reply. Asserts BOTH the reply
 * AND that the dispatch actually rode the proxy exit (router hits > 0).
 */
import { ExitPool } from '../src/pool/pool.ts'
import { setRotateDelegate, createRotateDelegate } from '../src/pool/rotate.ts'
import { PoolRoutingDispatcher } from '../src/pool/dispatcher.ts'
import { RoutingInstaller } from '../src/pool/installer.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import * as undici from 'undici'

const t0 = Date.now()
const log = (tag: string): void => console.log(`[${Date.now() - t0}ms] ${tag}`)

const pool = new ExitPool()
pool.add({
  id: 'http://127.0.0.1:7897', protocol: 'http', source: 'manual', pinned: false,
  exitIP: '9.9.9.9', exitLocation: 'manual', latencyMs: 100, quality: 'S', addedAt: 0,
})
pool.markOk('http://127.0.0.1:7897')
setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 2 }))

// counted router: proves the model traffic actually rides the 7897 exit.
// The installer builds its own PoolRoutingDispatcher over this seam; we
// wrap ProxyAgent to count which exit every dispatch targets.
const realAgents = new Map<string, { dispatch(o: unknown, h: unknown): boolean; close(): Promise<void>; destroy(): Promise<void> }>()
let routerDispatches = 0
function makeCountingProxyAgent(uri: string) {
  const real = realAgents.get(uri) ?? new undici.ProxyAgent({ uri })
  realAgents.set(uri, real)
  return {
    dispatch: (opts: unknown, handler: unknown): boolean => {
      routerDispatches += 1
      log(`[router] dispatch #${routerDispatches} via ${uri}`)
      return real.dispatch(opts as never, handler as never)
    },
    close: () => real.close(),
    destroy: () => real.destroy(),
  }
}
const countingSeam = {
  ...undici,
  ProxyAgent: class {
    constructor(options: { uri: string }) {
      return makeCountingProxyAgent(options.uri) as never
    }
  },
}
const installer = new RoutingInstaller({
  pool,
  undici: countingSeam as never,
})
installer.install()
log(`installed; global fetch is npm fetch: ${globalThis.fetch === (undici as { fetch?: unknown }).fetch}`)

const catalog = {
  list: () => ['big-pickle'],
  decision: () => ({ allowed: true, source: 'repro' }),
  reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
} as never
const adapter = new ZenAdapter(catalog, { firstEventMs: 20_000, bodyIdleMs: 30_000 })

log('sending message to the agent')
const stream = await adapter.stream({
  model: 'big-pickle',
  provider: 'opencode2dsh',
  messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话回答：你收到这条消息了吗？' }] }],
  temperature: 0,
  maxTokens: 512,
} as never)

let text = ''
let finish: { kind: string; failure?: { message: string } } | null = null
for (;;) {
  const next = await Promise.race([
    stream.next(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ITERATION 60s TIMEOUT')), 60_000)),
  ])
  if (next.done) { log('stream done'); break }
  const chunk = next.value as { type: string; text?: string; reason?: { kind: string; failure?: { message: string } } }
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') { finish = { kind: chunk.reason.kind, failure: chunk.reason.failure ? { message: chunk.reason.failure.message } : undefined }; break }
}

log(`passive: ${JSON.stringify(pool.passiveStats('http://127.0.0.1:7897'))}`)
log(`router dispatches (proxy-ridden): ${routerDispatches}`)
if (finish?.kind === 'error') {
  log(`FINISH ERROR: ${finish.failure?.message.slice(0, 300)}`)
} else if (text.length > 0) {
  log(`AGENT REPLY: ${text.slice(0, 400)}`)
}
const pass = text.length > 0 && routerDispatches > 0
log(pass ? 'E2E PASS: agent replied AND traffic rode the proxy exit' : 'E2E FAIL')
installer.disable()
process.exit(pass ? 0 : 1)
