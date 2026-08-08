import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { loadAuthStore, resolveCredential } from "./auth.js"
import { resolveMapping, type ResolvedMapping } from "./catalog.js"
import { createNativeModel, generateLLM, streamLLM } from "./native.js"
import { AnthropicStreamEncoder, responseToAnthropic } from "./sse.js"
import { budgetEffort, toLLMRequest, webSearchFollowUp } from "./translate.js"
import { extractSearchQuery, formatSearchResults, resolveSearchBackend, searchWeb, type SearchResult } from "./websearch.js"
import type { AnthropicRequest, CcocProxyConfig, OpenCodeConfig, ProviderCatalog } from "./types.js"
import { LLMError, type LLMRequest } from "@opencode-ai/llm/schema"

export interface ProxyServerOptions {
  selected: ResolvedMapping
  mappings: Map<string, ResolvedMapping>
  aliases?: Readonly<Record<string, string>>
  config: CcocProxyConfig
  catalog: ProviderCatalog
  openCodeConfig: OpenCodeConfig
}

export interface RunningProxy {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

export interface GatewayAliasStats {
  requests: number
  errors: number
  bytes: number
  lastError?: string
  lastErrorAt?: number
}

export interface GatewayStats {
  startedAt: number
  active: number
  aliases: Record<string, GatewayAliasStats>
}

export function createGatewayStats(): GatewayStats {
  return { startedAt: Date.now(), active: 0, aliases: {} }
}

function aliasStats(stats: GatewayStats, alias: string): GatewayAliasStats {
  const existing = stats.aliases[alias]
  if (existing) return existing
  const created: GatewayAliasStats = { requests: 0, errors: 0, bytes: 0 }
  stats.aliases[alias] = created
  return created
}

/**
 * Wrap `response.write` so the gateway can report bytes streamed to clients.
 * Only the SSE path writes chunks, so a non-streaming reply counts nothing.
 */
function countResponseBytes(response: ServerResponse): () => number {
  const original = response.write.bind(response) as unknown as (chunk: unknown, ...args: unknown[]) => boolean
  let bytes = 0
  ;(response as unknown as { write: (chunk: unknown, ...args: unknown[]) => boolean }).write = (chunk, ...args) => {
    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : Buffer.isBuffer(chunk) ? chunk.length : 0
    return original(chunk, ...args)
  }
  return () => bytes
}

/**
 * Per-session effort state: a configured reasoningEffort is applied as the
 * launch default until the user changes the effort, which is detected as the
 * incoming thinking budget moving out of the launch effort tier (quantized by
 * budgetEffort). Comparing tiers instead of exact token counts absorbs the
 * context-length drift Claude Code applies to a budget within one effort
 * level. Keyed by Claude Code's session id, so a fresh session re-asserts the
 * default. The map lives for the proxy process, which is one ccoc launch.
 */
const sessionEffort = new Map<string, { baseline: ReasoningEffort | undefined; engaged: boolean }>()
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export function createProxyServer(options: ProxyServerOptions) {
  const stats = createGatewayStats()
  const pauseState = { paused: false }
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, stats, pauseState)
  })
  return server
}

export async function listenProxy(options: ProxyServerOptions): Promise<RunningProxy> {
  const server = createProxyServer(options)
  const port = options.config.port ?? 0
  const host = options.config.host ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Proxy did not expose a TCP port")
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  stats: GatewayStats,
  pauseState: { paused: boolean },
) {
  try {
    const method = request.method ?? "GET"
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    if (method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    if (method === "POST" && path.startsWith("/admin/")) {
      handleAdmin(request, response, path, pauseState)
      return
    }
    if (method === "GET" && path === "/admin/status") {
      sendJson(response, 200, { paused: pauseState.paused })
      return
    }
    // Paused: the gateway process stays up but stops serving. Only the tray's
    // own endpoints (health/stats/admin) respond; clients get a clear 503.
    if (pauseState.paused) {
      if (path === "/health") {
        sendJson(response, 503, { ok: false, paused: true, message: "Gateway paused" })
        return
      }
      if (path === "/stats") {
        sendJson(response, 200, gatewayStats(options, stats))
        return
      }
      sendJson(
        response,
        503,
        apiError("api_error", "Gateway paused - click the tray icon to resume serving."),
      )
      return
    }
    if (method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, model: options.selected.alias })
      return
    }
    if (method === "GET" && path === "/stats") {
      sendJson(response, 200, gatewayStats(options, stats))
      return
    }
    if (method === "GET" && path === "/v1/models") {
      sendJson(response, 200, {
        data: gatewayModelEntries(options.mappings, options.config.modelDisplay === "provider" ? "provider" : "slug"),
      })
      return
    }
    if (method !== "POST") {
      sendJson(response, 404, apiError("not_found", "Unknown endpoint"))
      return
    }
    if (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens") {
      const input = await readJson(request)
      sendJson(response, 200, { input_tokens: approximateTokenCount(input) })
      return
    }
    if (path === "/v1/messages" || path === "/messages") {
      await handleMessages(request, response, options, stats)
      return
    }
    sendJson(response, 404, apiError("not_found", "Unknown endpoint"))
  } catch (error) {
    if (response.headersSent) {
      response.end()
      return
    }
    sendJson(response, 500, apiError("api_error", upstreamErrorMessage(error)))
  }
}

/** Whether the request comes from this machine. The pause/resume admin
 * endpoints are deliberately loopback-only so a LAN-shared gateway cannot be
 * paused by remote clients — only the local tray can toggle it. */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function handleAdmin(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  pauseState: { paused: boolean },
) {
  if (!isLoopback(request)) {
    sendJson(response, 403, apiError("forbidden", "Admin endpoints are loopback-only"))
    return
  }
  const action = path.slice("/admin/".length)
  if (action === "pause") pauseState.paused = true
  else if (action === "resume") pauseState.paused = false
  else if (action === "toggle") pauseState.paused = !pauseState.paused
  else {
    sendJson(response, 404, apiError("not_found", "Unknown admin action"))
    return
  }
  sendJson(response, 200, { paused: pauseState.paused })
}

async function handleMessages(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  stats: GatewayStats,
) {
  const rawBody = await readBody(request)
  let input: AnthropicRequest
  try {
    input = JSON.parse(rawBody) as AnthropicRequest
    validateRequest(input)
  } catch (error) {
    sendJson(response, 400, apiError("invalid_request_error", errorMessage(error)))
    return
  }
  if (isOfficialClaudeModel(input.model, options.mappings)) {
    await forwardToAnthropic(request, response, rawBody, input, options, stats)
    return
  }
  const credentials = await loadAuthStore()
  const mapping = resolveGatewayModel(input.model, options, credentials)
  const tracked = aliasStats(stats, mapping.alias)
  tracked.requests += 1
  stats.active += 1
  const countBytes = countResponseBytes(response)
  try {
    await handleMessagesInner(request, response, options, mapping, input, tracked, credentials)
  } catch (error) {
    recordGatewayError(tracked, error)
    throw error
  } finally {
    tracked.bytes += countBytes()
    stats.active -= 1
  }
}

/** API key the client sent (x-api-key, or an Authorization Bearer token).
 * On a shared gateway that stores no credentials, this is the per-user key
 * passed through to the routed provider. */
function clientApiKey(request: IncomingMessage): string | undefined {
  const headerKey = request.headers["x-api-key"]
  if (typeof headerKey === "string" && headerKey.trim().length > 0) return headerKey.trim()
  const authorization = request.headers.authorization
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim()
    if (token.length > 0) return token
  }
  return undefined
}

function recordGatewayError(tracked: GatewayAliasStats, error: unknown) {
  tracked.errors += 1
  tracked.lastError = upstreamErrorMessage(error)
  tracked.lastErrorAt = Date.now()
}

async function handleMessagesInner(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  mapping: ResolvedMapping,
  input: AnthropicRequest,
  tracked: GatewayAliasStats,
  credentials: Awaited<ReturnType<typeof loadAuthStore>>,
) {
  const provider = options.catalog[mapping.provider]
  const providerOptions = options.openCodeConfig.provider?.[mapping.provider]?.options
  const credential = await resolveCredential(mapping, provider, providerOptions, credentials, clientApiKey(request))
  const model = createNativeModel(mapping, credential)
  const llmRequest = toLLMRequest(input, model, mapping, {
    webSearch: options.config.webSearch,
    defaultEffortActive: effortDefaultActive(request, input, mapping),
  })
  const messageID = `msg_ccoc_${crypto.randomUUID().replaceAll("-", "")}`
  const outputModel = mapping.displayName

  if (input.stream === false) {
    try {
      const result = await generateLLM(llmRequest)
      sendJson(response, 200, responseToAnthropic(result, outputModel, messageID))
    } catch (error) {
      // A non-streaming request has not written anything yet: return a real
      // HTTP error (429 for quota) so Claude Code renders it cleanly.
      sendGatewayError(response, error)
    }
    return
  }

  const encoder = new AnthropicStreamEncoder({ id: messageID, model: outputModel })
  let started = false
  const writeChunk = (chunk: string) => {
    if (!started) {
      started = true
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      for (const startChunk of encoder.start()) response.write(startChunk)
    }
    response.write(chunk)
  }

  try {
    await streamWithWebSearch(llmRequest, encoder, response, options.config.webSearch, writeChunk)
  } catch (error) {
    recordGatewayError(tracked, error)
    if (!started) {
      // Nothing has been streamed yet: return a real HTTP error so Claude Code
      // renders it as an API error instead of the empty/malformed HTTP 200 it
      // sees when the stream opens and immediately emits an error frame.
      sendGatewayError(response, error)
      return
    }
    for (const chunk of encoder.fail(upstreamErrorMessage(error))) response.write(chunk)
  } finally {
    response.end()
  }
}

/** Emit a provider error as a proper non-streaming HTTP error (quota -> 429,
 * otherwise 502), matching how the Anthropic API reports failures before any
 * content is produced. */
function sendGatewayError(response: ServerResponse, error: unknown) {
  const message = upstreamErrorMessage(error)
  const isQuota =
    (error instanceof LLMError && error.reason._tag === "QuotaExceeded") ||
    /quota|usage limit|rate limit/i.test(message)
  const type = isQuota ? "rate_limit_error" : "api_error"
  const status = isQuota ? 429 : 502
  sendJson(response, status, apiError(type, message))
}

/** Whether a configured reasoningEffort should act as the session default.
 * True on the first request of a session and on later requests whose thinking
 * budget still lands in the launch effort tier (the user has not touched
 * /effort). Once the budget moves to a different tier, the user is in control
 * and the preset yields. */
function effortDefaultActive(request: IncomingMessage, input: AnthropicRequest, mapping: ResolvedMapping): boolean {
  if (!mapping.reasoningEffort) return false
  const sessionId = String(request.headers["x-claude-code-session-id"] ?? "")
  const thinking = input.thinking
  const tier = budgetEffort(thinking, mapping)
  const state = sessionEffort.get(sessionId)
  if (!state) {
    // An explicitly disabled thinking request is the user's choice, not the
    // launch default; a request without thinking at all (model unrecognized as
    // effort-capable behind the gateway) is the launch default. When there is
    // no budget to quantize, anchor the baseline to the configured effort so a
    // later request in that tier keeps the preset active.
    const engaged = thinking?.type === "disabled"
    sessionEffort.set(sessionId, { baseline: tier ?? mapping.reasoningEffort, engaged })
    return !engaged
  }
  if (state.engaged) return false
  if (tier !== state.baseline) {
    state.engaged = true
    return false
  }
  return true
}

async function streamWithWebSearch(
  initial: LLMRequest,
  encoder: AnthropicStreamEncoder,
  response: ServerResponse,
  webSearchConfig: CcocProxyConfig["webSearch"],
  writeChunk: (chunk: string) => void,
) {
  const disabled = webSearchConfig === false
  const webSearch = resolveSearchBackend(disabled ? undefined : webSearchConfig)
  const maxTurns = disabled ? 0 : (webSearchConfig?.maxTurns ?? 3)
  let request = initial
  let searched = 0

  // Web search is executed server-side and shaped exactly like Anthropic's own
  // handling: when the model calls web_search the proxy emits a `server_tool_use`
  // block (so Claude Code knows a server-side search is running and does NOT run
  // its own — which is what caused "Did 0 searches"), runs the search, then
  // emits a `web_search_tool_result` block with the results in Anthropic's
  // format. The model then answers from those results. This mirrors what the
  // passthrough returns for official Claude models.
  for (;;) {
    let searchCall: { id: string; name: string; input: unknown } | undefined
    let terminal: string[] = []
    let failed = false
    let failureMessage = ""
    let buffered: string[] = []
    let searchRendered = false

    await streamLLM(request, (event) => {
      // Claude Code's auto compact-and-retry matches Anthropic's "prompt is too
      // long" wording; rewrite provider context-overflow errors so a long
      // conversation on a small-window model (e.g. the free tier's 200k) compacts
      // instead of erroring.
      if (event.type === "provider-error" && isContextOverflowPattern(event.message)) {
        event = { ...event, message: "prompt is too long: the conversation exceeds the model's context window." }
      }
      const output = encoder.accept(event)
      if (event.type === "finish") {
        terminal = output
      } else if (event.type === "provider-error") {
        failed = true
        failureMessage = event.message
        terminal = output
      } else if (event.type === "tool-call" && event.name === "web_search") {
        searchCall = { id: event.id, name: event.name, input: event.input }
        if (!searchRendered) {
          const input = (event.input ?? {}) as Record<string, unknown>
          for (const chunk of encoder.serverToolUse(event.id, "web_search", input)) writeChunk(chunk)
          searchRendered = true
        }
      } else if (
        event.type === "tool-call" ||
        event.type === "tool-input-start" ||
        event.type === "tool-input-delta" ||
        event.type === "tool-input-end"
      ) {
        // non-web_search tool_use: stream normally
        buffered.push(...output)
      } else {
        buffered.push(...output)
      }
    })

    if (failed) {
      if (buffered.length === 0 && terminal.length === 0) {
        throw new Error(failureMessage || "Upstream provider error")
      }
      for (const chunk of buffered) writeChunk(chunk)
      for (const chunk of terminal) writeChunk(chunk)
      return
    }

    if (!searchCall) {
      // Not a web-search turn: flush everything and terminate.
      for (const chunk of buffered) writeChunk(chunk)
      for (const chunk of terminal.length > 0 ? terminal : encoder.end()) writeChunk(chunk)
      return
    }

    // Run the search and emit a web_search_tool_result, then feed the results
    // back to the model so it can answer.
    const capped = searched >= maxTurns
    let results: SearchResult[] = []
    let resultText: string
    if (capped) {
      resultText = "Search limit reached; continue based on the information you already have."
    } else {
      try {
        results = await searchWeb(extractSearchQuery(searchCall.input), webSearch)
        resultText = formatSearchResults(results)
      } catch (error) {
        resultText = `Web search failed: ${errorMessage(error)}`
      }
    }
    if (results.length > 0) {
      for (const chunk of encoder.webSearchToolResult(searchCall.id, results)) writeChunk(chunk)
    } else {
      for (const chunk of encoder.toolResult(searchCall.id, resultText)) writeChunk(chunk)
    }
    searched += 1
    encoder.resume()
    request = webSearchFollowUp(request, searchCall, resultText, !capped)
  }
}

function validateRequest(input: AnthropicRequest): asserts input is AnthropicRequest {
  if (!input || typeof input !== "object") throw new Error("Request body must be an object")
  if (!Array.isArray(input.messages)) throw new Error("messages is required")
  if (typeof input.max_tokens !== "number") throw new Error("max_tokens is required")
}

async function readJson(request: IncomingMessage) {
  const body = await readBody(request)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error("Request body must be valid JSON")
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024 * 1024) throw new Error("Request body is too large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function approximateTokenCount(input: unknown) {
  const serialized = JSON.stringify(input) ?? ""
  return Math.ceil(serialized.length / 4)
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

function apiError(type: string, message: string) {
  return { type: "error", error: { type, message } }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turn an upstream failure into a message Claude Code can show as-is. Provider
 * error bodies are wrapped by the LLM layer as `RequestExecutor.execute:
 * Provider request failed with HTTP 429: {...}` — the raw JSON then repeats in
 * the middle of the message. Extract the provider's own `message` (e.g.
 * "5-hour usage limit reached. Resets in 1hr ...") and prefix quota failures
 * so a quota-exhausted account is clearly actionable rather than a wall of
 * JSON. Also covers proxy/gateway responses that bury a backend error behind
 * `HTTP 200` with a JSON error body.
 */
function upstreamErrorMessage(error: unknown): string {
  const isQuota = error instanceof LLMError && error.reason._tag === "QuotaExceeded"
  const isContextOverflow = isContextOverflowError(error)
  const raw = upstreamRawBody(error)
  const extracted = raw === undefined ? undefined : extractProviderMessage(raw)
  // Claude Code's automatic compact-and-retry only fires when the error matches
  // Anthropic's exact "prompt is too long" wording. A gateway that surfaces the
  // upstream provider's own context error (e.g. "prompt token count of N
  // exceeds...") breaks that recovery, so rewrite context-overflow failures to
  // Anthropic's wording to make Claude Code compact and retry.
  if (isContextOverflow) return "prompt is too long: the conversation exceeds the model's context window."
  if (extracted !== undefined)
    return isQuota && !/(quota|usage limit|credit|billing)/i.test(extracted) ? `Provider quota exhausted: ${extracted}` : extracted
  if (isQuota) return `Provider quota exhausted: ${errorMessage(error)}`
  return errorMessage(error)
}

/** Detect a provider context-window overflow (any provider's wording). */
function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof LLMError ? errorMessage(error) : error instanceof Error ? error.message : ""
  if (!message) return false
  // The LLM layer classifies InvalidRequest failures with
  // classification === "context-overflow"; fall back to wording matching.
  const reason = error instanceof LLMError ? (error.reason as unknown as { classification?: string }) : undefined
  if (reason?.classification === "context-overflow") return true
  return isContextOverflowPattern(message)
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /exceeds (?:the )?context window/i,
  /exceeds (?:the )?maximum context length/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /input token count.*exceeds the maximum/i,
  /context[_ ]?length[_ ]?exceeded/i,
  /context window exceeds limit/i,
  /model_context_window_exceeded/i,
  /exceeded model token limit/i,
  /too many tokens/i,
  /request entity too large/i,
  /exceeds the limit of \d+/i,
]

function isContextOverflowPattern(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
}

function upstreamRawBody(error: unknown): string | undefined {
  if (!(error instanceof LLMError)) return undefined
  const reason = error.reason as unknown as Record<string, unknown>
  const http = reason.http as { body?: unknown } | undefined
  if (http && typeof http.body === "string") return http.body
  const raw = reason.raw as unknown
  if (typeof raw === "string") return raw
  return undefined
}

function isRecordWith(value: unknown, key: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && key in value)
}

/** Pull a provider-supplied error message out of a raw response body. */
function extractProviderMessage(raw: string): string | undefined {
  const text = raw.trim()
  // Not a message: SSE framing lines or an empty body.
  if (!text || /^(?:data|event|id|retry)\s*:/i.test(text)) return undefined
  // Plain non-JSON text is only worth surfacing when short enough to inline.
  if (!text.startsWith("{") && !text.startsWith("[")) return text.length <= 500 ? text : undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const nested = isRecordWith(parsed, "error") ? (parsed.error as Record<string, unknown>) : undefined
    const message = typeof parsed.message === "string" ? parsed.message : typeof nested?.message === "string" ? nested.message : undefined
    const detail = typeof parsed.detail === "string" ? parsed.detail : undefined
    const type = typeof nested?.type === "string" ? nested.type : undefined
    if (message) return message
    if (detail) return detail
    if (type) return `Provider error (${type})`
  } catch {}
  return undefined
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-api-key, anthropic-version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }
}

/**
 * The gateway id advertised for a served model. `slug` mode advertises
 * `anthropic-<model>` when exactly one served provider has that model name
 * (so the bare id is unambiguous), and falls back to `anthropic-<provider>/<model>`
 * when several providers serve the same model. `provider` mode always uses
 * `anthropic-<provider>/<model>`.
 */
export function gatewayModelId(
  mapping: ResolvedMapping,
  mappings: ReadonlyMap<string, ResolvedMapping>,
  modelDisplay: "slug" | "provider",
): string {
  if (modelDisplay === "slug") {
    let providers = 0
    const seen = new Set<string>()
    for (const other of mappings.values()) {
      if (other.model !== mapping.model) continue
      const key = `${other.provider}/${other.model}`
      if (seen.has(key)) continue
      seen.add(key)
      providers += 1
    }
    if (providers === 1) return `anthropic-${mapping.model}`
  }
  return `anthropic-${mapping.provider}/${mapping.model}`
}

/**
 * Model entries served by `GET /v1/models`. Claude Code auto-discovers models
 * from this endpoint. Discovery filters ids to ones it recognises as Claude:
 * ids beginning with `claude` or `anthropic` are kept. The id/display form
 * follows `modelDisplay` (slug or provider-qualified, see gatewayModelId).
 */
export function gatewayModelEntries(
  mappings: ReadonlyMap<string, ResolvedMapping>,
  modelDisplay: "slug" | "provider" = "slug",
): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const entries: Array<Record<string, unknown>> = []
  for (const mapping of mappings.values()) {
    const key = `${mapping.provider}/${mapping.model}`
    if (seen.has(key)) continue
    seen.add(key)
    const id = gatewayModelId(mapping, mappings, modelDisplay)
    entries.push({
      id,
      display_name: id.slice("anthropic-".length),
      type: "model",
      created_at: 0,
    })
  }
  return entries.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)))
}

/**
 * Summary for `GET /stats` — uptime, per-alias request/error/byte counters,
 * and the served model list. The tray app polls this to show what the gateway
 * has been doing.
 */
function gatewayStats(
  options: ProxyServerOptions,
  stats: GatewayStats,
): Record<string, unknown> {
  const totals = Object.values(stats.aliases).reduce(
    (sum, alias) => ({
      requests: sum.requests + alias.requests,
      errors: sum.errors + alias.errors,
      bytes: sum.bytes + alias.bytes,
    }),
    { requests: 0, errors: 0, bytes: 0 },
  )
  const models = [...options.mappings.values()]
    .filter((mapping, index, list) => list.findIndex((other) => other.alias === mapping.alias) === index)
    .map((mapping) => ({
      alias: mapping.alias,
      model: mapping.model,
      provider: mapping.provider,
      protocol: mapping.protocol,
      reasoningEffort: mapping.reasoningEffort ?? null,
      reasoning: mapping.reasoning ?? false,
    }))
  return {
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    defaultModel: options.selected.alias,
    active: stats.active,
    totals,
    aliases: stats.aliases,
    models,
  }
}

/**
 * Resolve the model name a client sent to a configured mapping. Clients
 * discover models as `anthropic-<provider>/<model>`, so strip that prefix
 * (plus the `claude-` form some gateways use) before looking up the mapping.
 * A bare model slug only resolves when exactly one served model has it (e.g.
 * old `anthropic-deepseek-v4-flash` requests keep working for unique models);
 * when the same model is served by several providers it fails loudly asking
 * for the provider-qualified id. Unknown model names fail loudly instead of
 * silently routing to a fallback.
 */
function resolveGatewayModel(
  model: string,
  options: ProxyServerOptions,
  credentials: Awaited<ReturnType<typeof loadAuthStore>>,
): ResolvedMapping {
  const requested = model.trim()
  const direct = options.mappings.get(requested)
  if (direct) return direct
  const stripped = requested.replace(/^(?:anthropic|claude)-/, "")
  const alias = options.mappings.get(stripped)
  if (alias) return alias
  const slugMatches = [...options.mappings.values()].filter((mapping) => mapping.model === stripped)
  if (slugMatches.length === 1) return slugMatches[0]!
  if (slugMatches.length > 1) {
    const providers = slugMatches.map((mapping) => `${mapping.provider}/${mapping.model}`).join(", ")
    throw new Error(
      `Model '${stripped}' is served by multiple providers (${providers}); request anthropic-<provider>/<model> instead.`,
    )
  }
  try {
    return resolveMapping(
      stripped,
      options.config,
      options.catalog,
      options.openCodeConfig,
      credentials,
      options.aliases,
    )
  } catch {
    throw new Error(`Unknown model '${requested}' requested from the gateway. Configure it in ccoc config or use a known model id.`)
  }
}

const anthropicAPI = () => process.env.CCOC_ANTHROPIC_API ?? "https://api.anthropic.com"

/**
 * Whether a requested model should pass straight through to Anthropic's API
 * instead of being routed to an OpenCode provider. This lets a claude.ai /
 * Claude Code subscription login keep working through the gateway for official
 * Claude models (`claude-opus-5`, `claude-sonnet-4-6`, `opus`, `sonnet`, ...)
 * while the custom `anthropic-<alias>` models still route to OpenCode
 * providers. Configured aliases are never treated as official models.
 */
function isOfficialClaudeModel(model: string, mappings: ReadonlyMap<string, ResolvedMapping>): boolean {
  const requested = model.trim()
  const stripped = requested.replace(/^(?:anthropic|claude)-/, "")
  if (mappings.has(requested) || mappings.has(stripped)) return false
  // A served model whose bare slug looks like an official Claude id (e.g.
  // a provider's claude-sonnet-4-6 advertised as anthropic-claude-sonnet-4-6 in
  // slug mode) must route to its provider, not to Anthropic.
  for (const mapping of mappings.values()) {
    if (mapping.model === stripped) return false
  }
  // Official Claude ids and the built-in /model tier aliases.
  return /^claude-/.test(requested) || /^(opus|sonnet|haiku|fable)(-[\d.]+)?$/.test(requested)
}

/**
 * Forward a `/v1/messages` request verbatim to Anthropic's API, preserving the
 * client's OAuth/API-key headers so the user's own subscription login applies.
 * Used for official Claude models behind the gateway. The response (including
 * its SSE stream) is relayed byte-for-byte.
 */
async function forwardToAnthropic(
  request: IncomingMessage,
  response: ServerResponse,
  rawBody: string,
  input: AnthropicRequest,
  options: ProxyServerOptions,
  stats: GatewayStats,
): Promise<void> {
  const tracked = aliasStats(stats, "anthropic-official")
  tracked.requests += 1
  stats.active += 1
  const countBytes = countResponseBytes(response)
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": String(request.headers["anthropic-version"] ?? "2023-06-01"),
    }
    const authorization = request.headers.authorization
    const apiKey = request.headers["x-api-key"]
    if (typeof apiKey === "string") headers["x-api-key"] = apiKey
    if (typeof authorization === "string") headers.authorization = authorization
    const beta = request.headers["anthropic-beta"]
    if (typeof beta === "string") headers["anthropic-beta"] = beta
    if (!headers.authorization && !headers["x-api-key"]) {
      throw new Error("No Anthropic credential supplied for official model passthrough.")
    }

    const upstream = await fetch(`${anthropicAPI()}/v1/messages`, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(300_000),
    })
    response.writeHead(upstream.status, {
      ...corsHeaders(),
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    const buffer = Buffer.from(await upstream.arrayBuffer())
    response.end(buffer)
    tracked.bytes += buffer.length
  } catch (error) {
    tracked.errors += 1
    tracked.lastError = upstreamErrorMessage(error)
    tracked.lastErrorAt = Date.now()
    if (!response.headersSent) {
      sendJson(response, 502, apiError("api_error", `Anthropic passthrough failed: ${errorMessage(error)}`))
    } else {
      response.end()
    }
  } finally {
    stats.active -= 1
  }
}
