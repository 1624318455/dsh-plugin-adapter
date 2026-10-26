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

/**
 * The free tier meters a DAILY quota per exit IP: a spent exit answers 429 for
 * every request until the day rolls over. v2rayN refreshes the allowance by
 * switching node behind the same inbound, so the relay must (a) walk to the
 * next exit when one answers 429 and (b) retry a failed exit later instead of
 * writing it off for the life of the process.
 */
test('the relay walks past an exit that answers 429', { skip: bun === null ? 'bun is not installed' : false }, async () => {
  const upstreamHits: string[] = []
  const upstream = createServer((req, res) => {
    upstreamHits.push('direct')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ok\n\n')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as { port: number }).port

  // A plain-HTTP "proxy" that always reports the exit's quota as spent.
  const proxyHits: string[] = []
  const proxy = createServer((req, res) => {
    proxyHits.push(req.url ?? '')
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end('{"type":"error","error":{"type":"FreeUsageLimitError"}}')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  const proxyPort = (proxy.address() as { port: number }).port

  const relay = createZenRelay({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxyUrls: [`http://127.0.0.1:${proxyPort}`],
    scriptDir: join(tmpdir(), 'dsh-plugin-adapter-relay-test-rotate'),
  })
  assert.notEqual(relay, null)
  assert.ok(await relay!.ensure())

  const res = await relay!.forward('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(res.status, 200, 'the spent exit is skipped instead of failing the turn')
  assert.match(await res.text(), /data: ok/)
  assert.equal(proxyHits.length, 1, 'the exit was tried first')
  assert.equal(upstreamHits.length, 1, 'the direct exit served the retry')

  relay!.dispose()
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

test('a failing exit is benched, not banned, and is retried after the cooldown', { skip: bun === null ? 'bun is not installed' : false }, async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ok\n\n')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as { port: number }).port

  // Accepts the connection and drops it: what a switched-away v2rayN node does.
  let connects = 0
  const deadProxy = createServer(() => {})
  deadProxy.on('connection', (socket) => {
    connects += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => deadProxy.listen(0, '127.0.0.1', () => resolve()))
  const deadPort = (deadProxy.address() as { port: number }).port

  const relay = createZenRelay({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxyUrls: [`http://127.0.0.1:${deadPort}`],
    proxyCooldownMs: 300,
    scriptDir: join(tmpdir(), 'dsh-plugin-adapter-relay-test-cooldown'),
  })
  assert.notEqual(relay, null)
  assert.ok(await relay!.ensure())

  const first = await relay!.forward('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(first.status, 200, 'the turn still completes through the direct exit')
  await first.text()
  assert.equal(connects, 1, 'the configured exit was tried')

  const second = await relay!.forward('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', body: '{}' })
  await second.text()
  assert.equal(connects, 1, 'a benched exit is not paid for on the very next turn')

  await new Promise((resolve) => setTimeout(resolve, 500))
  const third = await relay!.forward('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', body: '{}' })
  await third.text()
  assert.equal(connects, 2, 'once the cooldown passes the exit is retried (the node may be back)')

  relay!.dispose()
  await new Promise<void>((resolve) => deadProxy.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})
