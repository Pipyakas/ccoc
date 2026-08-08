import { spawn } from "cross-spawn"
import { createRequire } from "node:module"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { loadAliases, saveAliases, validAliasName, validAliasTarget, type AliasStore } from "./aliases.js"
import { installWrapper, removeWrapper, wrapperDir } from "./wrapper.js"
import { loadAuthStore } from "./auth.js"
import {
  listConnectedModels,
  loadCatalog,
  mergeConfiguredProviders,
  resolveMapping,
  type ResolvedMapping,
} from "./catalog.js"
import { authPath, configPath, loadCcocConfig, loadOpenCodeConfig, saveCcocConfig, validateModels } from "./config.js"
import { pickModel, pickServedModels } from "./picker.js"
import { gatewayModelEntries, gatewayModelId, listenProxy } from "./server.js"
import { spawnSync } from "./spawn.js"
import { loadLastModel, saveLastModel, settingsOverlayPath, stateHomePath } from "./state.js"
import type { CcocProxyConfig, ProviderCatalog } from "./types.js"

const version = createRequire(import.meta.url)("../package.json").version

interface Arguments {
  command?: "models" | "doctor" | "serve" | "update" | "alias" | "unalias" | "install-service" | "uninstall-service" | "tray"
  model?: string
  filter?: string
  port?: number
  tray?: boolean
  interactive?: boolean
  config?: string
  refresh?: boolean
  claudeArgs: string[]
}

interface LaunchContext {
  args: Arguments
  config: CcocProxyConfig
  aliases: AliasStore
  catalog: ProviderCatalog
  openCodeConfig: Awaited<ReturnType<typeof loadOpenCodeConfig>>
  auth: Awaited<ReturnType<typeof loadAuthStore>>
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv)
  if (args.command === "doctor") {
    await doctorCommand()
    return
  }
  if (args.command === "update") {
    await updateCommand()
    return
  }
  if (args.command === "alias" || args.command === "unalias") {
    await aliasCommand(args)
    return
  }
  if (args.command === "install-service" || args.command === "uninstall-service") {
    await serviceCommand(args)
    return
  }
  if (args.command === "tray") {
    await trayCommand()
    return
  }

  const context = await loadContext(args)
  if (args.command === "models" && !process.stdout.isTTY) {
    await printModelList(context, args)
    return
  }
  if (args.command === "models" && process.stdout.isTTY) {
    await chooseServedModelsCommand(context)
    return
  }
  if (args.command === "serve") {
    if (totalConfiguredModels(context.config.models) === 0) {
      if (!process.stdout.isTTY) {
        throw new Error("No models configured. Run 'ccoc models' in a terminal to pick models to serve.")
      }
      await chooseServedModelsCommand(context)
      // reload so the saved models are picked up
      context.config.models = (await loadCcocConfig(context.args.config)).models ?? {}
      if (totalConfiguredModels(context.config.models) === 0) {
        process.stdout.write("Nothing to serve. Run 'ccoc models' again to pick models.\n")
        return
      }
    }
    const target = await resolveTarget(args, context)
    await launch(target, context)
    return
  }
  // Bare `ccoc` (no command, no model): manage the gateway.
  if (args.command === undefined && args.model === undefined && !args.interactive) {
    await ccocCommand(context)
    return
  }
  // The single-model launcher (`ccoc <model>` / `-m`, which wrapped Claude
  // Code around one model) is removed: ccoc is a gateway now.
  process.stderr.write(
    "ccoc no longer launches Claude Code with a single model.\n" +
      "Run 'ccoc' to manage the gateway, 'ccoc models' to pick served models, or 'claude' directly.\n",
  )
  process.exitCode = 1
  return
}

/**
 * Bare `ccoc`: manage the gateway interactively. If a gateway is already
 * running, offer to change the served models; otherwise start one (with the
 * tray icon) and offer to install the logon service for persistence.
 */
async function ccocCommand(context: LaunchContext) {
  const port = context.args.port ?? context.config.port ?? DEFAULT_GATEWAY_PORT
  if (!process.stdout.isTTY) {
    process.stderr.write(
      `ccoc: this is an interactive command. Use 'ccoc serve' to start the gateway on port ${port}.\n`,
    )
    process.exitCode = 1
    return
  }
  const { confirm } = await import("@inquirer/prompts")
  if (await gatewayRunning(port)) {
    process.stdout.write(`ccoc gateway is running on port ${port}.\n`)
    const change = await confirm({ message: "Change the served models?", default: false })
    if (change) {
      await chooseServedModelsCommand(context)
      process.stdout.write("Gateway restarted with the new model list.\n")
    }
    return
  }

  process.stdout.write(`Starting the ccoc gateway on port ${port}...\n`)
  const binPath = fileURLToPath(new URL("../bin/ccoc.cjs", import.meta.url))
  const launch =
    `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' ` +
    `-ArgumentList '${binPath}','serve','--port','${port}'`
  spawnSync("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", launch], { stdio: "ignore" })
  if (!(await waitForGateway(port, true))) {
    process.stderr.write(`ccoc: the gateway did not come up on port ${port}. Check the config.\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`Gateway is running on port ${port} (tray icon shown).\n`)
  const install = await confirm({
    message: "Install a user-level service so the gateway starts at every logon?",
    default: false,
  })
  if (install) {
    await serviceCommand({ ...context.args, command: "install-service" })
  }
}

/** `ccoc models`: interactive multi-select of the models the gateway serves,
 * written to the ccoc config as `models[provider][model]`, exactly like
 * opencode.json is organized. */
async function chooseServedModelsCommand(context: LaunchContext) {
  const port = context.args.port ?? context.config.port ?? DEFAULT_GATEWAY_PORT
  // Detect a running gateway while the user is still choosing models, so the
  // restart after confirming does not have to wait on discovery.
  const runningDetection = gatewayRunning(port)
  const { models, modelDisplay } = await pickServedModels(
    context.catalog,
    context.auth,
    context.openCodeConfig,
    context.config.models,
    context.config.modelDisplay === "provider" ? "provider" : "slug",
  )
  const current = context.config.models ?? {}
  const configured: NonNullable<CcocProxyConfig["models"]> = {}
  for (const value of models) {
    const slash = value.indexOf("/")
    if (slash < 1 || slash === value.length - 1) continue
    const provider = value.slice(0, slash)
    const model = value.slice(slash + 1)
    configured[provider] ??= {}
    // keep per-model options (reasoningEffort etc.) when re-selecting
    configured[provider]![model] = { ...current[provider]?.[model] }
  }
  const saved: CcocProxyConfig = { ...context.config, modelDisplay, models: configured }
  const path = await saveCcocConfig(saved, context.args.config)
  const count = totalConfiguredModels(configured)
  process.stdout.write(`Saved ${count} served model(s) to ${path}.\n`)
  process.stdout.write(
    `Model ids: ${modelDisplay} (${modelDisplay === "provider" ? "anthropic-<provider>/<model>" : "anthropic-<model>"}).\n`,
  )
  if (count === 0) {
    process.stdout.write("Nothing to serve. Run 'ccoc models' again to pick models.\n")
    return
  }
  // Keep Claude Code's model cache in sync with the new list right away (it is
  // normally refreshed only when the gateway restarts).
  const cacheContext: LaunchContext = { ...context, config: saved }
  try {
    const state = await repairGatewayModelCache(
      buildServedMappings(cacheContext),
      saved.port ?? DEFAULT_GATEWAY_PORT,
      modelDisplay,
    )
    process.stdout.write(
      state === "current"
        ? "Claude Code model cache is up to date.\n"
        : "Claude Code model cache updated to match.\n",
    )
  } catch (cacheError) {
    process.stderr.write(
      `ccoc: could not update Claude Code model cache (${cacheError instanceof Error ? cacheError.message : String(cacheError)}). ` +
        "It will be refreshed when the gateway restarts.\n",
    )
  }
  // Restart the gateway automatically so the new list applies immediately.
  const restartPort = context.args.port ?? saved.port ?? DEFAULT_GATEWAY_PORT
  try {
    if (await runningDetection) {
      process.stdout.write(`Restarting the gateway on port ${restartPort}...\n`)
      await restartGateway(restartPort)
      process.stdout.write(`Gateway restarted on port ${restartPort} with the new model list.\n`)
    } else {
      process.stdout.write(`Gateway is not running on port ${restartPort}; start it with 'ccoc serve'.\n`)
    }
  } catch (restartError) {
    process.stderr.write(
      `ccoc: could not restart the gateway (${restartError instanceof Error ? restartError.message : String(restartError)}). ` +
        "Restart it with 'ccoc serve'.\n",
    )
  }
}

function totalConfiguredModels(models: CcocProxyConfig["models"]): number {
  let total = 0
  for (const providerModels of Object.values(models ?? {})) total += Object.keys(providerModels).length
  return total
}

async function loadContext(args: Arguments): Promise<LaunchContext> {
  const loaded = await loadCcocConfig(args.config)
  // `ccoc models` must still run on a bad config so it can fix it; everything
  // else (serve, launch) refuses to start on a malformed models section.
  if (args.command !== "models") validateModels(loaded.models)
  const config: CcocProxyConfig = {
    ...loaded,
  }
  // A self-contained gateway install: when the ccoc config carries its own
  // provider definitions (no opencode install/config on this machine), those
  // win over any discovered opencode config.
  const openCodeConfig = config.providers ? { provider: config.providers } : await loadOpenCodeConfig()
  const auth = await loadAuthStore()
  let catalog: ProviderCatalog = {}
  try {
    catalog = mergeConfiguredProviders(await loadCatalog({ url: config.catalogURL, refresh: args.refresh }), openCodeConfig)
  } catch (error) {
    if (!args.interactive && !args.model && !config.default) throw error
    process.stderr.write(`Warning: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return { args, config, aliases: await loadAliases(), catalog, openCodeConfig, auth }
}

async function resolveTarget(args: Arguments, context: LaunchContext): Promise<string> {
  if (args.model) return args.model

  if (args.interactive || args.command === "models") {
    if (!process.stdout.isTTY) {
      throw new Error("Interactive picker needs a terminal. Run `ccoc <provider>/<model>` directly instead.")
    }
    return pickModel(context.config, context.catalog, context.auth)
  }

  const last = await loadLastModel()
  if (last) {
    try {
      resolveMapping(last, context.config, context.catalog, context.openCodeConfig, context.auth, context.aliases)
      return last
    } catch {
      // stale/ambiguous last model (e.g. a bare slug saved before the
      // provider/model config format); fall through to the default
    }
  }

  const fallback = context.config.default ?? firstConfiguredModel(context.config.models)
  if (fallback) return fallback

  if (!process.stdout.isTTY) throw new Error("No model selected yet. Run `ccoc -m` to choose one.")

  return pickModel(context.config, context.catalog, context.auth, context.aliases)
}

/** First served model as `provider/model`, for the default fallback. */
function firstConfiguredModel(models: CcocProxyConfig["models"]): string | undefined {
  for (const [provider, providerModels] of Object.entries(models ?? {})) {
    const first = Object.keys(providerModels)[0]
    if (first) return `${provider}/${first}`
  }
  return undefined
}

/** Claude Code caches the gateway's `/v1/models` response in
 * `~/.claude/cache/gateway-models.json` and only refreshes it via discovery on
 * launch — and it skips discovery entirely when an OAuth subscription login is
 * active. The gateway therefore writes the cache itself at startup so Claude
 * Code always reads the current model list, and verifies the written file so a
 * stale/missing cache is caught before claude launches (instead of silently
 * showing the wrong or empty model list). Throws if the cache cannot be
 * written or does not round-trip correctly. */
export async function ensureGatewayModelCache(
  mappings: ReadonlyMap<string, ResolvedMapping>,
  port: number,
  modelDisplay: "slug" | "provider" = "slug",
) {
  const path = gatewayCachePath()
  const entries = gatewayModelEntries(mappings, modelDisplay).map(({ id, display_name }) => ({ id, display_name }))
  const payload = {
    baseUrl: `http://127.0.0.1:${port}`,
    fetchedAt: Date.now(),
    models: entries,
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 })
  // Verify the written cache round-trips and lists every expected model; if it
  // does not, fail the launch rather than hand Claude Code a broken model list.
  const { readFile } = await import("node:fs/promises")
  const written = JSON.parse(await readFile(path, "utf8")) as { models?: Array<{ id?: string }> }
  const writtenIds = new Set((written.models ?? []).map((model) => model.id))
  const missing = entries.filter((entry) => typeof entry.id === "string" && !writtenIds.has(entry.id))
  if (missing.length > 0) {
    throw new Error(`Gateway model cache verification failed; missing: ${missing.map((entry) => entry.id).join(", ")}`)
  }
}

function gatewayCachePath() {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, "cache")
    : join(homedir(), ".claude", "cache")
  return join(root, "gateway-models.json")
}

/** Whether a gateway is answering on the given port. */
export async function gatewayRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForGateway(port: number, up: boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await gatewayRunning(port)) === up) return true
    await sleep(250)
  }
  return false
}

/**
 * Stop the gateway currently listening on `port` and relaunch it hidden (the
 * same PowerShell Start-Process used at logon), then wait until it answers
 * again. Stop, tray cleanup, and relaunch run in a single PowerShell call so
 * the restart is quick. Throws if the gateway cannot be stopped or does not
 * come back up.
 */
export async function restartGateway(port: number): Promise<void> {
  const binPath = fileURLToPath(new URL("../bin/ccoc.cjs", import.meta.url))
  const script =
    `$ErrorActionPreference = 'SilentlyContinue'\n` +
    `$listener = Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1\n` +
    `if ($listener) { Stop-Process -Id $listener.OwningProcess -Force }\n` +
    // give the old process a moment to release the port before relaunching
    `Start-Sleep -Milliseconds 800\n` +
    // the old gateway's tray monitor keeps polling and would linger as a
    // duplicate icon; the relaunched gateway spawns a fresh one
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('pwsh.exe','powershell.exe') -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*ccoc-tray.ps1*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n` +
    `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '${binPath}','serve','--port','${port}'\n`
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { stdio: "pipe" })
  if (result.status !== 0) {
    throw new Error("gateway restart command failed")
  }
  if (!(await waitForGateway(port, true))) {
    throw new Error(`gateway did not come back up on port ${port}`)
  }
}

/**
 * Compare the Claude Code discovery cache against the models that would now be
 * served and rewrite it when it is missing, malformed, or stale (so the model
 * list Claude Code shows matches `ccoc models` even before the gateway
 * restarts). Returns "current" when the cache already matches, else "updated".
 */
export async function repairGatewayModelCache(
  mappings: ReadonlyMap<string, ResolvedMapping>,
  port: number,
  modelDisplay: "slug" | "provider" = "slug",
): Promise<"current" | "updated"> {
  const path = gatewayCachePath()
  const entries = gatewayModelEntries(mappings, modelDisplay).map(({ id, display_name }) => ({ id, display_name }))
  const expected = { baseUrl: `http://127.0.0.1:${port}`, models: entries }
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as { baseUrl?: unknown; models?: unknown }
    if (existing.baseUrl === expected.baseUrl && JSON.stringify(existing.models) === JSON.stringify(expected.models)) {
      return "current"
    }
  } catch {
    // missing or malformed: falls through to a rewrite
  }
  await ensureGatewayModelCache(mappings, port, modelDisplay)
  return "updated"
}

/** Mark Claude Code onboarding as complete in `~/.claude.json` (preserving all
 * existing state) — the first-run login/theme prompts are pointless when ccoc
 * already supplies a working model list and auth. Creates the file if missing;
 * never throws into the launch. */
export async function ensureOnboardingComplete() {
  const path = join(homedir(), ".claude.json")
  try {
    let state: Record<string, unknown>
    try {
      state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {
      state = {}
    }
    if (state.hasCompletedOnboarding === true) return
    state.hasCompletedOnboarding = true
    await writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  } catch {
    // unreadable/unwritable state file: leave it alone
  }
}

/**
 * Ensure `~/.claude/settings.json` routes Claude Code through the local
 * gateway: the env block must carry ANTHROPIC_BASE_URL plus the discovery and
 * context keys. Called at `serve` startup (and the tray re-applies the same on
 * resume). Pausing the gateway via the tray strips these keys instead, so
 * Claude Code falls back to whatever user-level env points at (e.g. a shared
 * remote gateway). Never throws into the launch; retries locked files.
 */
export async function ensureGatewaySettingsEnv(port: number) {
  const path = join(homedir(), ".claude", "settings.json")
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95",
  }
  try {
    let settings: Record<string, unknown>
    try {
      settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {
      settings = {}
    }
    const existingEnv = (settings.env ?? {}) as Record<string, unknown>
    settings.env = { ...existingEnv, ...env }
    const json = JSON.stringify(settings, null, 2) + "\n"
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFile(path, json, { mode: 0o600 })
        return
      } catch {
        if (attempt < 4) await sleep(300)
      }
    }
  } catch {
    // unreadable/unwritable settings: the gateway still runs
  }
}

/** Resolve every served model (nested config + CLI aliases) to a mapping keyed
 * by its config key (`provider/model` or the alias name). Throws on the first
 * unresolvable entry. */
function buildServedMappings(context: LaunchContext): Map<string, ResolvedMapping> {
  const { config, aliases, catalog, openCodeConfig, auth } = context
  const mappings = new Map<string, ResolvedMapping>()
  for (const [provider, providerModels] of Object.entries(config.models ?? {})) {
    for (const model of Object.keys(providerModels)) {
      const key = `${provider}/${model}`
      mappings.set(key, resolveMapping(key, config, catalog, openCodeConfig, auth))
    }
  }
  for (const [name, _target] of Object.entries(aliases)) {
    mappings.set(name, resolveMapping(name, config, catalog, openCodeConfig, auth, aliases))
  }
  return mappings
}

async function launch(target: string, context: LaunchContext) {
  const { args, config, catalog, openCodeConfig, auth } = context
  await saveLastModel(target)

  const mappings = buildServedMappings(context)
  const selected = resolveMapping(target, config, catalog, openCodeConfig, auth, context.aliases)
  mappings.set(selected.alias, selected)
  mappings.set(`${selected.provider}/${selected.model}`, selected)

  const running = await listenProxy({
    selected,
    mappings,
    aliases: context.aliases,
    config: args.port !== undefined ? { ...config, port: args.port } : config,
    catalog,
    openCodeConfig,
  })
  const modelDisplay = config.modelDisplay === "provider" ? "provider" : "slug"
  try {
    await ensureGatewayModelCache(mappings, running.port, modelDisplay)
  } catch (cacheError) {
    await running.close()
    throw new Error(
      `Refusing to launch Claude Code: gateway model cache could not be verified (${cacheError instanceof Error ? cacheError.message : String(cacheError)}). ` +
        "Run 'ccoc doctor' and check the gateway is reachable.",
    )
  }
  if (args.command === "serve") {
    await ensureOnboardingComplete()
    await ensureGatewaySettingsEnv(running.port)
    const served = [...mappings.values()].filter(
      (mapping, index, list) => list.findIndex((other) => other.alias === mapping.alias) === index,
    )
    process.stdout.write(`ccoc gateway listening at ${running.url}\n`)
    process.stdout.write(
      `Served models (discovered by Claude Code as \`anthropic-<${modelDisplay === "provider" ? "provider/" : ""}model>\`):\n`,
    )
    for (const mapping of served) {
      const id = gatewayModelId(mapping, mappings, modelDisplay)
      process.stdout.write(`  ${id}  ->  ${mapping.provider}/${mapping.model}\n`)
    }
    if (args.tray !== false && config.tray !== false) spawnTrayApp()
    await waitForSignal()
    await running.close()
    return
  }

  const command = process.env.CCOC_CLAUDE_COMMAND ?? "claude"
  await ensureOnboardingComplete()
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: running.url,
    ANTHROPIC_AUTH_TOKEN: "ccoc-local",
    ANTHROPIC_MODEL: gatewayModelId(selected, mappings, modelDisplay).slice("anthropic-".length),
    ...contextEnvVars(selected.providerInfo?.models?.[selected.model]?.limit, process.env),
  }
  const capabilities = supportedCapabilities(selected)
  if (capabilities && env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES === undefined) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = capabilities
  }
  delete env.ANTHROPIC_API_KEY

  // Declare connector disabling by setting (claude --settings) instead of
  // letting Claude Code infer it from the auth-source precedence conflict,
  // which is what prints the startup warning.
  // A configured reasoningEffort seeds the session's launch effort with
  // `--effort <level>`, which accepts every level Claude Code supports
  // (including max) and applies for the session only, so the label Claude Code
  // shows matches what ccoc sends to the provider. It is a default: the user
  // can still change it in-session with /effort. none/minimal are not effort
  // levels and are left unset; the proxy applies them directly. An explicit
  // `--effort` the user passed through ccoc wins.
  const overlay: Record<string, unknown> = { disableClaudeAiConnectors: true }
  const overlayPath = settingsOverlayPath()
  await mkdir(dirname(overlayPath), { recursive: true, mode: 0o700 })
  await writeFile(overlayPath, JSON.stringify(overlay, null, 2) + "\n", {
    mode: 0o600,
  })
  const claudeArgs = [...args.claudeArgs, ...launchEffortArg(selected.reasoningEffort, args.claudeArgs), "--settings", overlayPath]

  const child = spawn(command, claudeArgs, {
    stdio: "inherit",
    env,
  })

  let exitCode: number
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
  } finally {
    await running.close()
  }
  process.exitCode = exitCode
}

async function printModelList(context: LaunchContext, args: Arguments) {
  const filter = args.filter ?? args.claudeArgs[0]
  const models = listConnectedModels(context.catalog, context.auth).filter(
    (item) => !filter || item.provider === filter || item.provider.includes(filter) || item.model.includes(filter),
  )
  if (models.length === 0) {
    process.stdout.write("No connected OpenCode models found. Run `opencode auth login` first.\n")
    return
  }
  for (const item of models) {
    process.stdout.write(
      `${item.provider}/${item.model}\t${item.modelName}${item.reasoning ? " [reasoning]" : ""}${item.tools ? " [tools]" : ""}\n`,
    )
  }
}

async function aliasCommand(args: Arguments) {
  const aliases = await loadAliases()
  const name = args.model
  const target = args.claudeArgs[0]

  if (args.command === "unalias" || name === "rm") {
    const remove = args.command === "unalias" ? name : target
    if (!remove) {
      process.stderr.write("ccoc: alias remove needs a name: ccoc alias rm <name>\n")
      process.exitCode = 1
      return
    }
    if (remove in aliases) {
      delete aliases[remove]
      await saveAliases(aliases)
      const wrapperRemoved = await removeWrapper(remove)
      process.stdout.write(`Removed alias '${remove}'${wrapperRemoved ? "" : " (no wrapper command found)"}\n`)
    } else {
      process.stderr.write(`ccoc: no alias named '${remove}'\n`)
      process.exitCode = 1
    }
    return
  }

  if (!name) {
    const entries = Object.entries(aliases)
    if (entries.length === 0) {
      process.stdout.write("No aliases defined. Add one with: ccoc alias <name> <provider/model>\n")
      return
    }
    for (const [alias, value] of entries) process.stdout.write(`${alias}  ->  ${value}\n`)
    return
  }

  if (!target) {
    const value = aliases[name]
    if (!value) {
      process.stderr.write(`ccoc: no alias named '${name}'. Add one with: ccoc alias ${name} <provider/model>\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(`${name}  ->  ${value}\n`)
    }
    return
  }

  if (!validAliasName(name)) {
    process.stderr.write(`ccoc: invalid alias name '${name}' (letters, digits, '.', '_', '-' only)\n`)
    process.exitCode = 1
    return
  }
  if (!validAliasTarget(target)) {
    process.stderr.write(`ccoc: alias target must look like provider/model, got '${target}'\n`)
    process.exitCode = 1
    return
  }
  aliases[name] = target
  await saveAliases(aliases)
  try {
    await installWrapper(name)
    process.stdout.write(`Alias '${name}' -> ${target}\n`)
    process.stdout.write(`Installed command '${name}' in ${wrapperDir()}\n`)
  } catch (error) {
    process.stdout.write(`Alias '${name}' -> ${target}\n`)
    process.stderr.write(`ccoc: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Context-window env vars for Claude Code, derived from the model catalog.
 * Claude Code assumes 200K for any non-registry model, so without these a
 * 1M-token model is capped at 200K. Existing user values are never overridden.
 * Claude Code itself caps AUTO_COMPACT_WINDOW at 1,000,000 and non-registry
 * output tokens at 128,000.
 */
export function contextEnvVars(
  limit: { context?: number; output?: number } | undefined,
  existing: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  if (limit?.context) {
    const capped = Math.min(limit.context, 1_000_000)
    if (existing.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(capped)
    }
    if (existing.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(capped)
    }
    if (existing.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === undefined) {
      // 80% leaves headroom for the output budget inside the window.
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "80"
    }
  }
  if (limit?.output && existing.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(limit.output, 128_000))
  }
  return env
}

/**
 * CLI args that seed a session's launch effort. `--effort` accepts every level
 * Claude Code supports (including max) and applies for the session only, so the
 * label Claude Code shows matches what ccoc sends to the provider. It is a
 * default: the user can still change it in-session with /effort. none/minimal
 * are not effort levels and are left unset. An explicit `--effort` the user
 * passed through ccoc wins.
 */
export function launchEffortArg(
  effort: ResolvedMapping["reasoningEffort"],
  claudeArgs: string[],
): string[] {
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    if (!claudeArgs.includes("--effort")) return ["--effort", effort]
  }
  return []
}

/**
 * Declare reasoning capabilities for Claude Code's /effort UI. Claude Code
 * only enables effort levels for custom model IDs when told the model
 * supports them (`ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES`); an
 * arbitrary id like `deepseek-v4-flash` matches no known pattern, so without
 * this the effort UI is disabled entirely.
 */
export function supportedCapabilities(selected: {
  reasoning?: boolean
  reasoningOptions?: string[]
}): string | undefined {
  if (!selected.reasoning) return undefined
  if (selected.reasoningOptions && selected.reasoningOptions.length > 0) {
    const caps = ["effort", "thinking", "adaptive_thinking", "interleaved_thinking"]
    if (selected.reasoningOptions.includes("xhigh")) caps.push("xhigh_effort")
    if (selected.reasoningOptions.includes("max")) caps.push("max_effort")
    return caps.join(",")
  }
  return "thinking"
}

/** Task name registered with Windows Task Scheduler. */
const SERVICE_TASK_NAME = "ccoc-gateway"

const DEFAULT_GATEWAY_PORT = 6767

/** Hidden gateway launch: a single PowerShell invocation that hides its own
 * window and starts node with -WindowStyle Hidden, so no console window appears
 * at logon. Used as the Task Scheduler action and the Startup-folder entry —
 * no VBS file needed. */
function gatewayLaunchCommand(port: number) {
  const binPath = fileURLToPath(new URL("../bin/ccoc.cjs", import.meta.url))
  return (
    `powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden ` +
    `-FilePath '${process.execPath}' -ArgumentList '${binPath}','serve','--port','${port}'"`
  )
}

async function serviceCommand(args: Arguments) {
  if (process.platform !== "win32") {
    process.stderr.write("ccoc: the gateway service uses Windows Task Scheduler and is only supported on Windows.\n")
    process.exitCode = 1
    return
  }
  const command = args.command === "install-service" ? "install" : "uninstall"
  const config = await loadCcocConfig(args.config)
  const port = args.port ?? config.port ?? DEFAULT_GATEWAY_PORT

  if (command === "uninstall") {
    const script =
      `$ErrorActionPreference = 'Stop'\n` +
      `Unregister-ScheduledTask -TaskName '${SERVICE_TASK_NAME}' -Confirm:$false\n` +
      `Unregister-ScheduledTask -TaskName '${SERVICE_TASK_NAME}-watchdog' -Confirm:$false\n`
    const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { stdio: "pipe" })
    const ok = result.status === 0 && !/Cannot find|not exist|error/i.test(result.stderr?.toString() ?? "")
    if (ok) process.stdout.write(`Removed scheduled task '${SERVICE_TASK_NAME}'.\n`)
    else {
      process.stderr.write(`ccoc: no scheduled task '${SERVICE_TASK_NAME}' to remove (or removal failed).\n`)
      process.exitCode = result.status ?? 1
    }
    return
  }

  // Register a Task Scheduler task for the current user at logon. The action is
  // a hidden PowerShell launch (no VBS, no console window) that first checks
  // whether the gateway is already answering and only starts it when it is
  // down. A second task runs that same check every 5 minutes, so if the
  // gateway ever dies it is relaunched within minutes (a watchdog). Windows
  // PowerShell 5.1 cmdlets only (the Task Scheduler host on Server editions);
  // `New-ScheduledTaskRepetition` is not available there, so the watchdog uses
  // `New-ScheduledTaskTrigger -Once -RepetitionInterval` instead. Logon tasks
  // for the current user are registrable in userspace (no admin) when run from
  // an interactive session; fall back to a Startup-folder entry when
  // unavailable.
  const binPath = fileURLToPath(new URL("../bin/ccoc.cjs", import.meta.url))
  const quote = (value: string) => `''${value}''`
  // Health check is HTTP, not a raw TCP connect: a wedged gateway still accepts
  // TCP connections, so a connect-only check would never restart it. /admin/status
  // answers whenever the process is alive (including intentionally paused), and
  // times out only when it is truly unresponsive.
  const watchdog =
    `try { $r = Invoke-WebRequest ''http://127.0.0.1:${port}/admin/status'' -UseBasicParsing -TimeoutSec 5; $up = $true } catch { $up = $false }; ` +
    `if (-not $up) { Start-Process -WindowStyle Hidden -FilePath ${quote(process.execPath)} -ArgumentList ${quote(binPath)},${quote("serve")},${quote("--port")},${quote(String(port))} }`
  const script =
    `$ErrorActionPreference = 'Stop'\n` +
    // -Argument is a single-quoted PowerShell string, so `$` passes through
    // literally (no escaping) — the launched powershell parses the watchdog
    // as real code.
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "${watchdog}"'\n` +
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)\n` +
    `$logon = New-ScheduledTaskTrigger -AtLogOn\n` +
    `Register-ScheduledTask -TaskName '${SERVICE_TASK_NAME}' -Action $action -Trigger $logon -Settings $settings -Description 'ccoc LLM gateway: starts at logon' -Force | Out-Null\n` +
    `$watch = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)\n` +
    `Register-ScheduledTask -TaskName '${SERVICE_TASK_NAME}-watchdog' -Action $action -Trigger $watch -Settings $settings -Description 'ccoc LLM gateway watchdog: relaunches it within 5 minutes if down' -Force | Out-Null\n`
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { stdio: "pipe" })
  if (result.status === 0) {
    process.stdout.write(
      `Scheduled task '${SERVICE_TASK_NAME}' created: starts the ccoc gateway (port ${port}) at every logon, ` +
        `plus '${SERVICE_TASK_NAME}-watchdog' which relaunches it within 5 minutes if it ever goes down.\n`,
    )
    process.stdout.write("It runs hidden (no window). Start it now with: schtasks /Run /TN ccoc-gateway\n")
    process.stdout.write("Remove it later with: ccoc uninstall-service\n")
    return
  }

  // Task registration is unavailable in this context (e.g. run from a service
  // or CI session). Fall back to a Startup-folder shortcut — the same userspace
  // logon behaviour, no Task Scheduler trigger and no admin required.
  const startupDir = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  )
  const shortcut = join(startupDir, "ccoc-gateway.cmd")
  try {
    await mkdir(startupDir, { recursive: true })
    await writeFile(shortcut, `@echo off\n${gatewayLaunchCommand(port)}\n`, { mode: 0o600 })
    process.stdout.write(`ccoc: scheduled task unavailable here; installed Startup entry '${shortcut}' instead.\n`)
    process.stdout.write("The gateway will launch at every logon (hidden). Remove it by deleting that file.\n")
  } catch (installError) {
    process.stderr.write(
      `ccoc: failed to install the gateway start-up entry: ${installError instanceof Error ? installError.message : String(installError)}\n`,
    )
    process.exitCode = 1
  }
}

async function trayCommand() {
  if (process.platform !== "win32") {
    process.stderr.write("ccoc: the tray app requires Windows (PowerShell + WinForms).\n")
    process.exitCode = 1
    return
  }
  spawnTrayApp()
  process.stdout.write("ccoc tray started.\n")
}

/** Launch the system-tray monitor as a background process. Also called by
 * `ccoc serve` so the tray is present whenever the gateway is running.
 * `-STA` is required for a WinForms NotifyIcon to appear reliably; without it
 * the icon can fail to register with the shell (dml-clanker uses the same
 * `-STA` pattern).
 *
 * The tray is spawned through a `Start-Process` wrapper that exits immediately:
 * a force-killed parent (Stop-Process -Force, as the tray itself does when
 * clicking to stop the gateway) otherwise takes the tray down with it — its
 * WinForms message loop ends when the terminating parent's handles die, and
 * the icon vanishes. Orphaning it via Start-Process (the same pattern the
 * Startup entry uses for the gateway) makes the tray survive the gateway's
 * death so it can show the gray "stopped" state and start it again. */
function spawnTrayApp() {  const log = (message: string) => {
    writeFile(join(stateHomePath, "ccoc", "tray.log"), `${message}\n`, { flag: "a" }).catch(() => {})
  }
  const pwsh = (() => {
    const fromPath = process.env.PWSH_PATH
    return fromPath && fromPath.length > 0 ? fromPath : "pwsh"
  })()
  const scriptPath = fileURLToPath(new URL("../scripts/ccoc-tray.ps1", import.meta.url))
  log(`spawning tray: ${pwsh} ${scriptPath}`)
  try {
    const launch =
      `Start-Process -WindowStyle Hidden -FilePath '${pwsh}' ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-STA','-File','${scriptPath}'`
    const wrapper = spawn(pwsh, ["-NoProfile", "-Command", launch], { stdio: ["ignore", "pipe", "pipe"] })
    wrapper.stderr.on("data", (data) => log(`stderr: ${data.toString()}`))
    wrapper.stdout.on("data", (data) => log(`stdout: ${data.toString()}`))
    wrapper.on("error", (error) => log(`spawn error: ${error.message}`))
    wrapper.on("exit", (code) => log(`tray wrapper exited: ${code}`))
    wrapper.unref()
  } catch (error) {
    log(`spawnTrayApp threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}


async function updateCommand() {
  process.stdout.write(`ccoc ${version} installed\n`)
  const binPath = process.argv[1]
  const real = binPath ? await realpath(binPath) : binPath
  const linked = Boolean(real && real !== binPath)

  if (linked) {
    // npm link: bin is a symlink into a git clone. Update the clone in place;
    // the symlink picks up the changes automatically.
    const repoRoot = dirname(dirname(real!))
    const pull = spawnSync("git", ["pull", "--ff-only"], { cwd: repoRoot, stdio: "inherit" })
    if (pull.status !== 0) {
      process.stderr.write(`ccoc: 'git pull' failed in ${repoRoot}. Update manually or reinstall with 'npm install -g github:Pipyakas/ccoc'.\n`)
      process.exitCode = 1
      return
    }
    const install = spawnSync("npm", ["install"], { cwd: repoRoot, stdio: "inherit" })
    if (install.status !== 0) {
      process.stderr.write("ccoc: 'npm install' failed after pull.\n")
      process.exitCode = 1
      return
    }
    process.stdout.write(`Updated ${repoRoot}\n`)
  } else {
    // Installed package (e.g. `npm install -g github:Pipyakas/ccoc`).
    const install = spawnSync("npm", ["install", "-g", "github:Pipyakas/ccoc"], { stdio: "inherit" })
    if (install.status !== 0) {
      process.stderr.write("ccoc: global reinstall failed.\n")
      process.exitCode = 1
      return
    }
  }
  process.stdout.write("Done. Run 'ccoc --version' in a new shell to confirm the update.\n")
}

async function doctorCommand() {
  const auth = await loadAuthStore()
  const last = await loadLastModel()
  process.stdout.write(`OpenCode auth: ${authPath()}\n`)
  process.stdout.write(`ccoc config: ${configPath()}\n`)
  process.stdout.write(`Last model: ${last ?? "none"}\n`)
  const entries = Object.entries(auth)
  if (entries.length === 0) {
    process.stdout.write("Authenticated providers: none\n")
    return
  }
  process.stdout.write("Authenticated providers:\n")
  for (const [provider, value] of entries) {
    const status = value.type === "oauth" ? (value.expires > Date.now() ? "oauth (valid)" : "oauth (refresh needed)") : value.type
    process.stdout.write(`- ${provider}: ${status}\n`)
  }
}

export function parseArguments(argv: string[]): Arguments {
  const args: Arguments = { claudeArgs: [] }
  let passthrough = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (passthrough) {
      args.claudeArgs.push(value)
      continue
    }
    if (value === "--") {
      passthrough = true
    } else if (value === "--help" || value === "-h") {
      printUsage()
      process.exit(0)
    } else if (value === "--version" || value === "-v") {
      process.stdout.write(`ccoc ${version}\n`)
      process.exit(0)
    } else if (value === "--model" || value === "-m") {
      const next = argv[index + 1]
      if (next && !next.startsWith("-") && next !== "--") {
        args.model = next
        index += 1
      } else {
        args.interactive = true
      }
    } else if (value === "--config") {
      args.config = requiredArgument(argv, ++index, value)
    } else if (value === "--port") {
      const raw = requiredArgument(argv, ++index, value)
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`--port expects a valid TCP port, got '${raw}'`)
      args.port = parsed
    } else if (value === "--no-tray") {
      args.tray = false
    } else if (value === "--refresh") {
      args.refresh = true
    } else if (
      value === "models" ||
      value === "doctor" ||
      value === "serve" ||
      value === "update" ||
      value === "alias" ||
      value === "unalias" ||
      value === "install-service" ||
      value === "uninstall-service" ||
      value === "tray"
    ) {
      args.command = value
    } else if (value.startsWith("-")) {
      args.claudeArgs.push(value)
      passthrough = true
    } else if (args.command === "serve" || args.command === "install-service" || args.command === "tray") {
      args.model = value
    } else if (args.command === "models") {
      args.filter = value
    } else if (!args.model) {
      args.model = value
    } else {
      args.claudeArgs.push(value)
    }
  }
  return args
}

function requiredArgument(argv: string[], index: number, flag: string) {
  const value = argv[index]
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`)
  return value
}

function waitForSignal() {
  return new Promise<void>((resolve) => {
    const done = () => resolve()
    process.once("SIGINT", done)
    process.once("SIGTERM", done)
  })
}

function printUsage() {
  process.stdout.write(`ccoc - shared OpenCode gateway for Claude Code

Usage:
  ccoc                            Manage the gateway: check the running instance,
                                   change served models, or start it (with tray),
                                   and optionally install the logon service
  ccoc serve                      Start the gateway (serves every model on
                                   config.port or an ephemeral port, shows the tray)
  ccoc models                     Pick which models the gateway serves
  ccoc tray                       Launch the system-tray monitor for the gateway
  ccoc doctor                     Show auth and configuration status
  ccoc install-service            Register a Windows Task Scheduler task that runs the
                                   gateway at every logon (--port overrides the port)
  ccoc uninstall-service          Remove the scheduled gateway task
  ccoc update                     Update ccoc from GitHub (auto-detects install)
  ccoc alias                      List CLI-defined aliases
  ccoc alias <name> <model>       Define an alias (stored in the state dir, no config edit)
  ccoc alias rm <name>            Remove an alias
  ccoc unalias <name>             Remove an alias

Options:
  --config <path>   Use a specific ccoc config file
  --port <port>     Gateway port for \`ccoc serve\` / \`ccoc install-service\`
  --refresh         Refresh OpenCode's model catalog
  --                Force-passthrough: everything after is a Claude Code arg

Anything that is not a ccoc option is passed through to Claude Code,
e.g. ccoc -m go -p "fix the bug" --continue.
Use -- for Claude flags that collide with ccoc's own (-m, --model,
--config, --refresh, -h).

Config: ~/.config/ccoc/config.json or ./ccoc.json
`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`ccoc: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
