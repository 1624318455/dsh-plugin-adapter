import test from 'node:test'
import assert from 'node:assert/strict'
import { toStreamChunks, type HarnessChunk, type PiEvent } from '../src/adapter/events.ts'

const CONTEXT_WINDOW = 262144

function done(overrides: Partial<Parameters<typeof event>[0]> = {}): PiEvent {
  return event({ type: 'done', ...overrides })
}

function event(message: Record<string, unknown>): PiEvent {
  return {
    type: 'done',
    message: {
      api: 'openai-completions',
      provider: 'opencode2dsh',
      model: 'qwen-free',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      ...message,
    },
  } as unknown as PiEvent
}

async function collect(events: PiEvent[]): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = []
  for await (const chunk of toStreamChunks(
    (async function* () {
      for (const event of events) yield event
    })(),
    CONTEXT_WINDOW,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

type FinishChunk = Extract<HarnessChunk, { type: 'finish' }>

function expectFinish(chunk: HarnessChunk | undefined): FinishChunk {
  assert.equal(chunk?.type, 'finish')
  return chunk as FinishChunk
}

function failureOf(chunk: FinishChunk): { message: string; code: string } {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') assert.fail('expected a failure reason')
  return chunk.reason.failure
}

test('text deltas flow through and the stream ends with usage then finish', async () => {
  const chunks = await collect([
    { type: 'start', partial: { content: [] } },
    { type: 'text_start', contentIndex: 0, partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: { content: [] } },
    { type: 'text_end', contentIndex: 0, content: 'hello', partial: { content: [] } },
    done({ usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 12 } }),
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
  assert.equal(chunks[chunks.length - 2]?.type, 'usage', 'usage immediately precedes finish')
})

test('tool calls stream as tool-call blocks with stringified arguments', async () => {
  const partial = { content: [{ type: 'toolCall', id: 't1', name: 'shell' }] }
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"cm', partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: 'd":"ls"}', partial },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't1', name: 'shell', arguments: { cmd: 'ls' } },
      partial,
    },
    done({ content: [{ type: 'toolCall', id: 't1', name: 'shell', arguments: { cmd: 'ls' } }], stopReason: 'toolUse' }),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.deepEqual(chunks[1], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: '{"cm' })
  assert.deepEqual(chunks[2], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: 'd":"ls"}' })
  assert.deepEqual(chunks[3], {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 't1', name: 'shell', arguments: '{"cmd":"ls"}' },
  })
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('thinking events map to reasoning blocks', async () => {
  const chunks = await collect([
    { type: 'thinking_start', contentIndex: 0, partial: { content: [] } },
    { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: { content: [] } },
    { type: 'thinking_end', contentIndex: 0, content: 'hmm', partial: { content: [] } },
    done(),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'hmm' })
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } })
})

test('finish reasons: length, aborted, rate limit and other errors', async () => {
  const length = await collect([done({ stopReason: 'length' })])
  assert.deepEqual(length[1], { type: 'finish', reason: { kind: 'max-tokens' } })
  const aborted = await collect([event({ stopReason: 'aborted', errorMessage: 'user aborted' })])
  assert.deepEqual(aborted[1], {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'user aborted', code: 'ABORTED' } },
  })
  const rate = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' })])
  assert.equal(failureOf(expectFinish(rate[1])).code, 'RATE_LIMIT')
  const server = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 500 oops' })])
  assert.equal(failureOf(expectFinish(server[1])).code, 'SERVER')
})

test('zero-cache usage omits the optional keys', async () => {
  const chunks = await collect([done()])
  assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
})

test('an empty completed response is an EMPTY_RESPONSE error', async () => {
  const chunks = await collect([event({ content: [] })])
  const failure = failureOf(expectFinish(chunks[1]))
  assert.match(failure.message, /no content/)
  assert.equal(failure.code, 'EMPTY_RESPONSE')
})

test('silent context overflow is surfaced as CONTEXT_WINDOW_EXCEEDED', async () => {
  const chunks = await collect([event({ usage: { input: CONTEXT_WINDOW + 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW + 1 } })])
  assert.equal(failureOf(expectFinish(chunks[1])).code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a cached prefix counts toward the window (silent overflow)', async () => {
  // The cached prefix occupies the same window as the fresh tokens, so a
  // request whose prompt fills the window is an overflow even when the
  // uncached part alone is small (pi-ai isContextOverflow, case 2).
  const chunks = await collect([
    event({ usage: { input: 1000, output: 10, cacheRead: CONTEXT_WINDOW, cacheWrite: 0, totalTokens: CONTEXT_WINDOW + 1010 } }),
  ])
  assert.equal(failureOf(expectFinish(chunks[1])).code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a length stop with content stays a truncation', async () => {
  const chunks = await collect([done({ stopReason: 'length' })])
  assert.deepEqual(chunks[1], { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('a length stop with no content and a full window is an overflow, not a truncation', async () => {
  // The Zen lane truncates an oversized prompt instead of rejecting it and
  // answers with a length stop and a single token (2026-10-22: 256,327 prompt
  // tokens against a 262,144 window). Reporting it as a truncation makes the
  // host tell the user to send 继续, which cannot make progress.
  const chunks = await collect([
    event({
      stopReason: 'length',
      content: [],
      usage: { input: CONTEXT_WINDOW + 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW + 2 },
    }),
  ])
  const failure = failureOf(expectFinish(chunks[1]))
  assert.equal(failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.match(failure.message, /context window/)
})

test('a length stop with no content just below the window is an overflow too', async () => {
  // 97.8% of the window: the free lane truncates below the advertised
  // window, and the host can only compact-and-retry when it is told the
  // request overflowed.
  const chunks = await collect([
    event({
      stopReason: 'length',
      content: [],
      usage: { input: Math.floor(CONTEXT_WINDOW * 0.978), output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    }),
  ])
  assert.equal(failureOf(expectFinish(chunks[1])).code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a length stop with no content and a small prompt is an empty response', async () => {
  const chunks = await collect([
    event({
      stopReason: 'length',
      content: [],
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
    }),
  ])
  const failure = failureOf(expectFinish(chunks[1]))
  assert.equal(failure.code, 'EMPTY_RESPONSE')
  assert.match(failure.message, /without producing any content/)
})

test('a stream that ends without done/error is a bug and throws', async () => {
  await assert.rejects(collect([{ type: 'start', partial: { content: [] } }]), /without done\/error/)
})

test('tool call names are restored from the request-side alias', async () => {
  // The free-tier gate owns the `read`/`shell` names, so a caller tool with the
  // same name travels as `read_client`; the host must get its own name back.
  const events: PiEvent[] = [
    {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: { content: [{ type: 'toolCall', id: 'c1', name: 'read_client' }] },
    },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'c1', name: 'read_client', arguments: { path: 'a.txt' } },
      partial: { content: [] },
    },
    {
      type: 'done',
      message: {
        api: 'openai-completions',
        provider: 'zen-free',
        model: 'm',
        content: [{ type: 'toolCall', id: 'c1', name: 'read_client', arguments: { path: 'a.txt' } }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        stopReason: 'toolUse',
      },
    },
  ]
  const restore = (name: string): string => (name === 'read_client' ? 'read' : name)
  const chunks: HarnessChunk[] = []
  for await (const chunk of toStreamChunks(
    (async function* source() {
      for (const item of events) yield item
    })(),
    1000,
    restore,
  )) {
    chunks.push(chunk)
  }
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(end && end.type === 'block-end' && end.block.type === 'tool-call')
  assert.equal(end.block.name, 'read', "the caller's own tool name is restored")
  assert.equal(end.block.id, 'c1')
})
