import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseJsonc } from "./json.js"
import type {
  AuthStore,
  CcocProxyConfig,
  ModelMapping,
  OpenCodeConfig,
  OpenCodeProviderConfig,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderCatalogModel,
} from "./types.js"

const DEFAULT_CATALOG_URL = "https://models.opencode.ai/api.json"
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

export interface ResolvedMapping extends ModelMapping {
  alias: string
  /** What Claude Code sees: the bare model id, without the provider prefix. */
  displayName: string
  /** Effort levels the model supports, from the catalog (effort-type options only). */
  reasoningOptions?: string[]
  /** Whether the model advertises reasoning at all. */
  reasoning?: boolean
  /** Vision support: false when the catalog declares text-only input; undefined when unknown. */
  vision?: boolean
  protocol: NonNullable<ModelMapping["protocol"]>
  baseURL?: string
  providerInfo?: ProviderCatalogEntry
  /** Routes through OpenAI's Codex backend, which rejects some Responses
   * parameters that the stock API accepts (e.g. max_output_tokens). */
  codex?: boolean
}

const cachePath = () => {
  const root = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  return join(root, "ccoc", "models.json")
}

const legacyCachePath = () => {
  const root = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  return join(root, "ccocproxy", "models.json")
}

export async function loadCatalog(options: { url?: string; refresh?: boolean } = {}): Promise<ProviderCatalog> {
  const path = cachePath()
  if (!options.refresh) {
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as { savedAt: number; catalog: ProviderCatalog }
      if (Date.now() - cached.savedAt < 24 * 60 * 60 * 1000) return cached.catalog
    } catch {
      try {
        const legacy = JSON.parse(await readFile(legacyCachePath(), "utf8")) as {
          savedAt: number
          catalog: ProviderCatalog
        }
        if (Date.now() - legacy.savedAt < 24 * 60 * 60 * 1000) return legacy.catalog
      } catch {}
    }
  }

  try {
    const response = await fetch(options.url ?? process.env.OPENCODE_MODELS_URL ?? DEFAULT_CATALOG_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const catalog = (await response.json()) as ProviderCatalog
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ savedAt: Date.now(), catalog }), { mode: 0o600 })
    return catalog
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as { catalog: ProviderCatalog }
      return cached.catalog
    } catch {
      throw new Error(`Could not load OpenCode's model catalog: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function mergeConfiguredProviders(catalog: ProviderCatalog, openCodeConfig: OpenCodeConfig): ProviderCatalog {
  const result = { ...catalog }
  for (const [id, config] of Object.entries(openCodeConfig.provider ?? {})) {
    result[id] = mergeProvider(result[id], id, config)
  }
  return result
}

function mergeProvider(
  catalog: ProviderCatalogEntry | undefined,
  id: string,
  config: OpenCodeProviderConfig,
): ProviderCatalogEntry {
  const configuredModels = Object.fromEntries(
    Object.entries(config.models ?? {}).map(([modelID, model]) => [modelID, { id: modelID, ...model }]),
  )
  return {
    ...catalog,
    id,
    npm: config.npm ?? catalog?.npm,
    api: config.options?.baseURL ?? catalog?.api,
    models: { ...catalog?.models, ...configuredModels },
  }
}

function normalizeProvider(provider: string) {
  if (provider === "openai-codex") return "openai"
  return provider
}

function inferProtocol(provider: string, npm: string | undefined, authType: string | undefined): ResolvedMapping["protocol"] {
  if (provider === "openai") return "openai-responses"
  if (provider === "openrouter") return "openrouter-chat"
  if (provider === "anthropic") return "anthropic-messages"
  if (provider === "google") return "gemini"
  if (provider === "amazon-bedrock") return "bedrock-converse"
  if (npm?.includes("@ai-sdk/openai-compatible")) return "openai-chat"
  if (npm?.includes("@ai-sdk/anthropic")) return "anthropic-messages"
  if (npm?.includes("@ai-sdk/google")) return "gemini"
  if (npm?.includes("@ai-sdk/amazon-bedrock")) return "bedrock-converse"
  if (npm?.includes("@ai-sdk/openai")) return "openai-responses"
  if (npm?.includes("openrouter")) return "openrouter-chat"
  if (authType === "oauth" && provider === "openai") return "openai-responses"
  return "openai-chat"
}

function findAuth(auth: AuthStore, provider: string) {
  const normalized = normalizeProvider(provider)
  return auth[provider] ?? auth[normalized] ?? auth[`${provider}/`] ?? auth[`${normalized}/`]
}

function modelExists(catalog: ProviderCatalogEntry | undefined, model: string) {
  return catalog?.models?.[model] !== undefined
}

function isTextModel(model: { modalities?: { output?: string[] } }) {
  return !model.modalities?.output || model.modalities.output.includes("text")
}

/**
 * Resolve a model id to a provider mapping. `target` is either an alias name
 * (from the CLI alias store), a `provider/model` pair, or a bare model id
 * found in exactly one catalog provider. Options for served models come from
 * the nested config (`config.models[provider][model]`, validated at load).
 * The resolved mapping's `alias` is the alias name when one was used, else
 * `provider/model`.
 */
export function resolveMapping(
  target: string,
  config: CcocProxyConfig,
  catalog: ProviderCatalog,
  openCodeConfig: OpenCodeConfig,
  auth: AuthStore,
  aliases: Readonly<Record<string, string>> = {},
): ResolvedMapping {
  const models = config.models ?? {}
  const aliasTarget = aliases[target]
  let provider: string
  let model: string
  let alias = target
  if (aliasTarget !== undefined) {
    const slash = aliasTarget.indexOf("/")
    if (slash < 1 || slash === aliasTarget.length - 1) {
      throw new Error(`Alias '${target}' must point at provider/model, got '${aliasTarget}'`)
    }
    provider = normalizeProvider(aliasTarget.slice(0, slash))
    model = aliasTarget.slice(slash + 1)
  } else {
    const slash = target.indexOf("/")
    if (slash > 0) {
      provider = normalizeProvider(target.slice(0, slash))
      model = target.slice(slash + 1)
    } else {
      const matches = Object.entries(catalog).filter(([, providerEntry]) => modelExists(providerEntry, target))
      if (matches.length !== 1) {
        if (matches.length === 0) throw new Error(`Unknown model '${target}'. Use provider/model or define an alias.`)
        throw new Error(`Model '${target}' exists in multiple providers; use provider/${target}.`)
      }
      provider = normalizeProvider(matches[0]![0])
      model = target
    }
  }
  const configured = models[provider]?.[model]
  const mapping: ModelMapping = {
    provider,
    model,
    protocol: configured?.protocol,
    baseURL: configured?.baseURL,
    authProvider: configured?.authProvider,
    reasoningEffort: configured?.reasoningEffort,
    headers: configured?.headers,
    clientAuth: configured?.clientAuth,
  }

  const providerInfo = catalog[provider]
  const providerConfig = openCodeConfig.provider?.[provider] ?? openCodeConfig.provider?.[mapping.provider]
  const providerAuth = mapping.authProvider ?? provider
  const credential = findAuth(auth, providerAuth)
  const protocol = mapping.protocol ?? inferProtocol(provider, providerConfig?.npm ?? providerInfo?.npm, credential?.type)

  let baseURL = mapping.baseURL ?? providerConfig?.options?.baseURL ?? providerInfo?.api
  const codex = provider === "openai" && credential?.type === "oauth"
  if (codex) baseURL = CODEX_BASE_URL
  if (protocol === "openai-responses" && !baseURL) baseURL = "https://api.openai.com/v1"
  if (protocol === "openai-chat" && !baseURL) baseURL = providerInfo?.api
  if (protocol === "anthropic-messages" && !baseURL) baseURL = "https://api.anthropic.com/v1"
  if (protocol === "gemini" && !baseURL) baseURL = "https://generativelanguage.googleapis.com/v1beta"
  if (protocol === "openrouter-chat" && !baseURL) baseURL = "https://openrouter.ai/api/v1"

  const headers = {
    ...(providerConfig?.options?.headers ?? {}),
    ...(mapping.headers ?? {}),
  }

  const reasoningOptions = effortOptions(providerInfo?.models?.[mapping.model]?.reasoning_options)
  const reasoning = providerInfo?.models?.[mapping.model]?.reasoning === true
  const modalities = providerInfo?.models?.[mapping.model]?.modalities?.input
  const vision = modalities === undefined ? undefined : modalities.includes("image")

  return {
    ...mapping,
    alias,
    displayName: mapping.model,
    provider,
    protocol,
    baseURL,
    headers,
    providerInfo,
    reasoning,
    vision,
    reasoningOptions,
    codex,
  }
}

function effortOptions(options: ProviderCatalogModel["reasoning_options"]): string[] | undefined {
  const effort = options?.find((option) => option.type === "effort")
  const values = effort?.values
  return values && values.length > 0 ? [...values] : undefined
}

export function connected(provider: ProviderCatalogEntry, auth: AuthStore) {
  return Boolean(
    Object.keys(auth).some((key) => normalizeProvider(key) === normalizeProvider(provider.id)) ||
      provider.env?.some((name) => Boolean(process.env[name])),
  )
}

export function supportedProvider(provider: ProviderCatalogEntry) {
  return [
    provider.id === "openai",
    provider.id === "openrouter",
    provider.id === "anthropic",
    provider.id === "google",
    provider.id === "amazon-bedrock",
    provider.npm?.includes("@ai-sdk/openai-compatible"),
    provider.npm?.includes("@ai-sdk/openai"),
    provider.npm?.includes("@ai-sdk/anthropic"),
    provider.npm?.includes("@ai-sdk/google"),
  ].some(Boolean)
}

export function listConnectedModels(catalog: ProviderCatalog, auth: AuthStore) {
  return Object.values(catalog)
    .filter((provider) => connected(provider, auth) && supportedProvider(provider))
    .flatMap((provider) =>
      Object.values(provider.models ?? {}).filter(isTextModel).map((model) => ({
        provider: provider.id,
        providerName: provider.name ?? provider.id,
        model: model.id,
        modelName: model.name ?? model.id,
        reasoning: model.reasoning === true,
        tools: model.tool_call === true,
      })),
    )
}

/** Models offered to the served-model picker: everything opencode can reach —
 * models from connected providers (auth/env) PLUS models from providers
 * explicitly configured in opencode.json even without auth (e.g. a local vLLM
 * endpoint). For a provider configured with an explicit model list, both the
 * configured models and any catalog models for that provider count; deduped. */
export function listPickableModels(
  catalog: ProviderCatalog,
  auth: AuthStore,
  openCodeConfig: OpenCodeConfig,
) {
  const seen = new Set<string>()
  const out: Array<{
    provider: string
    providerName: string
    model: string
    modelName: string
    reasoning: boolean
    tools: boolean
  }> = []
  const push = (provider: ProviderCatalogEntry, model: ProviderCatalogModel) => {
    const key = `${provider.id}/${model.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      provider: provider.id,
      providerName: provider.name ?? provider.id,
      model: model.id,
      modelName: model.name ?? model.id,
      reasoning: model.reasoning === true,
      tools: model.tool_call === true,
    })
  }
  for (const provider of Object.values(catalog)) {
    if (!supportedProvider(provider)) continue
    const configuredModels = openCodeConfig.provider?.[provider.id]?.models
    if (configuredModels) {
      for (const [modelID, model] of Object.entries(configuredModels)) {
        const modelName = typeof model.name === "string" ? model.name : modelID
        seen.add(`${provider.id}/${modelID}`)
        out.push({
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          model: modelID,
          modelName,
          reasoning: model.reasoning === true,
          tools: model.tool_call === true,
        })
      }
    }
    // catalog models for connected providers (or configured-but-no-explicit-list)
    if (connected(provider, auth)) {
      for (const model of Object.values(provider.models ?? {})) {
        if (isTextModel(model)) push(provider, model)
      }
    }
  }
  return out
}
