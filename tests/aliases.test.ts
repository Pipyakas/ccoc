import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { loadAliases, saveAliases, validAliasName, validAliasTarget } from "../src/aliases.js"

test("validates alias names and targets", () => {
  assert.equal(validAliasName("fast"), true)
  assert.equal(validAliasName("my-model_2"), true)
  assert.equal(validAliasName("has/slash"), false)
  assert.equal(validAliasName(""), false)
  assert.equal(validAliasTarget("opencode-go/deepseek-v4-flash"), true)
  assert.equal(validAliasTarget("deepseek-v4-flash"), false)
  assert.equal(validAliasTarget("a/b/c"), false)
})

test("persists and removes aliases in the state dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccoc-aliases-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    assert.deepEqual(await loadAliases(), {})
    await saveAliases({ fast: "opencode-go/deepseek-v4-flash", codex: "openai/gpt-5.4" })
    assert.deepEqual(await loadAliases(), {
      fast: "opencode-go/deepseek-v4-flash",
      codex: "openai/gpt-5.4",
    })
    await saveAliases({ fast: "opencode-go/deepseek-v4-flash" })
    assert.deepEqual(await loadAliases(), { fast: "opencode-go/deepseek-v4-flash" })
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})
