import { LLM } from "@opencode-ai/llm"
import { ToolResultPart } from "@opencode-ai/llm/schema"
import type { LLMRequest, Model } from "@opencode-ai/llm/schema"
import { isServerSideTool, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_SCHEMA } from "./websearch.js"
import type { ResolvedMapping } from "./catalog.js"
import type {
  AnthropicContentBlock,
  AnthropicMessageInput,
  AnthropicRequest,
  AnthropicToolResultBlock,
  WebSearchConfig,
} from "./types.js"

export interface TranslateOptions {
  webSearch?: false | WebSearchConfig
  /** When true, a configured mapping.reasoningEffort is applied as the session
   * default (the launch default, before the user changes /effort). */
  defaultEffortActive?: boolean
}

export function toLLMRequest(input: AnthropicRequest, model: Model, mapping: ResolvedMapping, options: TranslateOptions = {}) {
  const serverSideTools = (input.tools ?? []).filter(isServerSideTool)
  const tools = (input.tools ?? [])
    .filter((tool) => !isServerSideTool(tool))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.input_schema,
    }))
  if (
    options.webSearch !== false &&
    serverSideTools.some((tool) => tool.name === "web_search")
  ) {
    tools.push({
      name: "web_search",
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: WEB_SEARCH_SCHEMA as Record<string, unknown>,
    })
  }
  const messages = lowerMessages(input.messages, input.tools ?? [], mapping.vision)
  const reasoningEffort =
    mapping.reasoning === false && !mapping.reasoningEffort
      ? undefined
      : reasoningEffortFor(input.thinking, mapping, options.defaultEffortActive)

  return LLM.request({
    id: `ccoc-${Date.now().toString(36)}`,
    model,
    system: systemText(input.system),
    messages: messages as any,
    tools,
    toolChoice: lowerToolChoice(input.tool_choice),
    generation: {
      // OpenAI's Codex backend does not accept max_output_tokens; omit the
      // field so the route uses the backend's own output limit.
      maxTokens: mapping.codex ? undefined : input.max_tokens,
      temperature: input.temperature,
      topP: input.top_p,
      stop: input.stop_sequences,
    },
    providerOptions:
      reasoningEffort && (mapping.protocol === "openai-responses" || mapping.protocol === "openai-chat")
        ? {
            openai: {
              store: false,
              reasoningEffort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          }
        : undefined,
  })
}

function systemText(system: AnthropicRequest["system"]): string | undefined {
  if (typeof system === "string") return system
  if (!system) return undefined
  return system
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

function lowerMessages(
  messages: AnthropicMessageInput[],
  tools: AnthropicRequest["tools"] = [],
  vision?: boolean,
) {
  const toolNames = new Map<string, string>()
  for (const tool of tools) toolNames.set(tool.name, tool.name)
  const result: Array<Record<string, unknown>> = []

  for (const message of messages) {
    const blocks: AnthropicContentBlock[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    const ordinary: Array<Record<string, unknown>> = []
    const toolResults: Array<Record<string, unknown>> = []

    for (const block of blocks) {
      if (block.type === "tool_result") {
        toolResults.push(lowerToolResult(block, toolNames))
      } else if (block.type === "image" && vision === false) {
        ordinary.push({ type: "text", text: "[image omitted: this model does not support vision]" })
      } else {
        const lowered = lowerContentBlock(block)
        if (lowered) ordinary.push(lowered)
      }
    }

    if (message.role === "assistant") {
      result.push({ role: "assistant", content: ordinary })
    } else {
      // Tool results must immediately follow the assistant message they answer
      // (OpenAI wire order); a combined tool_result+text user message splits
      // into tool first, then the text as a separate user turn.
      if (toolResults.length > 0) result.push({ role: "tool", content: toolResults })
      if (ordinary.length > 0) result.push({ role: "user", content: ordinary })
    }
  }
  return result
}

function lowerContentBlock(block: AnthropicContentBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "thinking":
      return block.thinking ? { type: "reasoning", text: block.thinking } : undefined
    case "redacted_thinking":
      // Redacted thinking has no readable text, but DeepSeek-style providers
      // reject assistant messages that omit `reasoning_content` entirely when
      // thinking is active; a space placeholder satisfies the check (same
      // approach LiteLLM uses).
      return { type: "reasoning", text: " " }
    case "image":
      if (block.source.type === "base64" && block.source.data) {
        return { type: "media", mediaType: block.source.media_type ?? "application/octet-stream", data: block.source.data }
      }
      if (block.source.type === "url" && block.source.url) {
        return { type: "media", mediaType: block.source.media_type ?? "image/*", data: block.source.url }
      }
      return undefined
    case "tool_use":
      return { type: "tool-call", id: block.id, name: block.name, input: block.input }
    case "tool_result":
      return undefined
  }
}

function lowerToolResult(block: AnthropicToolResultBlock, tools: Map<string, string>) {
  const value = block.content ?? ""
  const resultType = Array.isArray(value) ? "content" : "text"
  return ToolResultPart.make({
    id: block.tool_use_id,
    name: tools.get(block.tool_use_id) ?? "tool",
    result: block.is_error ? `Tool error: ${contentText(value)}` : value,
    resultType: block.is_error ? "text" : resultType,
  })
}

/** Append a proxy-executed tool call + result to a request for the next model turn. */
export function webSearchFollowUp(
  base: LLMRequest,
  call: { id: string; name: string; input: unknown },
  resultText: string,
  keepSearchTool = true,
): LLMRequest {
  const input = LLM.requestInput(base)
  const tools = keepSearchTool
    ? input.tools
    : input.tools?.filter((tool) => !(tool.name === "web_search"))
  return LLM.request({
    ...input,
    tools,
    messages: [
      ...base.messages,
      {
        role: "assistant",
        content: [{ type: "tool-call", id: call.id, name: call.name, input: call.input }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", id: call.id, name: call.name, result: { type: "text", value: resultText } }],
      },
    ],
  })
}

function contentText(value: string | AnthropicContentBlock[]) {
  if (typeof value === "string") return value
  return value
    .filter((item): item is Extract<AnthropicContentBlock, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

function lowerToolChoice(choice: AnthropicRequest["tool_choice"]): "auto" | "none" | "required" | { type: "tool"; name: string } | undefined {
  if (!choice) return undefined
  if (choice.type === "tool") return { type: "tool", name: choice.name }
  if (choice.type === "auto") return "auto"
  return "required"
}

/**
 * Map Claude Code's thinking budget onto the model's supported reasoning
 * efforts. Claude Code has no budget ladder for third-party models: when the
 * user picks an effort level (/effort), Claude Code converts it internally to
 * `thinking.budget_tokens` using its own per-model calibration, and that is
 * all we receive. The bands below are a wide approximation of that internal
 * calibration (roughly 5k/10k/20k/40k/80k); the goal is to land each budget in
 * the right tier of the declared options, not to match exact values.
 *
 *   3 tiers (deepseek-v4-flash: low/high/max):    <20k low, >=20k high, >=80k max
 *   4+ tiers (gpt-5.6-luna/sol: none/low/medium/high/xhigh/max):
 *     <5k none, 5k low, 10k medium, 20k high, 40k xhigh, 80k max
 *
 * A configured `mapping.reasoningEffort` is a launch default, not a hard
 * override: it applies only while `defaultEffortActive` is true (the first
 * request of a session, before the user changes /effort). Once the user
 * changes the effort, the budget is mapped live so their choice wins.
 * Unsupported efforts (e.g. "medium" on deepseek-v4-flash) are never
 * requested. Without declared options, fall back to budget thresholds.
 */
export function reasoningEffortFor(
  thinking: AnthropicRequest["thinking"],
  mapping: ResolvedMapping,
  defaultEffortActive = false,
): ReasoningEffort | undefined {
  // A configured preset is the launch default: apply it on the session's first
  // request even before Claude Code enables thinking, so the provider actually
  // receives it. It yields to the user's /effort choice once the thinking
  // budget moves out of the launch band (defaultEffortActive becomes false).
  if (mapping.reasoningEffort && defaultEffortActive) return mapping.reasoningEffort
  return budgetEffort(thinking, mapping)
}

/**
 * Map a Claude Code thinking budget onto the effort tier it selects, ignoring
 * any configured launch preset. This is the shared quantization both the
 * provider request and the session baseline use, so the launch default is
 * only withdrawn when the budget actually lands in a different effort tier
 * (the user changed /effort), not on small in-tier drift.
 */
export function budgetEffort(
  thinking: AnthropicRequest["thinking"],
  mapping: ResolvedMapping,
): ReasoningEffort | undefined {
  if (!thinking || thinking.type !== "enabled") return undefined
  const options = mapping.reasoningOptions
  const budget = thinking.budget_tokens ?? 0

  if (options && options.length > 0) {
    if (options.length >= 4) {
      const band =
        budget >= 80_000 ? 5 : budget >= 40_000 ? 4 : budget >= 20_000 ? 3 : budget >= 10_000 ? 2 : budget >= 5_000 ? 1 : 0
      return options[Math.min(band, options.length - 1)] as ReasoningEffort
    }
    if (budget >= 80_000) return options[options.length - 1] as ReasoningEffort
    if (options.length >= 3 && budget >= 20_000) return options[1] as ReasoningEffort
    return options[0] as ReasoningEffort
  }

  if (budget >= 80_000) return "high"
  if (budget >= 20_000) return "medium"
  if (budget >= 5_000) return "low"
  return "minimal"
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
