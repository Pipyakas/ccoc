import assert from "node:assert/strict"
import { test } from "node:test"
import { budgetEffort, reasoningEffortFor } from "../src/translate.js"
import type { ResolvedMapping } from "../src/catalog.js"

const mapping = (reasoningOptions?: string[], explicit?: ResolvedMapping["reasoningEffort"]): ResolvedMapping =>
  ({ reasoningOptions, reasoningEffort: explicit }) as ResolvedMapping

const thinking = (budget: number) => ({ type: "enabled" as const, budget_tokens: budget })

test("maps thinking budget onto the model's declared effort options", () => {
  const ds4 = mapping(["low", "high", "max"])
  assert.equal(reasoningEffortFor(thinking(100_000), ds4), "max")
  assert.equal(reasoningEffortFor(thinking(80_000), ds4), "max")
  assert.equal(reasoningEffortFor(thinking(30_000), ds4), "high")
  assert.equal(reasoningEffortFor(thinking(20_000), ds4), "high")
  assert.equal(reasoningEffortFor(thinking(8_000), ds4), "low")
  assert.equal(reasoningEffortFor(thinking(1_000), ds4), "low")

  const two = mapping(["high", "max"])
  assert.equal(reasoningEffortFor(thinking(100_000), two), "max")
  assert.equal(reasoningEffortFor(thinking(30_000), two), "high")
  assert.equal(reasoningEffortFor(thinking(2_000), two), "high")
})

test("6-tier gpt-5.6 ladder maps each budget band to its own effort", () => {
  const gpt56 = mapping(["none", "low", "medium", "high", "xhigh", "max"])
  assert.equal(reasoningEffortFor(thinking(80_000), gpt56), "max")
  assert.equal(reasoningEffortFor(thinking(60_000), gpt56), "xhigh")
  assert.equal(reasoningEffortFor(thinking(40_000), gpt56), "xhigh")
  assert.equal(reasoningEffortFor(thinking(20_000), gpt56), "high")
  assert.equal(reasoningEffortFor(thinking(10_000), gpt56), "medium")
  assert.equal(reasoningEffortFor(thinking(5_000), gpt56), "low")
  assert.equal(reasoningEffortFor(thinking(2_000), gpt56), "none")
  assert.equal(reasoningEffortFor(thinking(0), gpt56), "none")
})

test("falls back to budget thresholds without declared options", () => {
  const none = mapping(undefined)
  assert.equal(reasoningEffortFor(thinking(100_000), none), "high")
  assert.equal(reasoningEffortFor(thinking(30_000), none), "medium")
  assert.equal(reasoningEffortFor(thinking(8_000), none), "low")
  assert.equal(reasoningEffortFor(thinking(1_000), none), "minimal")
})

test("disabled thinking and explicit config effort", () => {
  assert.equal(reasoningEffortFor({ type: "disabled" }, mapping(undefined)), undefined)
  assert.equal(reasoningEffortFor(undefined, mapping(undefined)), undefined)
  assert.equal(reasoningEffortFor(thinking(8_000), mapping(["low", "high", "max"], "high"), true), "high")
})

test("a reasoningEffort preset is a launch default, not a hard override", () => {
  const preset = mapping(["low", "high", "max"], "max")
  // default active (first request of a session) -> the preset wins, even before
  // Claude Code enables thinking (it does not recognize the model as
  // effort-capable behind the gateway)
  assert.equal(reasoningEffortFor(thinking(80_000), preset, true), "max")
  assert.equal(reasoningEffortFor(thinking(8_000), preset, true), "max")
  assert.equal(reasoningEffortFor(undefined, preset, true), "max")
  // user changed the effort (budget moved out of the launch tier) -> map live,
  // using the model's declared options even though a preset is configured
  assert.equal(reasoningEffortFor(thinking(80_000), preset, false), "max")
  assert.equal(reasoningEffortFor(thinking(30_000), preset, false), "high")
  assert.equal(reasoningEffortFor(thinking(8_000), preset, false), "low")
})

test("budgetEffort quantizes a budget onto the declared tiers without the preset", () => {
  const ds4 = mapping(["low", "high", "max"])
  assert.equal(budgetEffort(thinking(120_000), ds4), "max")
  assert.equal(budgetEffort(thinking(80_000), ds4), "max")
  assert.equal(budgetEffort(thinking(79_000), ds4), "high")
  assert.equal(budgetEffort(thinking(40_000), ds4), "high")
  assert.equal(budgetEffort(thinking(20_000), ds4), "high")
  assert.equal(budgetEffort(thinking(19_000), ds4), "low")
  assert.equal(budgetEffort(thinking(1_000), ds4), "low")
  // a configured preset does not leak into the tier quantization
  assert.equal(budgetEffort(thinking(80_000), mapping(["low", "high", "max"], "max")), "max")
  assert.equal(budgetEffort(thinking(8_000), mapping(["low", "high", "max"], "max")), "low")
  // disabled and absent thinking have no tier
  assert.equal(budgetEffort({ type: "disabled" }, ds4), undefined)
  assert.equal(budgetEffort(undefined, ds4), undefined)
})
