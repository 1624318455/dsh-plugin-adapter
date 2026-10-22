import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { isProtocolUnsupported, isResponsesModel, LEGACY_PROVIDER_ID, PROVIDER_ID, reasoningEfforts, reasoningEffortWire, ZenAdapter } from '../src/adapter/zen-adapter.ts'

/**
 * The exact method surface dsh-llm touches on a registered adapter. A missing
 * member throws inside registerAdapter and silently drops the provider from
 * the model selector (regression: providerRetryPolicy, index.js:1208).
 */
test('ZenAdapter implements the full dsh-llm adapter surface', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  for (const method of [
    'providerInfo',
    'providerRetryPolicy',
    // dsh-llm's base class ships a no-op default for this, but that default
    // only exists for adapters that extend the class; the host calls the
    // member without a guard, so a plain-object adapter MUST implement it
    // (a missing member killed the /compact command on 2026-10-22).
    'imageRequestPricing',
    'listModels',
    'resolveModel',
    'prepareCall',
    'stream',
  ]) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `missing method: ${method}`)
  }
})

test('the route declares no image pricing, so the host falls back to its own estimate', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(
    (adapter as unknown as { imageRequestPricing: (p: string, m: string) => unknown }).imageRequestPricing(PROVIDER_ID, 'minimax-m3.1-flash-free'),
    undefined,
  )
})

test('providerInfo preserves the route id and names the provider', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.deepEqual(adapter.providerInfo('opencode2dsh'), { id: 'opencode2dsh', name: PROVIDER_ID })
})

test('providerRetryPolicy defers to the host default', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(adapter.providerRetryPolicy('opencode2dsh'), undefined)
})

test('resolveModel declares text-only input and finite limits', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const resolved = adapter.resolveModel('opencode2dsh', 'big-pickle')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(resolved.context.contextWindow > 0, true)
  assert.equal(resolved.defaultMaxTokens > 0, true)
  assert.equal(resolved.provider, 'opencode2dsh')
  assert.equal(resolved.id, 'big-pickle')
})

test('prepareCall returns the resolved model and a stream dispatcher', async () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const call = await adapter.prepareCall('opencode2dsh', 'big-pickle')
  assert.equal(call.model.id, 'big-pickle')
  assert.equal(typeof call.stream, 'function')
})

test('listModels mirrors the catalog without duplicates', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'big-pickle', 'mimo-v2.5-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
  })
  const models = adapter.listModels(PROVIDER_ID)
  assert.deepEqual(models.map((m) => m.id), ['big-pickle', 'mimo-v2.5-free'])
})

test('listModels stays empty on the legacy alias (single picker group)', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  })
  assert.deepEqual(adapter.listModels(LEGACY_PROVIDER_ID), [])
  assert.deepEqual(adapter.listModels(PROVIDER_ID).map((m) => m.id), ['big-pickle'])
})

test('resolveModel advertises per-model context/output limits (muse-spark is 1M)', () => {
  const adapter = new ZenAdapter({
    list: () => ['muse-spark-1.3-contributor-free', 'big-pickle', 'ghost'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
    modelLimits: (model: string) =>
      model === 'muse-spark-1.3-contributor-free'
        ? { contextWindow: 1048576, maxTokens: 131072 }
        : model === 'big-pickle'
          ? { contextWindow: 200000, maxTokens: 32000 }
          : undefined,
  })
  const spark = adapter.resolveModel('zen-free', 'muse-spark-1.3-contributor-free')
  assert.equal(spark.context.contextWindow, 1048576)
  assert.equal(spark.defaultMaxTokens, 131072)
  const pickle = adapter.resolveModel('zen-free', 'big-pickle')
  assert.equal(pickle.context.contextWindow, 200000)
  assert.equal(pickle.defaultMaxTokens, 32000)
  // metadata cannot speak: generic defaults (pre-modelLimits fakes hit this too)
  const ghost = adapter.resolveModel('zen-free', 'ghost')
  assert.equal(ghost.context.contextWindow, 262144)
  assert.equal(ghost.defaultMaxTokens, 32768)
})

test('resolveModel falls back to generic defaults when the catalog predates modelLimits', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  })
  const resolved = adapter.resolveModel('zen-free', 'big-pickle')
  assert.equal(resolved.context.contextWindow, 262144)
  assert.equal(resolved.defaultMaxTokens, 32768)
})

test('the advertised output limit always fits the advertised window', () => {
  // dsh-compaction-basic reserves the advertised output limit INSIDE the
  // advertised window (messageBudget = contextWindow - maxTokens) and throws
  // when that budget is not positive; the turn then continues uncompacted.
  // Regression 2026-10-22: a 131,072 window with a 512,000 output limit
  // silently disabled every compaction in the session.
  const adapter = new ZenAdapter({
    list: () => ['minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
    modelLimits: (model: string) =>
      model === 'minimax-m3.1-flash-free'
        ? { contextWindow: 1000000, maxTokens: 512000 }
        : { contextWindow: 262144, maxTokens: 262144 },
  })
  const minimax = adapter.resolveModel('zen-free', 'minimax-m3.1-flash-free')
  assert.equal(minimax.context.contextWindow, 1000000)
  assert.equal(minimax.defaultMaxTokens, 250000, 'output capped to a quarter of the window')
  const lightning = adapter.resolveModel('zen-free', 'nemotron-3.5-lightning-free')
  assert.equal(lightning.defaultMaxTokens, 65536, 'a model whose output equals its window is capped')
  for (const resolved of [minimax, lightning]) {
    assert.ok(
      resolved.defaultMaxTokens < resolved.context.contextWindow,
      `output limit ${resolved.defaultMaxTokens} must fit the window ${resolved.context.contextWindow}`,
    )
  }
})

test('a capped context window pulls the output limit in with it', () => {
  const adapter = new ZenAdapter(
    {
      list: () => ['minimax-m3.1-flash-free'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
      modelLimits: () => ({ contextWindow: 1000000, maxTokens: 512000 }),
    },
    { contextWindowCap: 131072 },
  )
  const resolved = adapter.resolveModel('zen-free', 'minimax-m3.1-flash-free')
  assert.equal(resolved.context.contextWindow, 131072)
  assert.equal(resolved.defaultMaxTokens, 32768)
})

test('the wire request never asks for more output than the adapter advertises', async () => {
  const { provider, captured } = capturingProvider()
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
      modelLimits: () => ({ contextWindow: 1000000, maxTokens: 512000 }),
    },
    { providerOverride: provider },
  )
  const call = await adapter.prepareCall('zen-free', 'big-pickle')
  for await (const _ of call.stream({
    provider: 'zen-free',
    model: 'big-pickle',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 512000,
  } as any)) { /* drain */ }
  assert.equal((captured[0] as any).maxTokens, 250000, 'host ask clamped to the advertised limit')
})
test('reasoningEfforts filters minimal everywhere on the free lane', () => {
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['minimal', 'low'] })?.map((e) => e.id),
    ['low'],
  )
})

test('isResponsesModel routes the known responses-only family there', () => {
  for (const id of ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.2', 'MUSE-SPARK-1.3']) {
    assert.equal(isResponsesModel(id), true, id)
  }
  for (const id of ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash', '']) {
    assert.equal(isResponsesModel(id), false, id || '(empty)')
  }
  // measured 2026-10-22: jev-1.13* refuses BOTH protocols upstream, so it
  // must not be routed to the responses path (that only burns a request).
  for (const id of ['jev-1.13', 'jev-1.13-free']) {
    assert.equal(isResponsesModel(id), false, id)
  }
})

test('isProtocolUnsupported recognises the lane protocol refusal', () => {
  assert.equal(
    isProtocolUnsupported('400 INVALID_REQUEST ModelProtocolUnsupported: Model does not support this protocol.'),
    true,
  )
  assert.equal(isProtocolUnsupported('429 {"type":"FreeUsageLimitError"}'), false)
  assert.equal(isProtocolUnsupported(''), false)
})

test('a model that refuses the chat protocol is retried on the responses path', async () => {
  let chatCalls = 0
  let responsesCalls = 0
  const chatProvider = {
    async *streamSimple() {
      chatCalls += 1
      yield {
        type: 'error',
        error: { errorMessage: '400 INVALID_REQUEST ModelProtocolUnsupported: Model does not support this protocol.' },
      }
    },
  }
  const responsesProvider = {
    async *streamSimple() {
      responsesCalls += 1
      yield { type: 'start', partial: { content: [] } }
      yield { type: 'text_delta', contentIndex: 0, delta: 'ok', partial: { content: [] } }
      yield {
        type: 'done',
        message: {
          api: 'openai-responses',
          provider: PROVIDER_ID,
          model: 'new-free-model',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
          stopReason: 'stop',
        },
      }
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['new-free-model'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
      modelLimits: () => ({ contextWindow: 262144, maxTokens: 32768 }),
    },
    { providerOverride: chatProvider, responsesProviderOverride: responsesProvider },
  )
  const chunks: any[] = []
  for await (const chunk of adapter.stream({
    provider: PROVIDER_ID,
    model: 'new-free-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as any)) chunks.push(chunk)
  assert.equal(chatCalls, 1, 'the chat path was tried once')
  assert.equal(responsesCalls, 1, 'the turn continued on the responses path')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok'), 'the answer reaches the host')
  assert.ok(
    !chunks.some((c) => c.type === 'finish' && c.reason?.kind === 'error'),
    'the protocol refusal never surfaces as a failure',
  )
})

test('the protocol switch happens once per model, not on every turn', async () => {
  let chatCalls = 0
  let responsesCalls = 0
  const chatProvider = {
    async *streamSimple() {
      chatCalls += 1
      yield {
        type: 'error',
        error: { errorMessage: 'ModelProtocolUnsupported: Model does not support this protocol.' },
      }
    },
  }
  const responsesProvider = {
    async *streamSimple() {
      responsesCalls += 1
      yield {
        type: 'done',
        message: {
          api: 'openai-responses',
          provider: PROVIDER_ID,
          model: 'new-free-model',
          content: [],
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
          stopReason: 'stop',
        },
      }
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['new-free-model'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
      modelLimits: () => ({ contextWindow: 262144, maxTokens: 32768 }),
    },
    { providerOverride: chatProvider, responsesProviderOverride: responsesProvider },
  )
  for (let turn = 0; turn < 2; turn += 1) {
    for await (const _ of adapter.stream({
      provider: PROVIDER_ID,
      model: 'new-free-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as any)) { /* drain */ }
  }
  assert.equal(chatCalls, 1, 'the second turn goes straight to the responses path')
  assert.equal(responsesCalls, 2)
})

test('provider ids: zen-free default with opencode2dsh legacy alias', () => {
  assert.equal(PROVIDER_ID, 'zen-free')
  assert.equal(LEGACY_PROVIDER_ID, 'opencode2dsh')
})

test('ZenAdapter constructs the responses provider alongside chat', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(typeof adapter.stream, 'function')
})

test('legacy route streams with its own provider echoed', async () => {
  let seen: any = null
  const provider = {
    async *streamSimple(_model: any, _context: any, options: any) {
      seen = options
      yield {
        type: 'done',
        message: {
          stopReason: 'stop', content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
      }
    },
  }
  const adapter = new ZenAdapter(new ModelCatalog(), { providerOverride: provider })
  const call = await adapter.prepareCall(LEGACY_PROVIDER_ID, 'big-pickle')
  assert.equal(call.model.provider, LEGACY_PROVIDER_ID)
  for await (const _ of call.stream({ provider: LEGACY_PROVIDER_ID, model: 'big-pickle', messages: [] } as any)) { /* drain */ }
  assert.ok(seen !== null)
})

test('sessionOverride reroutes poisoned conversations (replica escape hatch)', async () => {
  let seen: any = null
  const provider = {
    async *streamSimple(_model: any, _context: any, options: any) {
      seen = options
      yield {
        type: 'done',
        message: {
          stopReason: 'stop', content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
      }
    },
  }
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const plain = new ZenAdapter(new ModelCatalog(), { providerOverride: provider })
  await collectStream(plain, msgs)
  assert.match(seen.sessionId, /^ses_/, 'derived session by default')
  const rerouted = new ZenAdapter(new ModelCatalog(), {
    providerOverride: provider,
    sessionOverride: 'ses_e45fa152d3eb5Of7MOiXfLtX4n',
  })
  await collectStream(rerouted, msgs)
  assert.equal(seen.sessionId, 'ses_e45fa152d3eb5Of7MOiXfLtX4n')
})

async function collectStream(adapter: ZenAdapter, messages: any): Promise<void> {
  const call = await adapter.prepareCall('opencode2dsh', 'big-pickle')
  for await (const _ of call.stream({ provider: 'opencode2dsh', model: 'big-pickle', messages } as any)) { /* drain */ }
}
test('reasoningEfforts: declared ladder wins, none folds into off, default ladder otherwise', () => {
  // no capability / non-reasoning model: advertise nothing
  assert.equal(reasoningEfforts(undefined), undefined)
  assert.equal(reasoningEfforts({ reasoning: false, effortValues: ['low'] }), undefined)
  // reasoning without a declared ladder: only levels verified live on the free lane
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: [] })?.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh'],
  )
  // declared ladder (muse-spark shape) is offered verbatim, ladder-ordered
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['xhigh', 'low', 'medium'] })?.map((e) => e.id),
    ['low', 'medium', 'xhigh'],
  )
  // metadata `none` folds into our `off`; out-of-vocabulary values drop
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['none', 'high', 'banana'] })?.map((e) => e.id),
    ['off', 'high'],
  )
  // selector labels are the capitalized level names
  assert.deepEqual(reasoningEfforts({ reasoning: true, effortValues: [] })?.[0], { id: 'low', name: 'Low' })
})

test('reasoningEffortWire maps picker ids to the gateway spelling', () => {
  // no selection: inject nothing (provider default keeps always-think models thinking)
  assert.equal(reasoningEffortWire(undefined), undefined)
  // off must SEND none — a mere omission never disables Zen's thinking models
  assert.equal(reasoningEffortWire('off'), 'none')
  // ladder levels pass through verbatim
  assert.equal(reasoningEffortWire('low'), 'low')
  assert.equal(reasoningEffortWire('xhigh'), 'xhigh')
  // unknown ids were never advertised; inject nothing rather than risk the 400
  assert.equal(reasoningEffortWire('banana'), undefined)
})

test('resolveModel advertises the thinking-level picker for reasoning models only', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'ghost'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: (model: string) =>
      model === 'big-pickle' ? { reasoning: true, effortValues: ['low', 'high'] } : undefined,
  })
  assert.deepEqual(
    adapter.resolveModel('opencode2dsh', 'big-pickle').reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  )
  // unknown metadata: no reasoning field — dsh-llm then offers only the default
  assert.equal(adapter.resolveModel('opencode2dsh', 'ghost').reasoning, undefined)
})

/** Scripted provider that records the streamSimple options it receives. */
function capturingProvider() {
  const captured: Array<{ onPayload?: (payload: unknown) => unknown }> = []
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { onPayload?: (payload: unknown) => unknown }): AsyncIterable<{ type: string }> {
      captured.push(options)
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'hi' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  return { provider, captured }
}

/** A body that already satisfies the free-lane agent-shape gate. */
const gateBody = {
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  tools: ['bash', 'read'].map((name) => ({ type: 'function', function: { name, description: 'd', parameters: {} } })),
}

async function runStream(catalogReasoning: boolean, effort?: string): Promise<Array<{ onPayload?: (payload: unknown) => unknown }>> {
  const { provider, captured } = capturingProvider()
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => ({ reasoning: catalogReasoning, effortValues: [] }),
    },
    { providerOverride: provider },
  )
  const options = { provider: 'opencode2dsh', model: 'big-pickle', messages: [], temperature: 0, maxTokens: 16 }
  const stream = adapter.stream({ ...options, ...(effort !== undefined ? { reasoningEffort: effort } : {}) } as never)
  for await (const chunk of stream) void chunk
  return captured
}

test('stream injects the selected reasoning_effort into the outgoing body', async () => {
  // off -> wire none (the only spelling that stops the always-think models)
  const offOptions = (await runStream(true, 'off'))[0]!
  assert.deepEqual(offOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'none' })

  // ladder levels ride verbatim
  const lowOptions = (await runStream(true, 'low'))[0]!
  assert.deepEqual(lowOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'low' })

  // no selection: the onPayload stays the plain gate shaper (a gate-satisfied
  // body needs no rewrite -> undefined, and no effort field is ever added)
  const defaultOptions = (await runStream(true))[0]!
  assert.equal(defaultOptions.onPayload?.({ ...gateBody }), undefined)
})

test('stream keeps the free-lane gate rewrite alongside the effort injection', async () => {
  // a body missing the gate tools gets them AND the effort in one rewrite
  const offOptions = (await runStream(true, 'off'))[0]!
  const shaped = offOptions.onPayload?.({ model: 'big-pickle', messages: [], stream: true }) as Record<string, unknown>
  assert.equal(shaped.reasoning_effort, 'none')
  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort(),
    ['bash', 'read'],
  )
  assert.equal(shaped.tool_choice, 'none')

  // non-chat payloads pass through untouched even with an effort selected
  assert.equal(offOptions.onPayload?.(null), undefined)
})
