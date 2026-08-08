import assert from "node:assert/strict"
import { test } from "node:test"
import { toLLMRequest } from "../src/translate.js"
import { OpenAICompatible } from "@opencode-ai/llm/providers"
import type { ResolvedMapping } from "../src/catalog.js"

const fakeModel = () =>
  OpenAICompatible.configure({
    provider: "fake",
    baseURL: "http://127.0.0.1:1/v1",
    apiKey: "x",
  }).model("fake-model")

const mapping = (overrides: Partial<ResolvedMapping> = {}): ResolvedMapping =>
  ({
    alias: "m",
    displayName: "m",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: "http://127.0.0.1:1/v1",
    headers: {},
    ...overrides,
  }) as ResolvedMapping

const imageBlock = {
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" },
}

const textBlock = { type: "text" as const, text: "hello" }

test("image blocks are stripped for text-only models and replaced with a note", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: [textBlock, imageBlock] }],
    },
    fakeModel(),
    mapping({ vision: false }),
  )
  const content = (request.messages[0] as unknown as { content: Array<{ type: string; text?: string }> }).content
  assert.deepEqual(content.map((part) => part.type), ["text", "text"])
  assert.match((content[1] as { text: string }).text, /image omitted/)
})

test("image blocks pass through for vision models and unknown models", () => {
  for (const vision of [true, undefined]) {
    const request = toLLMRequest(
      {
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: [textBlock, imageBlock] }],
      },
      fakeModel(),
      mapping({ vision }),
    )
    const content = (request.messages[0] as unknown as { content: Array<{ type: string }> }).content
    assert.deepEqual(content.map((part) => part.type), ["text", "media"])
  }
})

test("thinking does not produce a reasoning effort for models that cannot reason", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 40_000 },
    },
    fakeModel(),
    mapping({ reasoning: false }),
  )
  assert.equal(request.providerOptions, undefined)
})

test("thinking produces a reasoning effort for reasoning models", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 40_000 },
    },
    fakeModel(),
    mapping({ reasoning: true, reasoningOptions: ["none", "low", "medium", "high", "xhigh", "max"] }),
  )
  assert.deepEqual(request.providerOptions?.openai, {
    store: false,
    reasoningEffort: "xhigh",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  })
})

test("combined tool_result+text user messages emit tool before user (wire order)", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: "List the directory" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "ls", input: { path: "." } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "bin" }] },
            { type: "text", text: "Now reply DONE" },
          ],
        },
      ],
    },
    fakeModel(),
    mapping({}),
  )
  const roles = (request.messages as unknown as Array<{ role: string }>).map((message) => message.role)
  assert.deepEqual(roles, ["user", "assistant", "tool", "user"])
})

test("redacted thinking replays as a reasoning placeholder so deepseek accepts history", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "xyz" }] },
      ],
    },
    fakeModel(),
    mapping({}),
  )
  const content = (request.messages[1] as unknown as { content: Array<{ type: string; text?: string }> }).content
  assert.deepEqual(content.map((part) => part.type), ["reasoning"])
  assert.equal((content[0] as { text: string }).text, " ")
})

test("codex routes omit maxTokens so max_output_tokens is never sent", () => {
  const codex = toLLMRequest(
    { model: "m", max_tokens: 8192, messages: [{ role: "user", content: "hi" }] },
    fakeModel(),
    mapping({ codex: true, protocol: "openai-responses" }),
  )
  assert.equal(codex.generation?.maxTokens, undefined)
  const normal = toLLMRequest(
    { model: "m", max_tokens: 8192, messages: [{ role: "user", content: "hi" }] },
    fakeModel(),
    mapping({ codex: false, protocol: "openai-responses" }),
  )
  assert.equal(normal.generation?.maxTokens, 8192)
})

test("an explicit reasoningEffort default still wins for non-reasoning models", () => {
  const request = toLLMRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 40_000 },
    },
    fakeModel(),
    mapping({ reasoning: false, reasoningEffort: "high" }),
    { defaultEffortActive: true },
  )
  assert.equal(request.providerOptions?.openai?.reasoningEffort, "high")
})
