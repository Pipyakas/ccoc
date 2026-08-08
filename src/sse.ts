import type { LLMEvent, LLMResponse } from "@opencode-ai/llm/schema"

export interface SseMessageOptions {
  id: string
  model: string
}

interface OpenBlock {
  id: string
  index: number
  type: "text" | "thinking" | "tool_use"
}

export class AnthropicStreamEncoder {
  private nextIndex = 0
  private readonly blocks = new Map<string, OpenBlock>()
  private readonly streamedTools = new Set<string>()
  private stopped = false

  constructor(private readonly options: SseMessageOptions) {}

  start() {
    return [
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.options.id,
          type: "message",
          role: "assistant",
          content: [],
          model: this.options.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      sse("ping", { type: "ping" }),
    ]
  }

  accept(event: LLMEvent): string[] {
    if (this.stopped) return []
    switch (event.type) {
      case "text-start":
        return this.startBlock(event.id, "text", { type: "text", text: "" })
      case "text-delta":
        return this.delta(event.id, { type: "text_delta", text: event.text })
      case "text-end":
        return this.stopBlock(event.id)
      case "reasoning-start":
        return this.startBlock(event.id, "thinking", { type: "thinking", thinking: "" })
      case "reasoning-delta":
        return this.delta(event.id, { type: "thinking_delta", thinking: event.text })
      case "reasoning-end":
        return this.stopBlock(event.id)
      case "tool-input-start":
        this.streamedTools.add(event.id)
        return this.startBlock(event.id, "tool_use", { type: "tool_use", id: event.id, name: event.name, input: {} })
      case "tool-input-delta":
        return this.delta(event.id, { type: "input_json_delta", partial_json: event.text })
      case "tool-input-end":
        return this.stopBlock(event.id)
      case "tool-call":
        // A provider may emit a tool call twice: once as streaming
        // tool-input-start/delta/end (already rendered as a content block) and
        // once as a final tool-call event. Only render a second block when the
        // tool was never streamed, otherwise Claude Code sees duplicate tool_use
        // blocks and executes its own tool instead of trusting the proxy's
        // injected result (e.g. WebSearch reporting "Did 0 searches").
        if (this.blocks.has(event.id) || this.streamedTools.has(event.id)) return []
        return [
          ...this.startBlock(event.id, "tool_use", {
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          }),
          ...this.delta(event.id, { type: "input_json_delta", partial_json: JSON.stringify(event.input) }),
          ...this.stopBlock(event.id),
        ]
      case "finish":
        return this.finish(event.reason, event.usage?.outputTokens ?? 0)
      case "provider-error":
        return [
          ...this.closeOpenBlocks(),
          sse("error", {
            type: "error",
            error: { type: "api_error", message: event.message },
          }),
          sse("message_stop", { type: "message_stop" }),
        ]
      default:
        return []
    }
  }

  fail(message: string) {
    if (this.stopped) return []
    this.stopped = true
    return [
      ...this.closeOpenBlocks(),
      sse("error", { type: "error", error: { type: "api_error", message } }),
      sse("message_stop", { type: "message_stop" }),
    ]
  }

  /** Terminate the message as a normal end_turn. Used when the upstream stream
   * closes without a finish signal (some providers omit finish_reason and the
   * [DONE] sentinel), so Claude Code never sees a truncated HTTP 200. */
  end(): string[] {
    if (this.stopped) return []
    return this.finish("end_turn", 0)
  }

  /** Emit a synthetic tool_result block (e.g. results of a proxy-executed web search). */
  toolResult(toolUseId: string, text: string) {
    const index = this.nextIndex++
    return [
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ]
  }

  /** Emit a `server_tool_use` block, matching how Anthropic reports a server-side
   * tool (e.g. web_search) executing. Claude Code renders this as a server tool
   * and does NOT try to run its own search for it. */
  serverToolUse(id: string, name: string, input: Record<string, unknown>) {
    const index = this.nextIndex++
    return [
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "server_tool_use", id, name, input },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ]
  }

  /** Emit a `web_search_tool_result` block in Anthropic's exact shape, so Claude
   * Code renders the proxy-run search results the same way it would if Anthropic
   * executed them. Each result carries title/url/snippet; the snippet is sent
   * as `encrypted_content` (a plaintext string is accepted as-is). */
  webSearchToolResult(toolUseId: string, results: Array<{ title: string; url: string; snippet: string }>) {
    const index = this.nextIndex++
    const content = results.map((result) => ({
      type: "web_search_result",
      title: result.title,
      url: result.url,
      encrypted_content: result.snippet,
    }))
    return [
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "web_search_tool_result", tool_use_id: toolUseId, content },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ]
  }

  /** Allow another model turn to keep writing to this message (used by the web-search loop). */
  resume() {
    this.stopped = false
  }

  private startBlock(id: string, type: OpenBlock["type"], contentBlock: Record<string, unknown>) {
    const existing = this.blocks.get(id)
    if (existing) return []
    const block = { id, index: this.nextIndex++, type }
    this.blocks.set(id, block)
    return [sse("content_block_start", { type: "content_block_start", index: block.index, content_block: contentBlock })]
  }

  private delta(id: string, delta: Record<string, unknown>) {
    const block = this.blocks.get(id)
    if (!block) return []
    return [sse("content_block_delta", { type: "content_block_delta", index: block.index, delta })]
  }

  private stopBlock(id: string) {
    const block = this.blocks.get(id)
    if (!block) return []
    this.blocks.delete(id)
    return [sse("content_block_stop", { type: "content_block_stop", index: block.index })]
  }

  private closeOpenBlocks() {
    return [...this.blocks.values()].flatMap((block) => this.stopBlock(block.id))
  }

  private finish(reason: string, outputTokens: number) {
    const result = [
      ...this.closeOpenBlocks(),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(reason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sse("message_stop", { type: "message_stop" }),
    ]
    this.stopped = true
    return result
  }
}

export function responseToAnthropic(response: LLMResponse, model: string, id: string) {
  const content = response.message.content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text") return [{ type: "text", text: part.text }]
    if (part.type === "reasoning") return [{ type: "thinking", thinking: part.text }]
    if (part.type === "tool-call") return [{ type: "tool_use", id: part.id, name: part.name, input: part.input }]
    return []
  })
  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason(response.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
    },
  }
}

function stopReason(reason: string) {
  if (reason === "tool-calls") return "tool_use"
  if (reason === "length") return "max_tokens"
  if (reason === "content-filter") return "refusal"
  if (reason === "error") return "stop_sequence"
  return "end_turn"
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
