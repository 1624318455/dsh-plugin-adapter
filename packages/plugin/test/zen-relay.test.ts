import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createZenRelay, resolveBunPath } from '../src/adapter/zen-relay.ts'

/**
 * The relay is the only reason the free lane answers at all from Node
 * (measured 2026-10-26), so its contract is pinned: the path/query survive,
 * request headers reach upstream, the upstream status/body come back verbatim
 * and the stream is not buffered into a single chunk.
 */
const bun = resolveBunPath()

test('zen relay forwards path, headers and streams the answer back', { skip: bun === null ? 'bun is not installed' : false }, async () => {
  const seen: Array<{ url?: string; ua?: string; body: string }> = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] as string, body })
      if (req.url?.includes('fail')) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"type":"error","error":{"type":"FreeUsageLimitError"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: one\n\n')
      res.end('data: two\n\n')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const port = (upstream.address() as { port: number }).port

  const relay = createZenRelay({
    upstream: `http://127.0.0.1:${port}`,
    scriptDir: join(tmpdir(), 'dsh-plugin-adapter-relay-test'),
  })
  assert.notEqual(relay, null)
  const started = await relay!.ensure()
  assert.ok(started, 'the child starts and reports its port')

  const ok = await relay!.forward('https://opencode.ai/zen/v1/chat/completions?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'opencode/latest/2.1.4/cli', 'x-opencode-session': 'ses_1' },
    body: JSON.stringify({ model: 'm' }),
  })
  assert.equal(ok.status, 200)
  const text = await ok.text()
  assert.match(text, /data: one/)
  assert.match(text, /data: two/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, '/zen/v1/chat/completions?x=1', 'path and query survive')
  assert.equal(seen[0]!.ua, 'opencode/latest/2.1.4/cli', 'the CLIENT user agent reaches upstream')
  assert.equal(seen[0]!.body, '{"model":"m"}', 'the body reaches upstream unmodified')

  const failure = await relay!.forward('https://opencode.ai/zen/v1/chat/completions/fail', { method: 'POST', body: '{}' })
  assert.equal(failure.status, 429, 'upstream status is passed through, not retried')
  assert.match(await failure.text(), /FreeUsageLimitError/)

  relay!.dispose()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

test('createZenRelay returns null when bun cannot be found', () => {
  assert.equal(createZenRelay({ bunPath: join(tmpdir(), 'definitely-no-bun-here') }), null)
})
