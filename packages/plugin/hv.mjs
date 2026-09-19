import { ZenAdapter } from './src/adapter/zen-adapter.ts'
const catalog = { list: () => ['muse-spark-1.3-contributor-free'], decision: () => ({ allowed: true, source: 'h', known: true }), reasoningCapability: () => undefined }
const adapter = new ZenAdapter(catalog)
const call = await adapter.prepareCall('opencode2dsh', 'muse-spark-1.3-contributor-free')
let text = '', finish = ''
const t0 = Date.now()
for await (const chunk of call.stream({ provider: 'opencode2dsh', model: 'muse-spark-1.3-contributor-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') { finish = JSON.stringify(chunk.reason).slice(0, 100); break }
  if (Date.now() - t0 > 100000) { finish = 'TIMEOUT'; break }
}
console.log('finish=' + finish)
console.log('text=' + text.slice(0, 80))
