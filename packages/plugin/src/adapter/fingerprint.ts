/**
 * OpenCode Zen free-tier client fingerprint (v2), measured live 2026-10-26.
 *
 * The anonymous lane stopped answering with plain agent-shaped bodies. Five
 * axes must now ALL hold, and each one fails with a different (misleading)
 * error, so a wrong guess reads as "quota exhausted" or "model unavailable":
 *
 *   1. User-Agent      `opencode/<channel>/<version>/<client>` (v2 shape).
 *                      The old `opencode/1.18.x (win32 x64; node…)` form is
 *                      refused since 2026-10-14.
 *   2. Session header  `x-opencode-session` / `x-session-affinity` carrying a
 *                      CANONICAL `ses_<12 hex><14 base62>` id whose hex prefix
 *                      decodes to a plausible recent timestamp (measured
 *                      2026-10-25: a random hex prefix answers 429, a
 *                      timestamp-derived one answers 200).
 *   3. Tool set        OpenCode's own `read` and `shell` declarations WITH
 *                      their exact descriptions and parameter schemas. Stub
 *                      schemas (`{type:'object',properties:{}}`) and
 *                      `tool_choice:'none'` are refused.
 *   4. Streaming       `stream: true`. (pi-ai always streams — nothing to do.)
 *   5. System prompt   exactly ONE complete `<env>` … `</env>` pair containing
 *                      a `Working directory:` line. Anything else answers
 *                      HTTP 429 `FreeUsageLimitError` — the same status and
 *                      retry-after-to-00:00-UTC body as a spent quota, which is
 *                      why this looked like a quota problem for days.
 *
 * Measured 2026-10-26, same machine + same minute, free model
 * `deepseek-v4.1-flash-free`: without axes 1/2/3/5 → 429 on every attempt;
 * with all five → HTTP 200 + SSE, 5/5 rounds. The HTTP runtime matters too
 * (Node/undici is refused, Bun's fetch is answered) — see adapter/zen-relay.ts.
 */

/** The CLI user agent the free tier expects (v2 channel/version/client shape). */
export const FINGERPRINT_USER_AGENT = 'opencode/latest/2.1.4/cli'

/** Tool names the free-tier gate looks for (exact, lowercase). */
export const FINGERPRINT_TOOL_NAMES = ['read', 'shell'] as const
export type FingerprintToolName = (typeof FINGERPRINT_TOOL_NAMES)[number]

/** The harness's own tool names that collide with the fingerprint names. */
export const COLLIDING_TOOL_NAMES = new Set<string>(FINGERPRINT_TOOL_NAMES)

const READ_DESCRIPTION =
  'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.'

const READ_PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File or directory to read' },
    offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
    limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
  },
  required: ['path'],
  additionalProperties: false,
}

const SHELL_HEAD = 'Execute a shell command and return its output.'
const SHELL_TAIL =
  'Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.'

const SHELL_WORDING: Record<string, string> = {
  linux: 'Linux using bash',
  darwin: 'macOS using zsh',
  win32: 'Windows using powershell',
}

const SHELL_PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command string to execute' },
    workdir: {
      type: 'string',
      description:
        'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.',
    },
    timeout: {
      type: 'integer',
      minimum: 0,
      description:
        'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.',
    },
    background: {
      type: 'boolean',
      description:
        "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Shell description, worded for the host OS like a real CLI instance. */
export function shellDescription(platform: string = process.platform): string {
  const wording = SHELL_WORDING[platform] ?? SHELL_WORDING.linux
  return `${SHELL_HEAD} Commands run on ${wording}. ${SHELL_TAIL}`
}

export interface FingerprintDefinition {
  description: string
  parameters: Record<string, unknown>
}

/** The exact definitions the gate compares against, keyed by tool name. */
export function fingerprintDefinitions(platform: string = process.platform): Record<FingerprintToolName, FingerprintDefinition> {
  return {
    read: { description: READ_DESCRIPTION, parameters: READ_PARAMETERS },
    shell: { description: shellDescription(platform), parameters: SHELL_PARAMETERS },
  }
}

/** Chat-completions tool shape for one fingerprint tool. */
export function fingerprintChatTool(name: FingerprintToolName, platform: string = process.platform): Record<string, unknown> {
  const def = fingerprintDefinitions(platform)[name]
  return { type: 'function', function: { name, description: def.description, parameters: def.parameters } }
}

/** Responses-API (flat) tool shape for one fingerprint tool. */
export function fingerprintResponsesTool(name: FingerprintToolName, platform: string = process.platform): Record<string, unknown> {
  const def = fingerprintDefinitions(platform)[name]
  return { type: 'function', name, description: def.description, parameters: def.parameters, strict: false }
}

/** Does this tool already carry the exact definition the gate wants? */
function isFingerprintTool(tool: unknown, name: FingerprintToolName, platform: string): boolean {
  if (typeof tool !== 'object' || tool === null) return false
  const record = tool as { name?: unknown; description?: unknown; parameters?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }
  const def = record.function ?? record
  if (typeof def !== 'object' || def === null) return false
  const want = fingerprintDefinitions(platform)[name]
  if (def.description !== want.description) return false
  try {
    return JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
  } catch {
    return false
  }
}

/** Tool name from either wire shape (chat wrapper or flat), trimmed. */
function toolNameOf(tool: unknown): string {
  if (typeof tool !== 'object' || tool === null) return ''
  const record = tool as { name?: unknown; function?: { name?: unknown } }
  const raw = record.name ?? record.function?.name
  return typeof raw === 'string' ? raw.trim() : ''
}

function renameTool(tool: unknown, name: string): unknown {
  if (typeof tool !== 'object' || tool === null) return tool
  const record = tool as { function?: Record<string, unknown> } & Record<string, unknown>
  if (record.function && typeof record.function === 'object') {
    return { ...record, function: { ...record.function, name } }
  }
  return { ...record, name }
}

export interface FingerprintPlan {
  /** Tools to send upstream, caller tools first (aliased where they collided). */
  tools: unknown[]
  /** sent name -> caller's original name (response side restores it). */
  renamed: Map<string, string>
  /** Fingerprint tools that had to be appended. */
  appended: FingerprintToolName[]
}

/**
 * Prepare the tool array: caller tools that collide with a fingerprint name but
 * carry a different definition travel under `<name>_client`, so the exact
 * fingerprint definition can be appended without a duplicate name. Every other
 * caller tool is passed through untouched (case variants such as `Read` too).
 */
export function planFingerprintTools(
  callerTools: readonly unknown[] | undefined,
  options: { platform?: string; flat?: boolean } = {},
): FingerprintPlan {
  const platform = options.platform ?? process.platform
  const flat = options.flat === true
  const renamed = new Map<string, string>()
  const used = new Set(callerTools?.map(toolNameOf) ?? [])
  const kept: unknown[] = []
  const seen = new Set<string>()

  for (const tool of callerTools ?? []) {
    const name = toolNameOf(tool)
    const key = name.toLowerCase()
    if (!COLLIDING_TOOL_NAMES.has(key)) {
      kept.push(tool)
      continue
    }
    if (!seen.has(key)) seen.add(key)
    if (isFingerprintTool(tool, key as FingerprintToolName, platform)) {
      kept.push(tool)
      continue
    }
    // Collision with a different definition: alias the caller's tool.
    let alias = `${key}_client`
    for (let i = 2; used.has(alias); i += 1) alias = `${key}_client${i}`
    used.add(alias)
    renamed.set(alias, name)
    kept.push(renameTool(tool, alias))
  }

  const appended: FingerprintToolName[] = []
  const tools = [...kept]
  for (const name of FINGERPRINT_TOOL_NAMES) {
    const present = tools.some((tool) => toolNameOf(tool).toLowerCase() === name)
    if (present) continue
    tools.push(flat ? fingerprintResponsesTool(name, platform) : fingerprintChatTool(name, platform))
    appended.push(name)
  }
  return { tools, renamed, appended }
}

/** Full `<env>` pair; non-greedy so two pairs stay two matches. */
const ENV_PAIR = /<env>[\s\S]*?<\/env>/g
/** A tag whose partner is missing: it shadows the real pair. */
const ENV_TAG = /<\/?env>/g
/** The gate's load-bearing key inside the block. */
const WORKING_DIRECTORY = /Working directory:[ \t]*([^\n<]*)/

/** The environment marker a real CLI instance puts in its system prompt. */
export function envBlock(cwd: string = process.cwd(), platform: string = process.platform): string {
  const tmp = `${cwd.replace(/[\\/]+$/, '')}`
  return [
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    '  Is directory a git repo: no',
    `  Platform: ${platform}`,
    `  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    '</env>',
  ].join('\n')
}

/** True when the text already carries exactly one complete, load-bearing pair. */
export function carriesEnvBlock(text: string): boolean {
  const pairs = text.match(ENV_PAIR) ?? []
  if (pairs.length !== 1) return false
  return WORKING_DIRECTORY.test(pairs[0]!)
}

/**
 * Guarantee the marker: strip stale/partial tags, then append one complete
 * pair. The gate reads only the first pair, so a leftover fragment would
 * shadow the real block even if it is present.
 */
export function withEnvBlock(text: string, options: { cwd?: string; platform?: string } = {}): string {
  if (carriesEnvBlock(text)) return text
  const cleaned = text.replace(ENV_PAIR, '').replace(ENV_TAG, '').trim()
  const block = envBlock(options.cwd, options.platform)
  return cleaned ? `${cleaned}\n\n${block}` : block
}

/** Append `text` to one mutable string segment. */
interface Segment {
  read(): string
  write(value: string): void
}

function stringSegment(container: Record<string, unknown>, key: string): Segment {
  return {
    read: () => (typeof container[key] === 'string' ? (container[key] as string) : ''),
    write: (value) => {
      container[key] = value
    },
  }
}

function textSegments(blocks: unknown[]): Segment[] {
  const out: Segment[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (typeof record.text !== 'string') continue
    out.push({
      read: () => record.text as string,
      write: (value) => {
        record.text = value
      },
    })
  }
  return out
}

function contentSegments(message: Record<string, unknown>): Segment[] {
  const content = message.content
  if (!Array.isArray(content)) {
    if (typeof content !== 'string') message.content = ''
    return [stringSegment(message, 'content')]
  }
  const segments = textSegments(content)
  if (segments.length > 0) return segments
  const added: Record<string, unknown> = { type: 'text', text: '' }
  content.push(added)
  return [stringSegment(added, 'text')]
}

/**
 * Apply the marker to a chat-completions `messages[]` array in place. A host
 * system message is reused (the caller's own prompt is preserved); none → one
 * is created at the top.
 */
export function ensureChatEnvBlock(messages: unknown[], options: { cwd?: string; platform?: string } = {}): void {
  let first: Record<string, unknown> | undefined
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record.role !== 'system') continue
    first = record
    break
  }
  if (!first) {
    first = { role: 'system', content: '' }
    messages.unshift(first)
  }
  const segments = contentSegments(first)
  const joined = segments.map((segment) => segment.read()).join('\n')
  if (carriesEnvBlock(joined)) return
  // Rewrite only the last text segment: earlier turns of the host prompt stay.
  const last = segments[segments.length - 1]!
  last.write(withEnvBlock(joined, options))
  // Collapse the rewritten text into that one segment so exactly one pair stays.
  for (let i = 0; i < segments.length - 1; i += 1) segments[i]!.write('')
}

/** Apply the marker to a Responses body (`instructions` or system items). */
export function ensureResponsesEnvBlock(body: Record<string, unknown>, options: { cwd?: string; platform?: string } = {}): void {
  if (typeof body.instructions === 'string') {
    body.instructions = withEnvBlock(body.instructions, options)
    return
  }
  const segments: Segment[] = []
  if (typeof body.instructions === 'object' && body.instructions !== null) {
    segments.push(...textSegments([body.instructions]))
  }
  const input = body.input
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (record.role !== 'system' && record.role !== 'developer') continue
      segments.push(...contentSegments(record))
    }
  }
  const joined = segments.map((segment) => segment.read()).join('\n')
  if (segments.length === 0) {
    body.instructions = withEnvBlock('', options)
    return
  }
  if (carriesEnvBlock(joined)) return
  const last = segments[segments.length - 1]!
  last.write(withEnvBlock(joined, options))
  for (let i = 0; i < segments.length - 1; i += 1) segments[i]!.write('')
}

/** Tell the model the appended placeholders are not real tools. */
function placeholderNote(names: readonly string[]): string {
  const list = names.map((name) => `\`${name}\``).join(' or ')
  const plural = names.length > 1
  return plural
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
}

/** Append a note to the first system message (chat shape). */
function noteInChatMessages(messages: unknown[], note: string): void {
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record.role !== 'system') continue
    const segments = contentSegments(record)
    const last = segments[segments.length - 1]!
    const text = last.read().trim()
    last.write(text ? `${last.read()}\n\n${note}` : note)
    return
  }
  messages.unshift({ role: 'system', content: note })
}

/** Rewrite prior assistant tool calls so aliased names stay consistent. */
function aliasChatHistory(messages: unknown[], renamed: Map<string, string>): void {
  if (renamed.size === 0) return
  const aliases = new Map([...renamed].map(([alias, original]) => [original, alias]))
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (!Array.isArray(record.tool_calls)) continue
    record.tool_calls = record.tool_calls.map((call) => {
      if (typeof call !== 'object' || call === null) return call
      const entry = call as { function?: { name?: unknown } }
      const name = entry.function?.name
      if (typeof name !== 'string') return call
      const alias = aliases.get(name.trim())
      return alias ? { ...entry, function: { ...entry.function, name: alias } } : call
    })
  }
}

export interface FreeLaneShape {
  /** The rewritten body (the original is left untouched). */
  body: Record<string, unknown>
  /** sent tool name -> caller tool name, for the response side. */
  renamed: Map<string, string>
}

/** Reverse mapping helper for the response side. */
export function restoreToolName(name: string, renamed: Map<string, string> | undefined): string {
  if (!renamed || renamed.size === 0) return name
  return renamed.get(name) ?? name
}

/**
 * Shape an outgoing chat-completions body so the free-tier gate accepts it:
 * fingerprint tools, no `tool_choice: 'none'`, the `<env>` marker, and
 * `stream: true`. Returns undefined when the payload is not a chat body.
 */
export function shapeChatBody(payload: unknown, options: { cwd?: string; platform?: string } = {}): FreeLaneShape | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const platform = options.platform ?? process.platform
  const plan = planFingerprintTools(body.tools as unknown[] | undefined, { platform, flat: false })
  const next: Record<string, unknown> = { ...body }
  next.tools = plan.tools
  // A body without `stream: true` is refused with the same 429 quota body
  // (measured 2026-10-26: identical fingerprint, stream false 0/2 vs true 2/2).
  // pi-ai only ever streams, so pinning it can never change the wire shape the
  // SDK expects — it just stops a non-streaming caller from reading as "quota".
  next.stream = true
  // `tool_choice: 'none'` is refused outright by the gate; dropping it keeps the
  // caller's tools callable and the placeholders cold (the prompt note covers them).
  if (next.tool_choice === 'none') delete next.tool_choice
  const messages = (Array.isArray(body.messages) ? [...(body.messages as unknown[])] : []) as unknown[]
  ensureChatEnvBlock(messages, options)
  if (plan.appended.length > 0 && !plan.renamed.size) noteInChatMessages(messages, placeholderNote(plan.appended))
  aliasChatHistory(messages, plan.renamed)
  next.messages = messages
  return { body: next, renamed: plan.renamed }
}

/**
 * Responses-API twin: flat tools, `instructions` (or system items) carry the
 * marker. Returns undefined when the payload is not a responses body.
 */
export function shapeResponsesBody(payload: unknown, options: { cwd?: string; platform?: string } = {}): FreeLaneShape | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (body.input === undefined && body.instructions === undefined) return undefined
  const platform = options.platform ?? process.platform
  const plan = planFingerprintTools(body.tools as unknown[] | undefined, { platform, flat: true })
  const next: Record<string, unknown> = { ...body }
  // muse-spark rejects an explicit `reasoning.effort: 'none'`; omitting it lets
  // the backend apply its default instead of failing the turn.
  if (typeof next.reasoning === 'object' && next.reasoning !== null && (next.reasoning as { effort?: unknown }).effort === 'none') {
    delete next.reasoning
  }
  next.tools = plan.tools
  ensureResponsesEnvBlock(next, options)
  // The responses endpoint rejects the string form of tool_choice; a missing
  // choice defaults to auto downstream, which keeps caller tools callable.
  return { body: next, renamed: plan.renamed }
}
