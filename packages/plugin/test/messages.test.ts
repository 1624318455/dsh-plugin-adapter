import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureFreeLaneShape, ensureFreeLaneShapeResponses, toPiContext, type HarnessGenerateOptions, type HarnessMessage, type PiMessage } from '../src/adapter/messages.ts'

function expectAssistant(message: PiMessage | undefined): Extract<PiMessage, { role: 'assistant' }> {
  assert.equal(message?.role, 'assistant')
  return message as Extract<PiMessage, { role: 'assistant' }>
}

function expectRole(message: PiMessage | undefined, role: PiMessage['role']): PiMessage {
  assert.equal(message?.role, role)
  return message as PiMessage
}

function options(overrides: Partial<HarnessGenerateOptions> = {}): HarnessGenerateOptions {
  return { provider: 'opencode2dsh', model: 'qwen-free', messages: [], ...overrides }
}

test('system messages become leading user text', () => {
  const context = toPiContext(
    options({
      system: 'be helpful',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be helpful' }] }],
    }),
  )
  assert.equal(context.systemPrompt, 'be helpful')
  assert.equal(context.messages.length, 1)
  assert.deepEqual(context.messages[0], { role: 'user', content: 'be helpful', timestamp: 0 })
})

test('tool results become toolResult messages with the name from the prior toolCall', () => {
  const messages: HarnessMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }], isError: false },
      ],
    },
  ]
  const context = toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  const toolResult = expectRole(context.messages[2], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
  assert.equal(toolResult.toolCallId, 'call_1')
  assert.equal(toolResult.toolName, 'shell')
  assert.equal(toolResult.isError, false)
  assert.deepEqual(toolResult.content, [{ type: 'text', text: 'file.txt' }])
})

test('a user turn with text and tool results emits both messages', () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] },
        { type: 'text', text: 'now summarize' },
      ],
    },
  ]
  const context = toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  expectRole(context.messages[1], 'user')
  expectRole(context.messages[2], 'toolResult')
  expectRole(context.messages[0], 'assistant')
})

test('assistant history replays text, thinking and tool calls with parsed arguments', () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'reasoning', text: 'internal scratch' },
        { type: 'tool-call', id: 't1', name: 'calc', arguments: '{"a":1}' },
      ],
      source: { kind: 'model', provider: 'opencode2dsh', model: 'qwen-free' },
    },
  ]
  const context = toPiContext(options({ messages }))
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content, [
    { type: 'text', text: 'thinking out loud' },
    { type: 'thinking', thinking: 'internal scratch' },
    { type: 'toolCall', id: 't1', name: 'calc', arguments: { a: 1 } },
  ])
  assert.equal(assistant.stopReason, 'toolUse')
  assert.equal(assistant.model, 'qwen-free')
})

test('arguments parsing tolerates junk', () => {
  const context = toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'a', name: 'x', arguments: '' },
            { type: 'tool-call', id: 'b', name: 'x', arguments: 'not json' },
          ],
        },
      ],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content[0], { type: 'toolCall', id: 'a', name: 'x', arguments: {} })
  assert.deepEqual(assistant.content[1], { type: 'toolCall', id: 'b', name: 'x', arguments: { raw: 'not json' } })
  assert.equal(assistant.stopReason, 'toolUse')
})

test('assistant images cannot be replayed', () => {
  assert.throws(
    () =>
      toPiContext(
        options({
          messages: [{ role: 'assistant', content: [{ type: 'image' as never, data: 'x' } as never] }],
        }),
      ),
    /image/,
  )
})

test('tools pass through and empty tool lists are omitted', () => {
  const withTools = toPiContext(options({ tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }] }))
  assert.deepEqual(withTools.tools, [{ name: 'shell', description: 'run', parameters: { type: 'object' } }])
  const withoutTools = toPiContext(options())
  assert.equal(withoutTools.tools, undefined)
})

// --- free-tier fingerprint (measured 2026-10-26, adapter/fingerprint.ts) -----

const ENV_MARK = /<env>[\s\S]*?<\/env>/

function chatToolName(tool: unknown): string {
  const record = tool as { name?: string; function?: { name?: string } }
  return record.function?.name ?? record.name ?? ''
}

test('ensureFreeLaneShape adds the read/shell fingerprint tools and the env marker', () => {
  const payload = { model: 'm', stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  assert.notEqual(next, undefined)
  const tools = next.tools as Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>
  assert.deepEqual(tools.map(chatToolName).sort(), ['read', 'shell'])
  const read = tools.find((tool) => chatToolName(tool) === 'read')!
  assert.deepEqual((read.function.parameters as { required?: string[] }).required, ['path'], 'exact OpenCode schema, not a stub')
  // The `<env>` marker is what makes the difference between 429 and 200.
  const messages = next.messages as Array<{ role: string; content: string }>
  assert.match(messages[0]!.content, ENV_MARK)
  assert.match(messages[0]!.content, /Working directory:/)
  assert.ok(!('tool_choice' in next), 'tool_choice none is refused by the gate and never injected')
  // The caller payload is untouched.
  assert.equal(payload.messages.length, 1)
})

test('ensureFreeLaneShape keeps a callers own read tool under an alias', () => {
  const payload = {
    model: 'm',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'DSH read', parameters: { type: 'object' } } }],
    tool_choice: 'none',
  }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  const names = (next.tools as unknown[]).map(chatToolName).sort()
  assert.deepEqual(names, ['read', 'read_client', 'shell'], 'caller read is aliased, fingerprint read appended')
  const aliased = (next.tools as Array<{ function: { name: string; description: string } }>).find(
    (tool) => chatToolName(tool) === 'read_client',
  )!
  assert.equal(aliased.function.description, 'DSH read', "the caller's own definition is preserved")
  assert.ok(!('tool_choice' in next), 'none is dropped so the caller tools stay callable')
})

test('ensureFreeLaneShape leaves non-chat payloads untouched', () => {
  assert.equal(ensureFreeLaneShape({ tools: [] }), undefined, 'no messages = not a chat body')
  assert.equal(ensureFreeLaneShape(null), undefined)
  assert.equal(ensureFreeLaneShape('text'), undefined)
})

test('an already complete env marker is preserved, a partial one is replaced', () => {
  const complete = '<env>\n  Working directory: /work/app\n  Platform: linux\n</env>'
  const kept = ensureFreeLaneShape({
    model: 'm',
    messages: [{ role: 'system', content: `sys\n\n${complete}` }, { role: 'user', content: 'hi' }],
  }) as { messages: Array<{ content: string }> }
  assert.ok(kept.messages[0]!.content.startsWith(`sys\n\n${complete}`), 'the caller marker is reused verbatim')
  assert.equal((kept.messages[0]!.content.match(/<env>/g) ?? []).length, 1, 'no duplicate marker')

  // A tag without its partner shadows the real block, so it is stripped.
  const partial = ensureFreeLaneShape({
    model: 'm',
    messages: [{ role: 'system', content: 'sys <env> Working directory: /stale' }, { role: 'user', content: 'hi' }],
  }) as { messages: Array<{ content: string }> }
  const text = partial.messages[0]!.content
  assert.equal((text.match(/<env>/g) ?? []).length, 1, 'exactly one opening tag')
  assert.equal((text.match(/<\/env>/g) ?? []).length, 1, 'exactly one closing tag')
  assert.match(text, /Working directory: /)
  // Only the marker TAGS are normalised; the caller's own prose stays intact.
  assert.ok(text.includes('sys'), 'caller text preserved')
})

test('ensureFreeLaneShapeResponses adds flat fingerprint tools + instructions marker', () => {
  const payload = { model: 'muse-spark-1.3-contributor-free', input: 'hi', stream: true, reasoning: { effort: 'none' } }
  const next = ensureFreeLaneShapeResponses(payload) as Record<string, unknown>
  const tools = next.tools as Array<{ type: string; name: string }>
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['read', 'shell'])
  assert.equal(tools[0]!.type, 'function')
  assert.ok(!('function' in tools[0]!), 'flat responses shape')
  assert.match(String(next.instructions), ENV_MARK)
  assert.ok(!('reasoning' in next), 'muse-spark rejects reasoning.effort none')
  assert.equal(next.input, 'hi')
})

test('ensureFreeLaneShapeResponses leaves non-responses payloads untouched', () => {
  assert.equal(ensureFreeLaneShapeResponses({ tools: [] }), undefined)
  assert.equal(ensureFreeLaneShapeResponses({ model: 'm', messages: [] }), undefined)
  assert.equal(ensureFreeLaneShapeResponses(null), undefined)
})

test('ensureFreeLaneShape pins stream: true', () => {
  // Measured 2026-10-26 with an otherwise perfect fingerprint: `stream: false`
  // answers 429 FreeUsageLimitError, `stream: true` answers 200. The gate reads
  // a non-streaming body as an unauthorized client, so the flag is forced.
  const off = ensureFreeLaneShape({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>
  assert.equal(off.stream, true)
  const kept = ensureFreeLaneShape({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>
  assert.equal(kept.stream, true)
})
