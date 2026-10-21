import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import { ModelCatalog, ZEN_BASE_URL, type ModelLimits } from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiEvent } from './events.ts'
import { canonicalSessionID, deriveRequestIDs, disguiseHeaders, randomID } from './ids.ts'
import { ensureFreeLaneShape, ensureFreeLaneShapeResponses, toPiContext, type HarnessGenerateOptions } from './messages.ts'
import type { ZenTransport } from './transport.ts'
import { routingContext, type RoutingContext } from '../pool/dispatcher.ts'
import { classifyStreamFailure, isCapacityFailure, isRegionBlocked, shouldRotate } from '../pool/rotate.ts'

/**
 * The TS adapter: registers as a DSH LlmAdapter for the `zen-free` route
 * (plus the `opencode2dsh` legacy alias for pre-rename sessions)
 * and streams directly from the OpenCode Zen anonymous lane. The wire layer is
 * pi-ai's openai-completions implementation for most models (the same one DSH
 * uses for every OpenAI-compatible provider), plus pi-ai's openai-responses
 * for Responses-only models (muse-spark-*); this module adds the CLI disguise
 * headers, the derived session/request ids, and the free-model catalog.
 *
 * Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
 * prepareCall/stream) — structural, no host import.
 */

export const PROVIDER_ID = 'zen-free'
/** Legacy route id kept registered so existing sessions keep working. */
export const LEGACY_PROVIDER_ID = 'opencode2dsh'

export interface ZenModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface CatalogLike {
  list(): string[]
  decision(model: string): { allowed: boolean; source: string; known: boolean }
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined
  /** Optional: older fakes predate it — absence means "metadata cannot speak". */
  modelLimits?(model: string): ModelLimits | undefined
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/**
 * Output tokens the adapter may advertise for a window.
 *
 * The host reserves the advertised output limit INSIDE the advertised
 * context window: dsh-compaction-basic computes
 * `messageBudget = contextWindow - reservedCompletionTokens` (the reserve is
 * the request's `maxTokens`, i.e. exactly what we advertise) and throws a
 * target-pressure config error when that budget is not positive. The turn
 * then continues UNCOMPACTED (the error is only logged as a warning), so the
 * surface keeps growing until the lane cannot answer it any more.
 *
 * Measured 2026-10-22: minimax-m3.1-flash-free (1,000,000/512,000 in
 * models.dev) capped to a 131,072 window kept advertising 512,000 output
 * tokens, the reserve blew the message budget, compaction never ran, and the
 * session's surface reached 256,327 prompt tokens before the lane answered
 * with an empty length-stopped response.
 *
 * A quarter of the window keeps the envelope valid (the budget stays
 * positive even with the host's 64K headroom) and matches what the free
 * models actually produce (32K output).
 */
export function outputLimitFor(limits: ModelLimits): number {
  const quarter = Math.floor(limits.contextWindow / 4)
  return Math.max(1, Math.min(limits.maxTokens, quarter))
}

/**
 * Resolve the advertised limits: per-model metadata/static first, generic
 * defaults last. `contextWindowCap` (config.contextWindow) trims the
 * advertised window: DSH compacts against the window the adapter reports, so
 * a 1M-token model never triggers compaction and every turn re-sends the
 * whole (growing) surface — the single biggest latency and quota lever.
 *
 * The output limit is then clamped into that window (see
 * {@link outputLimitFor}): an output limit that does not fit the window
 * breaks the host's compaction envelope.
 */
function limitsFor(catalog: CatalogLike, model: string, contextWindowCap?: number): ModelLimits {
  const limits = catalog.modelLimits?.(model) ?? { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
  const contextWindow =
    contextWindowCap === undefined || contextWindowCap <= 0 ? limits.contextWindow : Math.min(limits.contextWindow, contextWindowCap)
  return { contextWindow, maxTokens: outputLimitFor({ contextWindow, maxTokens: limits.maxTokens }) }
}

/**
 * Reasoning-effort vocabulary the adapter owns end to end (dsh-llm treats the
 * ids as opaque: whatever resolveModel advertises comes back on
 * GenerateOptions.reasoningEffort). The ladder mirrors pi-ai's ThinkingLevel
 * so selected levels pass through untouched; `off` is the only id that maps
 * to a different wire spelling.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Levels offered for reasoning models whose metadata declares no ladder.
 * Fork: only levels verified live against the free lane (2026-09-19 probes:
 * low/medium/high/xhigh stream, `minimal` 403s, `off` maps to wire `none`
 * which muse-spark rejects — offering it would lie). Unset stays the default
 * (backend decides).
 */
const DEFAULT_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh']

/** Selectable reasoning effort as dsh-llm's resolveModel contract describes it. */
export interface ZenReasoningEffort {
  id: string
  name: string
  description?: string
}

/**
 * Turn the catalog's models.dev capability into the advertised effort list.
 * A declared ladder (models.dev `reasoning_options` effort values) wins — its
 * values are the upstream-honored spellings, with metadata `none` folded into
 * our `off`. Without a declaration, a reasoning model gets the verified
 * free-lane ladder. Non-reasoning models advertise nothing (the picker then
 * offers only the provider default).
 *
 * Fork: `minimal` is filtered everywhere — live-probed 2026-09-19 it 403s on
 * the free lane although metadata declares it.
 */
export function reasoningEfforts(capability: { reasoning: boolean; effortValues: string[] } | undefined): ZenReasoningEffort[] | undefined {
  if (!capability?.reasoning) return undefined
  const declared: string[] = []
  for (const value of capability.effortValues) {
    const level = value === 'none' ? 'off' : value
    if (level === 'minimal') continue
    if ((REASONING_EFFORT_LADDER as readonly string[]).includes(level) && !declared.includes(level)) declared.push(level)
  }
  const levels = declared.length > 0
    ? declared.sort(
        (a, b) =>
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(a) -
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(b),
      )
    : DEFAULT_EFFORT_LADDER
  return levels.map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }))
}

/**
 * The `reasoning_effort` wire value for a selected effort id. The Zen gateway
 * validates the field against `minimal|low|medium|high|xhigh|max|none`
 * (live-probed 2026-09-18: any other value is a hard 400), and `none` is the
 * only spelling that stops the always-think free models from thinking — a
 * mere omission keeps the provider default. So `off` maps to wire `none`,
 * ladder levels pass through verbatim, and unknown ids (never advertised)
 * inject nothing rather than risk the 400.
 */
export function reasoningEffortWire(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  if (id === 'off') return 'none'
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(id) ? id : undefined
}

/**
 * Model families whose upstream REFUSES `reasoning_effort: none`.
 *
 * Live-probed 2026-10-22 (minimax-m3.1-flash-free): the lane answers
 *   400 [bad_request_error] invalid params, model "MiniMax-M3.1-Flash"
 *   requires adaptive thinking; reasoning effort none is not allowed (2013)
 * — thinking cannot be switched off for that family. The picker never offers
 * "off" there (models.dev declares no "none" for it), but a configuration that
 * asks for `off` would otherwise burn the whole turn on a hard 400, so the
 * adapter maps "off" onto the cheapest thinking level the model accepts.
 */
const ADAPTIVE_THINKING_MODELS = ['minimax-m3.1']

export function requiresAdaptiveThinking(modelId: string): boolean {
  const id = String(modelId ?? '').toLowerCase()
  return ADAPTIVE_THINKING_MODELS.some((prefix) => id.startsWith(prefix))
}

/**
 * The wire effort for a model, honouring the "thinking cannot be off" rule.
 * `none` becomes the lowest accepted level instead of a hard 400.
 */
export function reasoningEffortWireFor(modelId: string, id: string | undefined): string | undefined {
  const wire = reasoningEffortWire(id)
  if (wire === 'none' && requiresAdaptiveThinking(modelId)) return 'low'
  return wire
}

/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = 'public'

/**
 * Stream-liveness watchdogs (live-observed 2026-09-07): neither fetch nor
 * pi-ai owns a body-silence timeout, so a tunnel that stands but never
 * streams hangs the turn forever (70 minutes observed). Both messages
 * carry "timeout" so classifyStreamFailure maps them to 'transport' and
 * the rotate loop gets to move the session to a live exit.
 *
 * WHAT THE FIRST-EVENT GATE REALLY MEASURES (re-measured 2026-10-21): the
 * Zen lane holds the response head back until the upstream produces its first
 * token — headers_at == first_byte_at to the millisecond (2532/2532,
 * 11687/11688, 17716/17717) — so "no pi-ai event yet" only proves the model
 * has not answered yet, NOT that the exit is dead. The old wording called
 * that a silent exit and the 30s window turned the slow TTFT tail
 * (measured p50 1.7s, p90 8.2s, tail 35.8s) into a fake transport failure.
 * The message now says what actually happened; the window is tiered by
 * reasoning effort because reasoning models compose longer.
 */
export const WATCHDOG_FIRST_MESSAGE = 'dsh-plugin-adapter: first stream event timeout (no first event within the window: the upstream holds the response head back until its first token, so this is a time-to-first-token timeout, not a dead exit)'
export const WATCHDOG_IDLE_MESSAGE = 'dsh-plugin-adapter: stream body idle timeout (exit went silent mid-response)'

/** Default watchdog windows (docs/ip-pool.md; test-injectable via constructor). */
export const DEFAULT_FIRST_EVENT_MS = 60_000
/**
 * Reasoning models (effort=high/max) burn the TTFT budget composing the
 * first token: measured 3.0-10.8s on a 182KB context, with a 35.8s tail on
 * the plain lane. The reasoning tier gets a wider first-event window.
 */
export const DEFAULT_REASONING_FIRST_EVENT_MS = 90_000
export const DEFAULT_BODY_IDLE_MS = 120_000
/**
 * How much longer than the first-event window the SDK-level request bound
 * may live. The watchdog must stay the first speaker (it explains what
 * happened); the SDK timeout only catches a request that escaped it.
 */
export const SDK_TIMEOUT_MARGIN_MS = 30_000

/** The terminal error event pi-ai owes but never sent (watchdog teardown). */
function terminalErrorEvent(errorMessage: string, model: Model<Api>): PiEvent {
  return {
    type: 'error',
    error: {
      api: model.api ?? 'openai-completions',
      provider: model.provider,
      model: model.id,
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  }
}

/**
 * Responses-only models on Zen: `muse-spark-*` return a bare 500
 * on `POST /zen/v1/chat/completions` while `POST /zen/v1/responses` returns 200
 * (opencode #44659/#44847, DSH #3957). Route by model id; extend this list
 * if Zen moves more models (candidates: gpt-5.6-luna, grok-4.6).
 *
 * The list is a fast path, not the only guard: a model that is NOT listed but
 * refuses the chat protocol anyway is detected at runtime and switched to the
 * responses path (see {@link isProtocolUnsupported}).
 *
 * NOT in the list: `jev-1.13*` (measured 2026-10-22) — the lane refuses it
 * on BOTH protocols ("Model does not support this protocol"), so routing it
 * anywhere only burns a request.
 */
export function isResponsesModel(id: string): boolean {
  return String(id ?? '').toLowerCase().startsWith('muse-spark')
}

/**
 * The upstream refusal that says "this model does not speak the chat
 * protocol" (a Responses-only model). It is a property of the MODEL, not of
 * the exit or the session, so the only useful reaction is to ask the same
 * model on `/responses`.
 */
export function isProtocolUnsupported(message: string): boolean {
  return /ModelProtocolUnsupported|does not support this protocol/i.test(message)
}

function toPiModel(id: string, reasoning: boolean, provider: string = PROVIDER_ID, limits?: ModelLimits): Model<Api> {
  return {
    id,
    name: id,
    api: isResponsesModel(id) ? 'openai-responses' : 'openai-completions',
    provider,
    baseUrl: `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`,
    // The honest capability flag: gates pi-ai's reasoning_effort branch and
    // keeps developer-role replay suppressed (the Zen lane's compat detects
    // supportsDeveloperRole=false for opencode.ai, so the system slot is
    // unchanged either way).
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: limits?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

export class ZenAdapter {
  readonly #catalog: CatalogLike
  readonly #provider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown }
  readonly #responsesProvider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown } | null
  readonly #sessionOverride?: string
  readonly #firstEventMs: number
  readonly #reasoningFirstEventMs: number
  readonly #bodyIdleMs: number
  /** True when the caller pinned the first-event window (no auto-widening). */
  readonly #firstEventPinned: boolean
  /** Optional cap for the advertised context window (config.contextWindow). */
  readonly #contextWindowCap?: number
  /** Optional transport seam (Zen-lane dispatcher hardening). */
  readonly #transport?: ZenTransport | null
  /** Models the lane refused on the chat protocol (runtime switch to /responses). */
  readonly #responsesOnlyModels = new Set<string>()

  constructor(catalog: CatalogLike, options: {
    zenBaseUrl?: string
    providerOverride?: unknown
    /** Responses-path provider seam (tests inject a scripted stream). */
    responsesProviderOverride?: unknown
    /** Fixed session id override (config.gatewaySession). */
    sessionOverride?: string
    /** Watchdog windows (tests inject short ones; defaults are live-tuned). */
    firstEventMs?: number
    /** First-event window for reasoning models (longer TTFT budget). */
    reasoningFirstEventMs?: number
    bodyIdleMs?: number
    /** Cap for the advertised context window (config.contextWindow). */
    contextWindowCap?: number
    /** Zen-lane transport hardening (see adapter/transport.ts). */
    transport?: ZenTransport | null
  } = {}) {
    this.#catalog = catalog
    this.#sessionOverride = options.sessionOverride?.trim() || undefined
    this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS
    // One knob, one window: a caller that pins only `firstEventMs` (tests,
    // or a config that wants a single budget) gets that budget for the
    // reasoning tier too. Only an untouched adapter tiers the windows.
    this.#reasoningFirstEventMs = options.reasoningFirstEventMs ?? options.firstEventMs ?? DEFAULT_REASONING_FIRST_EVENT_MS
    this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
    this.#firstEventPinned = options.firstEventMs !== undefined || options.reasoningFirstEventMs !== undefined
    this.#contextWindowCap = options.contextWindowCap
    this.#transport = options.transport ?? null
    if (options.providerOverride !== undefined) {
      this.#provider = options.providerOverride as never
      this.#responsesProvider = (options.responsesProviderOverride ?? null) as never
      return
    }
    const baseUrl = `${(options.zenBaseUrl ?? ZEN_BASE_URL).replace(/\/+$/, '')}/v1`
    const auth = {
      apiKey: {
        name: 'OpenCode Zen anonymous lane',
        resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }),
      },
    }
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth,
      models: [],
      api: openaiCompletions,
    })
    this.#responsesProvider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth,
      models: [],
      api: openaiResponses,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_ID }
  }

  /**
   * dsh-llm calls this unconditionally at registration (index.js:1208).
   * undefined = the host default retry policy, matching sidecar behavior.
   */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    // The legacy alias stays dispatchable for old sessions but must not
    // render a second picker group.
    if (provider !== PROVIDER_ID) return []
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: id, inputModalities: ['text'] })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
    reasoning?: { efforts: ZenReasoningEffort[] }
  } {
    const limits = limitsFor(this.#catalog, model, this.#contextWindowCap)
    const resolved: ReturnType<ZenAdapter['resolveModel']> = {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: limits.contextWindow },
      defaultMaxTokens: limits.maxTokens,
    }
    // The thinking-level picker: dsh-llm validates every selected id against
    // this list and echoes the choice back on GenerateOptions.reasoningEffort.
    const efforts = reasoningEfforts(this.#catalog.reasoningCapability(model))
    if (efforts) resolved.reasoning = { efforts }
    return resolved
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<ZenAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /** Stream one Chat turn from the Zen anonymous lane.
   *
   * IP-7 rotate loop (docs/ip-pool.md §3.4 / §8.1): a stream that dies
   * BEFORE any content landed restarts on a fresh exit — the pool's health
   * marks already degraded the failed exit, so the restarted pick routes
   * elsewhere, and the host's retry budget never sees the intermediate
   * error. Once ANY content event has flowed, rotation stops (§3.4: a
   * partially delivered stream is never replayed). No pool running (or the
   * failure is not exit-shaped) = the original stream surface untouched.
   */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const context = toPiContext(options)
    const ids = deriveRequestIDs(options.messages)
    // Replica escape hatch (config.gatewaySession): a poisoned derived id
    // fails deterministically while fresh ones stream — override reroutes.
    if (this.#sessionOverride) ids.session = this.#sessionOverride
    // The reasoning flag drives BOTH the wire shape (pi-ai's effort branch)
    // and the watchdog tier: reasoning models compose longer before their
    // first token, so their first-event window is wider.
    const reasoning = this.#catalog.reasoningCapability(options.model)?.reasoning === true
    const limits = limitsFor(this.#catalog, options.model, this.#contextWindowCap)
    const model = toPiModel(options.model, reasoning, options.provider ?? PROVIDER_ID, limits)
    // The wire asks for at most what we advertise: the host's request
    // `maxTokens` is our advertised default, and the upstream charges the
    // requested output against the same window as the prompt. A host that
    // asks for more (a per-session override) must not widen the envelope the
    // host's own compaction math depends on.
    const requestMaxTokens = Math.max(1, Math.min(options.maxTokens ?? limits.maxTokens, limits.maxTokens))
    // The Zen lane's own dispatcher seam (adapter/transport.ts): install the
    // hardened fetch before the request leaves, so a hostile proxy that
    // silently closed the previous CONNECT tunnel cannot kill this turn.
    this.#transport?.ensure()
    // IP-pool routing context (docs/ip-pool.md 3.3): pi-ai builds the request
    // body and dispatches it on separate layers with no channel for "which
    // model is this fetch for", so the per-request context rides AsyncLocalStorage.
    const contextStore: RoutingContext = { model: options.model, session: ids.session }
    const self = this
    const MAX_ROTATES = 3
    // Watchdog windows (live-observed 2026-09-07): the OpenAI SDK timeout
    // only covers time-to-response-headers — once headers arrive it clears
    // its timer and NOTHING on any layer owns body silence. FIRST_EVENT: no
    // pi-ai event at all (not even `start`, which only arrives after
    // response headers). BODY_IDLE: content flowing, then a long gap (LLM
    // streams may pace slowly, but minutes of nothing mid-stream is a dead
    // tunnel, not pacing). The race fires the watchdog INTO the pending
    // next() — a background return() could never cancel one (it queues
    // behind the pending request), so timeout-promise racing is the only
    // mechanism that actually interrupts a hung stream.
    const firstEventMs = reasoning ? this.#reasoningFirstEventMs : this.#firstEventMs
    const rotateStory: string[] = []
    // Capacity-class self-heal: the gateway pins a model instance per session
    // (x-session-affinity), so a dead instance fails the same conversation
    // over and over. One re-roll of the session id asks another instance.
    let sessionRerolled = false
    // Protocol-class self-heal: the lane refused the chat protocol for this
    // model, so the next attempt asks it on /responses. One switch per turn.
    let responsesSwitched = false
    for (let attempt = 0; ; attempt += 1) {
      // Responses models (muse-spark-*, jev-1.13*, and any model the lane
      // refuses on the chat protocol) stream chain-of-thought in bursts with
      // long mid-stream pauses (issue #7): give them a wider idle window so
      // slow reasoning is not misread as a dead tunnel. Chat models keep the
      // live-tuned default. Their FIRST event is a burst too, so the tiered
      // first-event window gets the same widening treatment.
      const responsesPath = this.#usesResponsesPath(options.model)
      const bodyIdleMs = responsesPath
        ? Math.max(this.#bodyIdleMs, 300_000)
        : this.#bodyIdleMs
      const firstEventWindowMs = responsesPath && !this.#firstEventPinned
        ? Math.max(firstEventMs, 120_000)
        : firstEventMs
      // The SDK-level request bound (pi-ai -> OpenAI SDK `timeout`). The SDK
      // clears its timer once the response HEAD arrives, so this only bounds
      // the header phase — exactly the phase our first-event watchdog owns.
      // Without it the SDK's own default (10 minutes) is the only backstop, and
      // a wedged upstream turns into a silent 10-minute hang reported as the
      // bare "Request timed out." The margin keeps the watchdog the first
      // speaker (it owns the diagnosis), the SDK only catches what escapes it.
      const sdkTimeoutMs = firstEventWindowMs + SDK_TIMEOUT_MARGIN_MS
      const events = routingContext.run(contextStore, () =>
        self.#eventsFor(options, context, ids, model, sdkTimeoutMs, requestMaxTokens),
      ) as AsyncIterable<PiEvent>
      let deliveredContent = false
      let preContentFailure: { message: string } | null = null
      const buffered: PiEvent[] = []
      const source = events[Symbol.asyncIterator]()
      // Peek events until the stream proves itself one way or the other:
      // content -> flush and stream through; error before content -> maybe
      // rotate. Content flushes IMMEDIATELY (only the pre-content events are
      // buffered): holding every token hostage to a failure that may never
      // come would also kill streaming for the UI.
      let flushed = false
      let sawAnyEvent = false
      let lastEventAt = Date.now()
      // One deadline timer at a time, re-armed per pull (a timer per pull
      // would accumulate thousands over a long token stream). While no event
      // has arrived at all, the FIRST-EVENT window applies (stricter — the
      // tunnel/connect stage should answer within seconds); once ANY event
      // has landed (start, or content directly), the looser BODY-IDLE
      // window applies so slow TTFT pacing on healthy exits is not misread
      // as a dead tunnel.
      let deadlineTimer: NodeJS.Timeout | undefined
      const raceDeadline = (): Promise<never> => {
        clearTimeout(deadlineTimer)
        const idleWindow = sawAnyEvent ? bodyIdleMs : firstEventWindowMs
        const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
        const ms = Math.max(0, idleWindow - (Date.now() - lastEventAt))
        return new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error(message)), ms)
          deadlineTimer.unref?.()
        })
      }
      // The pump the consumer sees after flush: buffered events first, then
      // the live rest of the stream, through ONE toStreamChunks pass so the
      // done/error terminator is never missing (the pre-fix flush fed it a
      // terminator-less slice and threw "ended without done/error").
      const pumpLive = async function* (): AsyncGenerator<PiEvent> {
        for (const e of buffered) yield e
        for (;;) {
          let next: IteratorResult<PiEvent>
          try {
            next = await Promise.race([source.next(), raceDeadline()])
          } catch (err) {
            // watchdog or foreign teardown tore the stream down mid-content:
            // the consumer already saw partial content, so surface the
            // terminal error honestly and stop — never a hang, never a replay
            yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model)
            return
          }
          if (next.done) {
            clearTimeout(deadlineTimer)
            return
          }
          const event = next.value as PiEvent
          lastEventAt = Date.now()
          if (event.type === 'error' || event.type === 'done') {
            clearTimeout(deadlineTimer)
            yield event
            return
          }
          yield event
        }
      }
      // Peek phase (pre-content): pull with the first-event deadline armed.
      for (;;) {
        let next: IteratorResult<PiEvent>
        try {
          next = await Promise.race([source.next(), raceDeadline()])
        } catch (err) {
          // pre-content silence: synthesize the terminal error pi-ai never
          // delivered so the rotate decision sees a transport failure
          preContentFailure = { message: err instanceof Error ? err.message : String(err) }
          buffered.push(terminalErrorEvent(preContentFailure.message, model))
          break
        }
        if (next.done) break
        const event = next.value as PiEvent
        lastEventAt = Date.now()
        sawAnyEvent = true
        if (event.type === 'error') {
          preContentFailure = { message: event.error.errorMessage ?? 'pi-ai stream error' }
          // the event still flows to the consumer unless we rotate
          buffered.push(event)
          break
        }
        if (event.type === 'done') {
          // pi-ai can also deliver the failure on done (stopReason: error)
          if (event.message.stopReason === 'error' && !deliveredContent) {
            preContentFailure = { message: event.message.errorMessage ?? 'pi-ai stream error' }
          }
          buffered.push(event)
          break
        }
        buffered.push(event)
        if (event.type !== 'start') deliveredContent = true
        if (deliveredContent) {
          // first content event: flush everything buffered and go live
          flushed = true
          break
        }
      }
      // peek phase over: whatever path exited the loop, this attempt's
      // deadline timer is spent (pumpLive re-arms its own per pull)
      clearTimeout(deadlineTimer)
      if (preContentFailure === null && deliveredContent) {
        yield* toStreamChunks(pumpLive(), model.contextWindow)
        return
      }
      if (preContentFailure === null && !deliveredContent) {
        // stream ended cleanly with no content and no error: pass through
        // (pi-ai's empty-response classification owns this case)
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        return
      }
      // Exit-shaped failure before content: ask the pool whether rotating is
      // worth another attempt; otherwise surface the buffered events as-is.
      const failureMessage = (preContentFailure as { message: string }).message
      // A model that refuses the chat protocol is not an exit problem and not
      // a quota problem: the same model answers on /responses. Switching the
      // path and re-running the turn is the only useful reaction — the user
      // must not see a 400 they cannot act on (measured 2026-10-22 with
      // jev-1.13-free, which the lane refuses on /chat/completions).
      if (
        !responsesPath
        && this.#responsesProvider
        && !responsesSwitched
        && isProtocolUnsupported(failureMessage)
      ) {
        responsesSwitched = true
        this.#responsesOnlyModels.add(options.model)
        buffered.length = 0
        preContentFailure = null
        deliveredContent = false
        sawAnyEvent = false
        rotateStory.push(`#${attempt + 1} protocol: switched to /responses`)
        continue
      }
      const failure = classifyStreamFailure(failureMessage)
      const deterministic = isRegionBlocked(failureMessage)
      // Capacity class ("Endpoint is unavailable"): the gateway's backing
      // instance is down and the lane pins one instance per session, so the
      // same id keeps failing. Re-roll the session id ONCE and ask again —
      // that is the only lever that moves the request to another instance
      // (neither an exit IP nor a retry of the same id can).
      if (failure !== null && !sessionRerolled && isCapacityFailure(failureMessage)) {
        sessionRerolled = true
        ids.session = canonicalSessionID(randomID('ses', 16))
        ids.request = randomID('req', 16)
        contextStore.session = ids.session
        rotateStory.push(`#${attempt + 1} capacity: re-rolled session id`)
        continue
      }
      const rotate = failure !== null
        && attempt < MAX_ROTATES
        && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic)
      rotateStory.push(`#${attempt + 1} ${failure ?? 'unknown'}: ${failureMessage.slice(0, 80)}`)
      if (!rotate) {
        // last resort: rewrite the terminal error to tell the whole story
        // (the user saw minutes of silence — the surfaced error must say
        // what was tried, not just the last attempt's failure)
        for (let i = 0; i < buffered.length; i += 1) {
          const e = buffered[i] as PiEvent & { error?: { errorMessage?: string }; message?: { errorMessage?: string; stopReason?: string } }
          if (e.type === 'error' && e.error) {
            e.error.errorMessage = rotateStory.length > 1
              ? `${e.error.errorMessage} (dsh-plugin-adapter 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(' -> ')})`
              : e.error.errorMessage
            break
          }
          if (e.type === 'done' && e.message?.stopReason === 'error') {
            e.message.errorMessage = rotateStory.length > 1
              ? `${e.message.errorMessage} (dsh-plugin-adapter 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(' -> ')})`
              : e.message.errorMessage!
            break
          }
        }
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        return
      }
      // rotate: loop re-runs #eventsFor inside the same ALS store; the pool
      // has already degraded the failed exit, so pick lands elsewhere.
    }
  }

  /** Does this model talk the responses protocol (statically known or learned)? */
  #usesResponsesPath(modelId: string): boolean {
    return isResponsesModel(modelId) || this.#responsesOnlyModels.has(modelId)
  }

  #eventsFor(
    options: HarnessGenerateOptions,
    context: ReturnType<typeof toPiContext>,
    ids: ReturnType<typeof deriveRequestIDs>,
    model: ReturnType<typeof toPiModel>,
    sdkTimeoutMs: number,
    requestMaxTokens: number,
  ): unknown {
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    // Responses-only models (muse-spark-*) must hit /responses, not
    // /chat/completions. The responses path is verified live without payload
    // shaping; the chat path keeps upstream's gate-tools/effort rewrite.
    if (this.#usesResponsesPath(model.id) && this.#responsesProvider) {
      return this.#responsesProvider.streamSimple(model, context as unknown as Context, {
        apiKey: ANONYMOUS_KEY,
        sessionId: ids.session,
        headers: disguiseHeaders(ids),
        onPayload: ensureFreeLaneShapeResponses,
        signal: options.signal,
        maxRetries: 0,
        timeoutMs: sdkTimeoutMs,
        temperature: options.temperature,
        maxTokens: requestMaxTokens,
      })
    }
    // onPayload injects the free-lane gate tools (adapter/messages.ts) into the
    // serialized body right before dispatch — plain-chat contexts carry no
    // tools and the anonymous lane 403s every body without bash+read. The same
    // seam carries the selected reasoning effort: pi-ai has no option with the
    // wire semantics this lane needs (selected off must SEND `none`, not omit),
    // so the effort rides the payload rewrite instead.
    const effortWire = reasoningEffortWireFor(options.model, options.reasoningEffort)
    const onPayload =
      effortWire === undefined
        ? ensureFreeLaneShape
        : (payload: unknown): unknown => {
            const shaped = ensureFreeLaneShape(payload)
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return shaped
            return { ...((shaped ?? payload) as Record<string, unknown>), reasoning_effort: effortWire }
          }
    return this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: ANONYMOUS_KEY,
      sessionId: ids.session,
      headers: disguiseHeaders(ids),
      onPayload,
      signal: options.signal,
      maxRetries: 0,
      timeoutMs: sdkTimeoutMs,
      temperature: options.temperature,
      maxTokens: requestMaxTokens,
    })
  }

  /** Expose the live catalog snapshot for diagnostics. */
  catalogStatus(): { total: number; exposed: number } {
    const list = this.#catalog.list()
    return { total: list.length, exposed: list.length }
  }

  decisionFor(model: string): { allowed: boolean; source: string } {
    const decision = this.#catalog.decision(model)
    return { allowed: decision.allowed, source: decision.source }
  }
}

/** Build the adapter over a live catalog. */
export function createZenAdapter(catalog: ModelCatalog): ZenAdapter {
  return new ZenAdapter(catalog)
}
