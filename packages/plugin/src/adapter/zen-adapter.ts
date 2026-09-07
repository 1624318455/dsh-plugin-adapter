import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'

import { ModelCatalog, ZEN_BASE_URL } from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiEvent } from './events.ts'
import { deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { toPiContext, type HarnessGenerateOptions } from './messages.ts'
import { routingContext, type RoutingContext } from '../pool/dispatcher.ts'
import { classifyStreamFailure, isRegionBlocked, shouldRotate } from '../pool/rotate.ts'

/**
 * The TS adapter: registers as a DSH LlmAdapter for the `opencode2dsh` route
 * and streams directly from the OpenCode Zen anonymous lane. The wire layer is
 * pi-ai's openai-completions implementation (the same one DSH uses for every
 * OpenAI-compatible provider); this module adds the CLI disguise headers, the
 * derived session/request ids, and the free-model catalog.
 *
 * Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
 * prepareCall/stream) — structural, no host import.
 */

export const PROVIDER_ID = 'opencode2dsh'

export interface ZenModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface CatalogLike {
  list(): string[]
  decision(model: string): { allowed: boolean; source: string; known: boolean }
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = 'public'

function toPiModel(id: string, contextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }
}

export class ZenAdapter {
  readonly #catalog: CatalogLike
  readonly #provider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown }

  constructor(catalog: CatalogLike, options: { zenBaseUrl?: string; providerOverride?: unknown } = {}) {
    this.#catalog = catalog
    if (options.providerOverride !== undefined) {
      this.#provider = options.providerOverride as never
      return
    }
    const baseUrl = `${(options.zenBaseUrl ?? ZEN_BASE_URL).replace(/\/+$/, '')}/v1`
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth: {
        apiKey: {
          name: 'OpenCode Zen anonymous lane',
          resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }),
        },
      },
      models: [],
      api: openaiCompletions,
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
  } {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
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
    const model = toPiModel(options.model)
    // IP-pool routing context (docs/ip-pool.md 3.3): pi-ai builds the request
    // body and dispatches it on separate layers with no channel for "which
    // model is this fetch for", so the per-request context rides AsyncLocalStorage.
    const contextStore: RoutingContext = { model: options.model, session: ids.session }
    const self = this
    const MAX_ROTATES = 3
    for (let attempt = 0; ; attempt += 1) {
      const events = routingContext.run(contextStore, () =>
        self.#eventsFor(options, context, ids, model),
      ) as AsyncIterable<PiEvent>
      let deliveredContent = false
      let preContentFailure: { message: string } | null = null
      const buffered: PiEvent[] = []
      const source = events[Symbol.asyncIterator]()
      // Peek events until the stream proves itself one way or the other:
      // content -> flush and stream through; error before content -> maybe rotate.
      for (;;) {
        const next = await source.next()
        if (next.done) break
        const event = next.value as PiEvent
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
      }
      if (preContentFailure === null || deliveredContent) {
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        // drain the rest of the live stream through
        for (;;) {
          const next = await source.next()
          if (next.done) break
          const eventsRest = [next.value as PiEvent]
          yield* toStreamChunks((async function* pumped2() { for (const e of eventsRest) yield e })(), model.contextWindow)
        }
        return
      }
      // Exit-shaped failure before content: ask the pool whether rotating is
      // worth another attempt; otherwise surface the buffered events as-is.
      const failure = classifyStreamFailure(preContentFailure.message)
      const deterministic = isRegionBlocked(preContentFailure.message)
      const rotate = failure !== null
        && attempt < MAX_ROTATES
        && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic)
      if (!rotate) {
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        return
      }
      // rotate: loop re-runs #eventsFor inside the same ALS store; the pool
      // has already degraded the failed exit, so pick lands elsewhere.
    }
  }

  #eventsFor(
    options: HarnessGenerateOptions,
    context: ReturnType<typeof toPiContext>,
    ids: ReturnType<typeof deriveRequestIDs>,
    model: ReturnType<typeof toPiModel>,
  ): unknown {
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    return this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: ANONYMOUS_KEY,
      sessionId: ids.session,
      headers: disguiseHeaders(ids),
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
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
