/**
 * Zen-lane transport hardening (adapter/transport.ts).
 *
 * The ambient proxy dispatcher reuses CONNECT tunnels that Clash/v2rayN
 * silently close; the next request then dies with UND_ERR_SOCKET /
 * ECONNRESET instead of opening a fresh tunnel. The Zen lane gets its own
 * dispatcher (pipelining: 0) — and only the Zen host is rerouted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createZenTransport } from '../src/adapter/transport.ts'

test('transport: an unusable proxy URI leaves the ambient behaviour untouched', () => {
  assert.equal(createZenTransport({ proxyUrl: '' }), null)
  assert.equal(createZenTransport({ proxyUrl: 'not a url' }), null)
  assert.equal(createZenTransport({ proxyUrl: 'socks5://127.0.0.1:10808' }), null)
  assert.equal(createZenTransport(), null)
})

test('transport: the Zen host goes through the hardened proxy, other hosts keep the ambient fetch', async () => {
  const hits = { proxy: 0, origin: 0, ambient: 0 }
  // A stand-in for the proxy: an http origin makes undici's ProxyAgent use
  // the absolute-form request path, so no CONNECT tunnel is needed here.
  const proxy = createServer((_req, res) => {
    hits.proxy += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('via-proxy')
  })
  const origin = createServer((_req, res) => {
    hits.origin += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('direct')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as AddressInfo).port
  const originPort = (origin.address() as AddressInfo).port
  const zenHost = `127.0.0.1:${originPort}`

  const ambientFetch = (async () => {
    hits.ambient += 1
    return new Response('ambient', { status: 200 })
  }) as unknown as typeof globalThis.fetch

  const transport = createZenTransport({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    ambientFetch,
    host: zenHost,
  })
  assert.ok(transport !== null)
  const originalFetch = globalThis.fetch
  transport!.ensure()
  assert.notEqual(globalThis.fetch, originalFetch, 'the hardened fetch took the slot')

  const viaProxy = await globalThis.fetch(`http://${zenHost}/zen/v1/chat/completions`)
  assert.equal(await viaProxy.text(), 'via-proxy')
  assert.equal(hits.proxy, 1, 'the Zen host rode the hardened dispatcher')
  assert.equal(hits.ambient, 0, 'the ambient fetch never saw the Zen request')

  const viaAmbient = await globalThis.fetch('http://example.invalid/other')
  assert.equal(await viaAmbient.text(), 'ambient')
  assert.equal(hits.ambient, 1, 'other hosts keep the ambient path')
  assert.equal(hits.origin, 0, 'the Zen host never reached the origin directly')

  transport!.restore()
  assert.equal(globalThis.fetch, originalFetch, 'the slot is handed back')
  proxy.closeAllConnections()
  origin.closeAllConnections()
  proxy.close()
  origin.close()
})

test('transport: the hardened path falls back to the ambient fetch when it fails', async () => {
  // A proxy that is not listening: the hardened dispatcher fails, the lane
  // must still answer through the ambient path.
  const ambientFetch = (async () => new Response('ambient', { status: 200 })) as unknown as typeof globalThis.fetch
  const transport = createZenTransport({
    proxyUrl: 'http://127.0.0.1:1',
    ambientFetch,
    host: 'zen.invalid',
  })
  assert.ok(transport !== null)
  const originalFetch = globalThis.fetch
  transport!.ensure()
  const res = await globalThis.fetch('http://zen.invalid/zen/v1/chat/completions')
  assert.equal(await res.text(), 'ambient')
  transport!.restore()
  assert.equal(globalThis.fetch, originalFetch)
})

test('transport: a streamed body survives the hardened path (chunk by chunk)', async () => {
  // The Zen lane is a SSE stream: the body must arrive incrementally, not
  // buffered to the end.
  const chunks = ['data: one\n\n', 'data: two\n\n', 'data: [DONE]\n\n']
  const proxy = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let i = 0
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(chunks[i]!)
      i += 1
    }, 20)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as AddressInfo).port

  const transport = createZenTransport({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    ambientFetch: (async () => new Response('ambient', { status: 200 })) as unknown as typeof globalThis.fetch,
    host: 'zen.invalid',
  })
  assert.ok(transport !== null)
  const originalFetch = globalThis.fetch
  transport!.ensure()
  const res = await globalThis.fetch('http://zen.invalid/zen/v1/chat/completions')
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  assert.equal(text, chunks.join(''))
  transport!.restore()
  proxy.closeAllConnections()
  proxy.close()
  assert.equal(globalThis.fetch, originalFetch)
})
