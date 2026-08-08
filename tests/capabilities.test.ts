import assert from "node:assert/strict"
import { test } from "node:test"
import { supportedCapabilities } from "../src/cli.js"

test("declares effort capabilities matching the model's catalog options", () => {
  assert.equal(
    supportedCapabilities({ reasoning: true, reasoningOptions: ["low", "high", "max"] }),
    "effort,thinking,adaptive_thinking,interleaved_thinking,max_effort",
  )
  assert.equal(
    supportedCapabilities({ reasoning: true, reasoningOptions: ["none", "low", "medium", "high", "xhigh", "max"] }),
    "effort,thinking,adaptive_thinking,interleaved_thinking,xhigh_effort,max_effort",
  )
  assert.equal(
    supportedCapabilities({ reasoning: true, reasoningOptions: ["high", "max"] }),
    "effort,thinking,adaptive_thinking,interleaved_thinking,max_effort",
  )
})

test("non-effort models get plain thinking; non-reasoning models get nothing", () => {
  assert.equal(supportedCapabilities({ reasoning: true }), "thinking")
  assert.equal(supportedCapabilities({ reasoning: true, reasoningOptions: [] }), "thinking")
  assert.equal(supportedCapabilities({ reasoning: false }), undefined)
  assert.equal(supportedCapabilities({}), undefined)
})
