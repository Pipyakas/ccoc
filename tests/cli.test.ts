import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { ensureGatewayModelCache, ensureGatewaySettingsEnv, ensureOnboardingComplete, launchEffortArg, parseArguments, repairGatewayModelCache } from "../src/cli.js"
import { validateModels } from "../src/config.js"
import { listPickableModels } from "../src/catalog.js"
import { filterServeModelChoices } from "../src/serve-models-prompt.js"
import { buildModelChoices, filterModelChoices } from "../src/picker.js"
import { loadLastModel, saveLastModel } from "../src/state.js"
import type { AuthStore, CcocProxyConfig, OpenCodeConfig, ProviderCatalog } from "../src/types.js"
import type { ResolvedMapping } from "../src/catalog.js"

test("parses -m with and without a value", () => {
  assert.deepEqual(parseArguments(["-m"]), { interactive: true, claudeArgs: [] })
  assert.deepEqual(parseArguments(["-m", "go"]), { model: "go", claudeArgs: [] })
  assert.deepEqual(parseArguments(["--model", "go"]), { model: "go", claudeArgs: [] })
  assert.deepEqual(parseArguments([]), { claudeArgs: [] })
  assert.deepEqual(parseArguments(["fast"]), { model: "fast", claudeArgs: [] })
  assert.deepEqual(parseArguments(["-m", "go", "--", "-p", "hi"]), { model: "go", claudeArgs: ["-p", "hi"] })
  assert.deepEqual(parseArguments(["models"]), { command: "models", claudeArgs: [] })
  assert.deepEqual(parseArguments(["-m", "--", "-p", "hi"]), { interactive: true, claudeArgs: ["-p", "hi"] })
})

test("passes unknown flags and trailing arguments through to Claude Code", () => {
  assert.deepEqual(parseArguments(["-m", "go", "-p", "hi"]), { model: "go", claudeArgs: ["-p", "hi"] })
  assert.deepEqual(parseArguments(["go", "-p", "hi"]), { model: "go", claudeArgs: ["-p", "hi"] })
  assert.deepEqual(parseArguments(["go", "--continue", "-s", "abc"]), {
    model: "go",
    claudeArgs: ["--continue", "-s", "abc"],
  })
  assert.deepEqual(parseArguments(["-p", "hi"]), { claudeArgs: ["-p", "hi"] })
  assert.deepEqual(parseArguments(["-m", "go", "--dangerously-skip-permissions"]), {
    model: "go",
    claudeArgs: ["--dangerously-skip-permissions"],
  })
})

test("keeps serve and models positional arguments separate", () => {
  assert.deepEqual(parseArguments(["serve", "openai/gpt-5.4"]), {
    command: "serve",
    model: "openai/gpt-5.4",
    claudeArgs: [],
  })
  assert.deepEqual(parseArguments(["models", "opencode-go"]), {
    command: "models",
    filter: "opencode-go",
    claudeArgs: [],
  })
  assert.deepEqual(parseArguments(["models", "opencode-go", "--", "-p", "x"]), {
    command: "models",
    filter: "opencode-go",
    claudeArgs: ["-p", "x"],
  })
})

test("seeds a session launch effort with --effort for expressible levels", () => {
  assert.deepEqual(launchEffortArg("max", []), ["--effort", "max"])
  assert.deepEqual(launchEffortArg("medium", []), ["--effort", "medium"])
  assert.deepEqual(launchEffortArg("xhigh", ["--continue"]), ["--effort", "xhigh"])
  // none/minimal are not effort levels; the proxy applies them directly
  assert.deepEqual(launchEffortArg("none", []), [])
  assert.deepEqual(launchEffortArg("minimal", []), [])
  assert.deepEqual(launchEffortArg(undefined, []), [])
  // an explicit user --effort wins
  assert.deepEqual(launchEffortArg("max", ["--effort", "low"]), [])
})

test("persists and loads the last selected model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-state-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    assert.equal(await loadLastModel(), undefined)
    await saveLastModel("openai/gpt-5.4")
    assert.equal(await loadLastModel(), "openai/gpt-5.4")
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})

test("picker lists aliases first, then connected models, and filters", () => {
  const config: CcocProxyConfig = { models: { "opencode-go": { "deepseek-v4-flash": {} } } }
  const catalog: ProviderCatalog = {
    "opencode-go": {
      id: "opencode-go",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, tool_call: true },
        "qwen3.7-plus": { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
      },
    },
  }
  const auth: AuthStore = { "opencode-go": { type: "api", key: "k" } }
  const choices = buildModelChoices(config, catalog, auth, { fast: "opencode-go/deepseek-v4-flash" })
  assert.equal(choices.length, 3)
  assert.equal(choices[0]?.value, "fast")
  assert.equal(choices[1]?.value, "opencode-go/deepseek-v4-flash")
  assert.equal(choices[2]?.value, "opencode-go/qwen3.7-plus")

  assert.equal(filterModelChoices(choices, "deepseek").length, 2)
  assert.equal(filterModelChoices(choices, "fast").length, 1)
  assert.equal(filterModelChoices(choices, "qwen").length, 1)
  assert.equal(filterModelChoices(choices, "nope").length, 0)
  assert.equal(filterModelChoices(choices, "").length, 3)
})

test("ensureGatewayModelCache writes and verifies the Claude Code discovery cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-cache-"))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    const mapping: ResolvedMapping = {
      alias: "freeclaude",
      displayName: "deepseek-v4-flash-free",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      protocol: "openai-chat",
      baseURL: "http://127.0.0.1:1",
      headers: {},
    }
    await ensureGatewayModelCache(new Map([["freeclaude", mapping]]), 6767)
    const cache = JSON.parse(
      await readFile(join(dir, "cache", "gateway-models.json"), "utf8"),
    ) as { baseUrl: string; models: Array<{ id: string; display_name: string }> }
    assert.equal(cache.baseUrl, "http://127.0.0.1:6767")
    assert.deepEqual(cache.models, [
      { id: "anthropic-deepseek-v4-flash-free", display_name: "deepseek-v4-flash-free" },
    ])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test("repairGatewayModelCache rewrites a stale cache and leaves a matching one alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-cache-"))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    const mapping: ResolvedMapping = {
      alias: "freeclaude",
      displayName: "deepseek-v4-flash-free",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      protocol: "openai-chat",
      baseURL: "http://127.0.0.1:1",
      headers: {},
    }
    const mappings = new Map([["freeclaude", mapping]])
    const cachePath = join(dir, "cache", "gateway-models.json")
    // stale cache listing an old model list -> rewritten to match
    await mkdir(join(dir, "cache"), { recursive: true })
    await writeFile(
      cachePath,
      JSON.stringify({
        baseUrl: "http://127.0.0.1:6767",
        fetchedAt: 0,
        models: [{ id: "anthropic-stale-model", display_name: "stale-model" }],
      }),
    )
    assert.equal(await repairGatewayModelCache(mappings, 6767), "updated")
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as { models: Array<{ id: string }> }
    assert.deepEqual(cache.models, [{ id: "anthropic-deepseek-v4-flash-free", display_name: "deepseek-v4-flash-free" }])
    // matching cache -> untouched
    assert.equal(await repairGatewayModelCache(mappings, 6767), "current")
    // missing cache -> written
    await rm(cachePath)
    assert.equal(await repairGatewayModelCache(mappings, 6767), "updated")
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test("listPickableModels offers connected providers plus configured no-auth providers", () => {
  const catalog: ProviderCatalog = {
    "han_studio": {
      id: "han_studio",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:8888/v1",
      models: { "deepseek-v4-flash": { id: "deepseek-v4-flash" }, "extra": { id: "extra" } },
    },
    "acme": {
      id: "acme",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.acme.example/v1",
      models: { "gpt-5.4": { id: "gpt-5.4" }, "qwen3.6:35b": { id: "qwen3.6:35b" } },
    },
    "opencode-go": {
      id: "opencode-go",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/go/v1",
      models: { "deepseek-v4-flash": { id: "deepseek-v4-flash" }, "qwen3.7-plus": { id: "qwen3.7-plus" } },
    },
  }
  const openCodeConfig: OpenCodeConfig = {
    provider: {
      han_studio: { options: { baseURL: "http://127.0.0.1:8888/v1" }, models: { "deepseek-v4-flash": {} } },
      acme: { models: { "gpt-5.4": {}, "qwen3.6:35b": {} } },
    },
  }
  // acme + opencode-go are connected via auth; han_studio only via config
  const auth: AuthStore = {
    acme: { type: "api", key: "k" },
    "opencode-go": { type: "api", key: "k2" },
  }
  const models = listPickableModels(catalog, auth, openCodeConfig)
  const keys = models.map((m) => `${m.provider}/${m.model}`)
  // configured no-auth provider: only its configured models
  assert.ok(keys.includes("han_studio/deepseek-v4-flash"))
  assert.ok(!keys.includes("han_studio/extra"))
  // configured provider: configured models present
  assert.ok(keys.includes("acme/gpt-5.4"))
  assert.ok(keys.includes("acme/qwen3.6:35b"))
  // connected provider: full catalog models present
  assert.ok(keys.includes("opencode-go/deepseek-v4-flash"))
  assert.ok(keys.includes("opencode-go/qwen3.7-plus"))
})

test("serve models filter matches across provider/model and description", () => {
  const choices = [
    { value: "han_studio/deepseek-v4-flash", name: "han_studio/deepseek-v4-flash", description: "DeepSeek V4 Flash" },
    { value: "opencode-go/deepseek-v4-flash", name: "opencode-go/deepseek-v4-flash", description: "DeepSeek V4 Flash" },
    { value: "acme/qwen3.6:35b", name: "acme/qwen3.6:35b", description: "Qwen3.6" },
  ]
  assert.deepEqual(filterServeModelChoices(choices, "han_studio").map((c) => c.value), ["han_studio/deepseek-v4-flash"])
  assert.deepEqual(filterServeModelChoices(choices, "opencode-go flash").map((c) => c.value), [
    "opencode-go/deepseek-v4-flash",
  ])
  assert.equal(filterServeModelChoices(choices, "  ").length, 3)
  assert.equal(filterServeModelChoices(choices, "gemini").length, 0)
})

test("validateModels rejects the legacy flat format and bad shapes", () => {
  validateModels({ "opencode-go": { "deepseek-v4-flash": { reasoningEffort: "max" } } })
  validateModels(undefined)
  assert.throws(() => validateModels({ fast: "opencode-go/deepseek-v4-flash" }), /models\.fast/)
  assert.throws(() => validateModels({ "opencode-go": { "deepseek-v4-flash": { provider: "x", model: "y" } } }), /models\.opencode-go\.deepseek-v4-flash/)
  assert.throws(() => validateModels([]), /keyed by provider/)
})

test("ensureOnboardingComplete marks onboarding done without touching other state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-claude-json-"))
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  try {
    const path = join(dir, ".claude.json")
    await writeFile(path, JSON.stringify({ hasCompletedOnboarding: false, theme: "dark", numStartups: 3 }))
    await ensureOnboardingComplete()
    const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    assert.equal(state.hasCompletedOnboarding, true)
    assert.equal(state.theme, "dark")
    assert.equal(state.numStartups, 3)
    // idempotent: second run leaves the file byte-identical
    const before = await readFile(path, "utf8")
    await ensureOnboardingComplete()
    assert.equal(await readFile(path, "utf8"), before)
    // missing file: created
    await rm(path)
    await ensureOnboardingComplete()
    assert.equal(JSON.parse(await readFile(path, "utf8")).hasCompletedOnboarding, true)
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
  }
})

test("ensureGatewaySettingsEnv writes the local gateway env into claude settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-settings-"))
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  try {
    const path = join(dir, ".claude", "settings.json")
    await mkdir(join(dir, ".claude"), { recursive: true })
    await writeFile(path, JSON.stringify({ model: "x", env: { DISABLE_TELEMETRY: "1" } }))
    await ensureGatewaySettingsEnv(6767)
    const settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    const env = settings.env as Record<string, string>
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:6767")
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1")
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000")
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "32000")
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "95")
    assert.equal(env.DISABLE_TELEMETRY, "1")
    assert.equal(settings.model, "x")
    // idempotent: second run keeps the same env
    await ensureGatewaySettingsEnv(6767)
    const again = (JSON.parse(await readFile(path, "utf8")) as { env: Record<string, string> }).env
    assert.equal(again.ANTHROPIC_BASE_URL, "http://127.0.0.1:6767")
    assert.equal(again.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "95")
    assert.equal(Object.keys(again).length, 7)
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
  }
})
