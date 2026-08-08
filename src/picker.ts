import { search } from "@inquirer/prompts"
import type { AliasStore } from "./aliases.js"
import { listConnectedModels, listPickableModels } from "./catalog.js"
import { serveModelsPrompt } from "./serve-models-prompt.js"
import type { AuthStore, CcocProxyConfig, OpenCodeConfig, ProviderCatalog } from "./types.js"

export interface ModelChoice {
  name: string
  value: string
  description?: string
}

export function buildModelChoices(
  config: CcocProxyConfig,
  catalog: ProviderCatalog,
  auth: AuthStore,
  aliases: AliasStore = {},
): ModelChoice[] {
  const aliasChoices: ModelChoice[] = Object.entries(aliases).map(([name, target]) => ({
    name: `${name}  →  ${target}`,
    value: name,
    description: "configured alias",
  }))

  const connected = listConnectedModels(catalog, auth)
  const connectedValues = new Set(connected.map((item) => `${item.provider}/${item.model}`))
  const configuredChoices: ModelChoice[] = Object.entries(config.models ?? {})
    .flatMap(([provider, providerModels]) =>
      Object.keys(providerModels).map((model) => ({ provider, model })),
    )
    .filter(({ provider, model }) => !connectedValues.has(`${provider}/${model}`))
    .map(({ provider, model }) => ({
      name: `${provider}/${model}`,
      value: `${provider}/${model}`,
      description: "configured",
    }))

  const modelChoices: ModelChoice[] = connected.map((item) => ({
    name: `${item.provider}/${item.model}`,
    value: `${item.provider}/${item.model}`,
    description: `${item.modelName}${item.reasoning ? " · reasoning" : ""}${item.tools ? " · tools" : ""}`,
  }))

  return [...aliasChoices, ...configuredChoices, ...modelChoices]
}

export function filterModelChoices(choices: ModelChoice[], input: string) {
  const query = input.trim().toLowerCase()
  if (query.length === 0) return choices
  return choices.filter((choice) => {
    const haystack = `${choice.name} ${choice.value} ${choice.description ?? ""}`.toLowerCase()
    return query.split(/\s+/).every((part) => haystack.includes(part))
  })
}

export async function pickModel(
  config: CcocProxyConfig,
  catalog: ProviderCatalog,
  auth: AuthStore,
  aliases: AliasStore = {},
): Promise<string> {
  const choices = buildModelChoices(config, catalog, auth, aliases)
  const answer = await search({
    message: "Select a model for Claude Code",
    pageSize: 12,
    source: async (input) => filterModelChoices(choices, input ?? ""),
  })
  return answer
}

/**
 * Interactive multi-select of models to serve from the gateway, drawn from
 * everything opencode can reach (connected providers plus configured
 * no-auth providers like a local vLLM). Includes an inline id-form toggle
 * (Tab switches `slug` ⇄ `provider`). Returns the chosen `provider/model`
 * values and the display mode; the config stores them as `models[provider][model]`
 * (like opencode.json).
 */
export async function pickServedModels(
  catalog: ProviderCatalog,
  auth: AuthStore,
  openCodeConfig: OpenCodeConfig,
  current: CcocProxyConfig["models"] = {},
  currentDisplay: "slug" | "provider" = "slug",
): Promise<{ models: string[]; modelDisplay: "slug" | "provider" }> {
  const configured = new Set<string>()
  for (const [provider, providerModels] of Object.entries(current)) {
    for (const model of Object.keys(providerModels)) configured.add(`${provider}/${model}`)
  }
  const items = listPickableModels(catalog, auth, openCodeConfig)
  if (items.length === 0) {
    throw new Error(
      "No models available to serve. Configure providers in opencode.json (opencode config) or run 'opencode auth login' first.",
    )
  }
  return serveModelsPrompt({
    message: "Select models to serve from the gateway (type to filter, space toggles, Tab id form, enter confirms)",
    initialDisplay: currentDisplay,
    choices: items
      .map((item) => ({
        value: `${item.provider}/${item.model}`,
        name: `${item.provider}/${item.model}`,
        description: item.modelName !== item.model ? item.modelName : undefined,
        checked: configured.has(`${item.provider}/${item.model}`),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}
