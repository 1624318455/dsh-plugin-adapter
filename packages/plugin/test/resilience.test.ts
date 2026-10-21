import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_REASONING_FIRST_EVENT_MS,
  SDK_TIMEOUT_MARGIN_MS,
  ZenAdapter,
  reasoningEffortWireFor,
  requiresAdaptiveThinking,
} from '../src/adapter/zen-adapter.ts'
import { isCapacityFailure } from '../src/pool/rotate.ts'

const MODEL = 'minimax-m3.1-flash-free'

/** A catalog double that reports the free model's real 1M window. */
const catalog = {
  list: () => [MODEL],
  decision: () => ({ allowed: true, source: 'test', known: true }),
  reasoningCapability: () => ({ reasoning: true, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  modelLimits: () => ({ contextWindow: 1_000_000, maxTokens: 512_000 }),
}

function errorEvent(message: string) {
  return {
    type: 'error' as const,
    error: {
      api: 'openai-completions',
      provider: 'zen-free',
      model: MODEL,
      content: [],
      stopReason: 'error' as const,
      errorMessage: message,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  }
}

test('contextWindow cap trims the advertised window DSH compacts against', async () => {
  const uncapped = new ZenAdapter(catalog as never)
  const capped = new ZenAdapter(catalog as never, { contextWindowCap: 131_072 })
  const plain = await uncapped.prepareCall('zen-free', MODEL)
  const trimmed = await capped.prepareCall('zen-free', MODEL)
  assert.equal(plain.model.context?.contextWindow, 1_000_000, 'the model window is advertised by default')
  assert.equal(trimmed.model.context?.contextWindow, 131_072, 'the cap wins')
  // A cap above the model window must not inflate the advertisement.
  const roomy = new ZenAdapter(catalog as never, { contextWindowCap: 4_000_000 })
  const roomyCall = await roomy.prepareCall('zen-free', MODEL)
  assert.equal(roomyCall.model.context?.contextWindow, 1_000_000)
})

test('thinking-off models answer "off" with their cheapest accepted level', () => {
  assert.equal(requiresAdaptiveThinking(MODEL), true)
  assert.equal(requiresAdaptiveThinking('deepseek-v4.1-flash-free'), false)
  // The free lane rejects reasoning_effort:none for this family with a hard
  // 400 ("requires adaptive thinking"), so "off" must not be sent verbatim.
  assert.equal(reasoningEffortWireFor(MODEL, 'off'), 'low')
  assert.equal(reasoningEffortWireFor(MODEL, 'high'), 'high')
  // Models that accept none keep the honest spelling.
  assert.equal(reasoningEffortWireFor('deepseek-v4.1-flash-free', 'off'), 'none')
})

test('the provider call carries an explicit request bound', async () => {
  const seen: Array<{ timeoutMs?: number }> = []
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { timeoutMs?: number }): AsyncIterable<unknown> {
      seen.push(options)
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(catalog as never, { providerOverride: provider })
  for await (const _ of adapter.stream({ provider: 'zen-free', model: MODEL, messages: [] } as never)) void _
  assert.equal(seen.length, 1)
  // The model is a reasoning model, so the reasoning window owns the bound.
  assert.equal(seen[0]?.timeoutMs, DEFAULT_REASONING_FIRST_EVENT_MS + SDK_TIMEOUT_MARGIN_MS)
})

test('a capacity failure re-rolls the session id once and retries', async () => {
  const sessions: Array<string | undefined> = []
  let call = 0
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { sessionId?: string }): AsyncIterable<unknown> {
      sessions.push(options.sessionId)
      call += 1
      return (async function* () {
        if (call === 1) {
          yield errorEvent('429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}')
          return
        }
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'pong' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(catalog as never, { providerOverride: provider })
  const chunks: string[] = []
  for await (const chunk of adapter.stream({
    provider: 'zen-free',
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never)) chunks.push(JSON.stringify(chunk))
  assert.equal(sessions.length, 2, 'the capacity failure is retried once')
  assert.notEqual(sessions[0], sessions[1], 'the retry asks with a different session id')
  assert.ok(chunks.some((c) => c.includes('pong')), 'the retry delivers content')
})

test('the capacity class is separated from the quota class', () => {
  assert.equal(isCapacityFailure('429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}'), true)
  assert.equal(isCapacityFailure('429 FreeUsageLimitError: quota exhausted for this session'), false)
  assert.equal(isCapacityFailure('400 invalid params'), false)
})
