import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseJsonc } from "./json.js"
import type { CcocProxyConfig, OpenCodeConfig } from "./types.js"

const exists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readConfigFile<T>(path: string, source: string): Promise<T | undefined> {
  if (!(await exists(path))) return undefined
  return parseJsonc<T>(await readFile(path, "utf8"), source)
}

function mergeCcocConfig(base: CcocProxyConfig, next: CcocProxyConfig): CcocProxyConfig {
  return {
    ...base,
    ...next,
    models: { ...base.models, ...next.models },
  }
}

/**
 * Strictly check the served-models shape: `{ provider: { model: { options } } }`
 * (like opencode.json). No legacy formats are accepted — this proxy has only
 * ever run on this machine, so a wrong shape is a real config bug and should
 * refuse to start instead of being silently migrated or misread.
 */
export function validateModels(models: unknown): void {
  if (models === undefined || models === null) return
  if (typeof models !== "object" || Array.isArray(models)) {
    throw new Error(
      "ccoc config 'models' must be an object keyed by provider: { \"provider\": { \"model\": { ... } } } (like opencode.json)",
    )
  }
  for (const [provider, providerModels] of Object.entries(models as Record<string, unknown>)) {
    if (typeof providerModels !== "object" || providerModels === null || Array.isArray(providerModels)) {
      throw new Error(
        `ccoc config 'models.${provider}' must be an object of model ids, got ${describeConfigValue(providerModels)}`,
      )
    }
    for (const [model, options] of Object.entries(providerModels as Record<string, unknown>)) {
      if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw new Error(
          `ccoc config 'models.${provider}.${model}' must be an object of options, got ${describeConfigValue(options)}`,
        )
      }
      if ("provider" in options || "model" in options) {
        throw new Error(
          `ccoc config 'models.${provider}.${model}' is the old flat format: the provider and model belong in the keys ` +
            `(models["${provider}"]["${model}"]), not in the options`,
        )
      }
    }
  }
}

function describeConfigValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return "an array"
  if (value === null) return "null"
  return String(value)
}

export async function loadCcocConfig(explicitPath?: string): Promise<CcocProxyConfig> {
  if (explicitPath) {
    return (await readConfigFile<CcocProxyConfig>(explicitPath, explicitPath)) ?? {}
  }

  const globalDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ccoc")
  const legacyGlobalDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ccocproxy")
  const candidates = [
    join(globalDir, "config.json"),
    join(process.cwd(), "ccoc.json"),
    join(process.cwd(), "ccoc.local.json"),
    join(legacyGlobalDir, "config.json"),
    join(process.cwd(), "ccocproxy.json"),
    join(process.cwd(), "ccocproxy.local.json"),
  ]
  let config: CcocProxyConfig = {}
  for (const path of candidates) {
    const next = await readConfigFile<CcocProxyConfig>(path, path)
    if (next) config = mergeCcocConfig(config, next)
  }
  return config
}

export async function loadOpenCodeConfig(): Promise<OpenCodeConfig> {
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    return parseJsonc<OpenCodeConfig>(process.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT")
  }

  const configuredPath = process.env.OPENCODE_CONFIG
  if (configuredPath) return (await readConfigFile<OpenCodeConfig>(configuredPath, configuredPath)) ?? {}

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const candidates = [
    join(process.cwd(), "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(configHome, "opencode", "opencode.json"),
    join(configHome, "opencode", "opencode.jsonc"),
  ]
  for (const path of candidates) {
    const config = await readConfigFile<OpenCodeConfig>(path, path)
    if (config) return config
  }
  return {}
}

export const authPath = () =>
  process.env.OPENCODE_AUTH_FILE ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")

export const configPath = () =>
  process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "ccoc", "config.json") : join(homedir(), ".config", "ccoc", "config.json")

/** Persist the ccoc config to the global config path (used by the served-model
 * picker and first-run setup). Writes in place rather than rename-replacing so
 * it still works when the file is open in an editor (Windows locks the old
 * name, making rename fail with EPERM). Preserves any unrelated file content. */
export async function saveCcocConfig(config: CcocProxyConfig, explicitPath?: string): Promise<string> {
  const path = explicitPath ?? configPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  return path
}
