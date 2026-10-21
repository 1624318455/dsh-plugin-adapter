/**
 * Watchdog semantics (2026-10-21 re-measurement).
 *
 * The first-event gate is a TIME-TO-FIRST-TOKEN budget, not a liveness
 * probe: the Zen lane holds the response head back until the upstream emits
 * its first token (headers_at == first_byte_at to the millisecond), so a
 * slow first token used to be reported as a dead exit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BODY_IDLE_MS,
  DEFAULT_FIRST_EVENT_MS,
  DEFAULT_REASONING_FIRST_EVENT_MS,
  WATCHDOG_FIRST_MESSAGE,
  WATCHDOG_IDLE_MESSAGE,
  ZenAdapter,
} from '../src/adapter/zen-adapter.ts'
import { classifyStreamFailure } from '../src/pool/rotate.ts'
import { withKeepAlive } from './helpers/keepalive.ts'

/** A provider whose stream never yields a single event (total silence). */
function muteProvider(): unknown {
  return {
    streamSimple(): AsyncIterable<never> {
      return (async function* (): AsyncGenerator<never> {
        await new Promise(() => {}) // never resolves
      })()
    },
  }
}

function catalog(reasoning: boolean): never {
  return {
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'test' }),
    reasoningCapability: () => (reasoning ? { reasoning: true, effortValues: [] } : undefined),
  } as never
}

const harnessOptions = {
  model: 'big-pickle',
  messages: [],
  temperature: 0,
  maxTokens: 100,
} as never

/** Stream one turn and report when the terminal error surfaced. */
async function silenceMs(reasoning: boolean, firstEventMs: number, reasoningFirstEventMs: number): Promise<number> {
  const adapter = new ZenAdapter(catalog(reasoning), {
    providerOverride: muteProvider(),
    firstEventMs,
    reasoningFirstEventMs,
  })
  const started = Date.now()
  // the deadline timer is unref'd (it must not hold the host open), so the
  // test keeps the event loop alive while it waits for the deadline
  await withKeepAlive(async () => {
    for await (const chunk of adapter.stream(harnessOptions)) {
      void chunk
    }
  })
  return Date.now() - started
}

test('watchdog defaults: a wider first-event budget, tiered for reasoning', () => {
  assert.equal(DEFAULT_FIRST_EVENT_MS, 60_000)
  assert.equal(DEFAULT_REASONING_FIRST_EVENT_MS, 90_000)
  assert.equal(DEFAULT_BODY_IDLE_MS, 120_000)
})

test('the first-event watchdog message names the TTFT window, not a dead exit', () => {
  assert.ok(WATCHDOG_FIRST_MESSAGE.includes('timeout'), 'the message still carries the timeout marker')
  assert.ok(!WATCHDOG_FIRST_MESSAGE.includes('exit silent before any response'), 'the old "exit silent" wording is gone')
  assert.ok(WATCHDOG_FIRST_MESSAGE.includes('first token'), 'the message explains what the window waits for')
  assert.ok(WATCHDOG_IDLE_MESSAGE.includes('body idle timeout'), 'the mid-stream gate keeps its own wording')
})

test('the first-event watchdog stays a transport failure for the rotate loop', () => {
  assert.equal(classifyStreamFailure(WATCHDOG_FIRST_MESSAGE), 'transport')
  assert.equal(classifyStreamFailure(WATCHDOG_IDLE_MESSAGE), 'transport')
})

test('a plain model gets the plain first-event window', async () => {
  const elapsed = await silenceMs(false, 60, 400)
  assert.ok(elapsed >= 50 && elapsed < 350, `expected the plain window, fired after ${elapsed}ms`)
})

test('a reasoning model gets the wider first-event window', async () => {
  const elapsed = await silenceMs(true, 60, 400)
  assert.ok(elapsed >= 350, `expected the reasoning window, fired after ${elapsed}ms`)
})

/**
 * The live bug this window change fixes: the Zen lane holds the response
 * head back until the upstream emits its first token, so a slow first token
 * used to be reported as a dead exit ("exit silent before any response").
 */
test('a slow first token is not reported as a dead exit', async () => {
  const encoder = new TextEncoder()
  const realFetch = globalThis.fetch
  let headersDelayMs = 0
  globalThis.fetch = (async () => {
    if (headersDelayMs > 0) await new Promise((r) => setTimeout(r, headersDelayMs))
    const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'big-pickle',
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    })}\n\n`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk('pong')))
        controller.enqueue(encoder.encode(chunk('', 'stop')))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof globalThis.fetch

  try {
    const adapter = new ZenAdapter(catalog(false), { providerOverride: undefined })
    // A 1s first token: the OLD 30s window tolerated it, but the old window
    // was also reached by real requests (measured 35.8s tail) — the point of
    // this test is that a slow first token still produces content.
    headersDelayMs = 1_000
    let text = ''
    let failure = ''
    await withKeepAlive(async () => {
      for await (const chunk of adapter.stream(harnessOptions)) {
        const c = chunk as { type?: string; text?: string; reason?: { kind?: string; failure?: { message?: string } } }
        if (c.type === 'text-delta' && c.text) text += c.text
        if (c.type === 'finish' && c.reason?.kind === 'error') failure = c.reason.failure?.message ?? 'error'
      }
    })
    assert.equal(failure, '', 'a slow first token must not surface as a watchdog failure')
    assert.equal(text, 'pong')
  } finally {
    globalThis.fetch = realFetch
  }
})
