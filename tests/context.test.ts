import assert from "node:assert/strict"
import { test } from "node:test"
import { contextEnvVars } from "../src/cli.js"

test("maps catalog context limits to Claude Code env vars", () => {
  const env = contextEnvVars({ context: 1_000_000, output: 384_000 }, {})
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000")
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000")
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "80")
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000")
})

test("caps context at 1M and output at 128K", () => {
  const env = contextEnvVars({ context: 2_000_000, output: 500_000 }, {})
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000")
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000")
})

test("respects existing user env values and skips missing limits", () => {
  const existing: NodeJS.ProcessEnv = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
  }
  const env = contextEnvVars({ context: 1_000_000, output: 384_000 }, existing)
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined)
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined)
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "80")
  const merged = { ...existing, ...env }
  assert.equal(merged.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "500000")
  assert.equal(merged.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "32000")
  assert.deepEqual(contextEnvVars(undefined, {}), {})
  assert.deepEqual(contextEnvVars({ context: 200_000 }, {}), {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
  })
})
