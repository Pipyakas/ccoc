import { Effect, Layer, Stream } from "effect"
import { LLM } from "@opencode-ai/llm"
import * as Anthropic from "@opencode-ai/llm/providers/anthropic"
import * as Google from "@opencode-ai/llm/providers/google"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import * as OpenAICompatible from "@opencode-ai/llm/providers/openai-compatible"
import * as OpenRouter from "@opencode-ai/llm/providers/openrouter"
import { Auth, LLMClient, fetchLayer } from "@opencode-ai/llm/route"
import type { LLMEvent, LLMRequest, Model } from "@opencode-ai/llm/schema"
import type { ResolvedMapping } from "./catalog.js"
import type { ResolvedCredential } from "./auth.js"

const runtime = LLMClient.layer.pipe(Layer.provide(fetchLayer))

export function createNativeModel(mapping: ResolvedMapping, credential: ResolvedCredential): Model {
  const routeAuth = Auth.headers(credential.headers)

  switch (mapping.protocol) {
    case "openai-responses":
      return OpenAI.configure({
        baseURL: mapping.baseURL,
        auth: routeAuth,
      }).responses(mapping.model)
    case "openai-chat":
      return OpenAICompatible.configure({
        provider: mapping.provider,
        baseURL: requiredBaseURL(mapping),
        auth: routeAuth,
      }).model(mapping.model)
    case "openrouter-chat":
      return OpenRouter.configure({
        baseURL: mapping.baseURL,
        auth: routeAuth,
      }).model(mapping.model)
    case "anthropic-messages":
      return Anthropic.configure({
        baseURL: mapping.baseURL,
        auth: routeAuth,
      }).model(mapping.model)
    case "gemini":
      return Google.configure({
        baseURL: mapping.baseURL,
        auth: routeAuth,
      }).model(mapping.model)
    case "bedrock-converse":
      throw new Error("Native Bedrock support needs AWS credentials; configure an explicit API-compatible route for now.")
  }
}

export function streamLLM(
  request: LLMRequest,
  onEvent: (event: LLMEvent) => void,
): Promise<void> {
  if (process.env.CCOC_TRACE) {
    Effect.runPromise(LLMClient.prepare(request).pipe(Effect.provide(runtime))).then((prepared) =>
      process.stderr.write(`[trace] request body: ${JSON.stringify(prepared.body)}\n`),
    )
  }
  const program = LLM.stream(request).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (process.env.CCOC_TRACE) process.stderr.write(`[trace] ${event.type} ${JSON.stringify(event).slice(0, 200)}\n`)
        onEvent(event)
      }),
    ),
    Effect.provide(runtime),
  )
  return Effect.runPromise(program)
}

export function generateLLM(request: LLMRequest) {
  return Effect.runPromise(LLM.generate(request).pipe(Effect.provide(runtime)))
}

function requiredBaseURL(mapping: ResolvedMapping) {
  if (!mapping.baseURL) throw new Error(`Provider '${mapping.provider}' needs a baseURL in OpenCode config or the mapping.`)
  return mapping.baseURL
}
