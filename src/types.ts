export type Protocol =
  | "openai-responses"
  | "openai-chat"
  | "openrouter-chat"
  | "anthropic-messages"
  | "gemini"
  | "bedrock-converse"

export interface ModelMapping {
  provider: string
  model: string
  protocol?: Protocol
  baseURL?: string
  authProvider?: string
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  headers?: Record<string, string>
  /** Require the client's own API key (ANTHROPIC_AUTH_TOKEN -> x-api-key) for
   * this model instead of the gateway's stored credentials. Used for
   * key-per-user providers so every client — local or remote —
   * authenticates with its own key. */
  clientAuth?: boolean
}

/** Per-model options in the ccoc config, keyed by provider then model id —
 * `models["opencode-go"]["deepseek-v4-flash"] = { reasoningEffort: "max" }`.
 * Provider and model come from the keys, so the id is unambiguous by
 * construction and no hand-made alias slugs are needed. */
export interface ServedModelConfig {
  protocol?: Protocol
  baseURL?: string
  authProvider?: string
  reasoningEffort?: ModelMapping["reasoningEffort"]
  headers?: Record<string, string>
  clientAuth?: boolean
}

export interface WebSearchConfig {
  backend?: "ddg" | "brave" | "exa" | "parallel"
  apiKey?: string
  maxTurns?: number
}

export interface CcocProxyConfig {
  default?: string
  port?: number
  /** Bind address for the gateway. Defaults to 127.0.0.1 (local clients);
   * set to "0.0.0.0" when the gateway is shared on a LAN. */
  host?: string
  /** Spawn the system-tray monitor with `serve`. Default true; set false on an
   * always-on server that does not need the tray icon. */
  tray?: boolean
  catalogURL?: string
  webSearch?: false | WebSearchConfig
  /** How model ids are advertised to Claude Code: "slug" (default,
   * `anthropic-<model>`; falls back to provider-qualified ids for models
   * served by several providers) or "provider" (`anthropic-<provider>/<model>`). */
  modelDisplay?: "slug" | "provider"
  /** Provider definitions (like opencode.json's `provider` block). Used when
   * the gateway machine has no opencode install/config of its own, so ccoc is
   * self-contained: { "providers": { "acme": { "npm": ..., "options": ..., "models": {...} } } }. */
  providers?: Record<string, OpenCodeProviderConfig>
  /** Served models, keyed by provider then model id (like opencode.json):
   * `{ "opencode-go": { "deepseek-v4-flash": { "reasoningEffort": "max" } } }`. */
  models?: Record<string, Record<string, ServedModelConfig>>
}

export interface ProviderCatalogModel {
  id: string
  name?: string
  reasoning?: boolean
  reasoning_options?: Array<{ type: string; values?: string[]; max?: number }>
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
}

export interface ProviderCatalogEntry {
  id: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  models?: Record<string, ProviderCatalogModel>
}

export type ProviderCatalog = Record<string, ProviderCatalogEntry>

export interface OpenCodeProviderConfig {
  npm?: string
  options?: {
    baseURL?: string
    apiKey?: string
    headers?: Record<string, string>
    [key: string]: unknown
  }
  models?: Record<string, Record<string, unknown>>
}

export interface OpenCodeConfig {
  provider?: Record<string, OpenCodeProviderConfig>
  [key: string]: unknown
}

export interface ApiAuth {
  type: "api"
  key: string
  metadata?: Record<string, string>
}

export interface OAuthAuth {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export interface WellKnownAuth {
  type: "wellknown"
  key: string
  token: string
}

export type AuthInfo = ApiAuth | OAuthAuth | WellKnownAuth
export type AuthStore = Record<string, AuthInfo>

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64" | "url"
    media_type?: string
    data?: string
    url?: string
  }
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
}

export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking"
  thinking?: string
  data?: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export interface AnthropicMessageInput {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export interface AnthropicToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessageInput[]
  system?: string | AnthropicContentBlock[]
  tools?: AnthropicToolDefinition[]
  tool_choice?:
    | { type: "auto" | "any" }
    | { type: "tool"; name: string }
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number }
  metadata?: Record<string, unknown>
  [key: string]: unknown
}
