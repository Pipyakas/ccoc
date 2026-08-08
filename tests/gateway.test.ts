import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { listenProxy } from "../src/server.js"
import type { ResolvedMapping } from "../src/catalog.js"
import { AnthropicStreamEncoder } from "../src/sse.js"
import type { LLMEvent } from "@opencode-ai/llm/schema"


function mapping(alias: string, model: string, upstreamURL: string): ResolvedMapping {
  return {
    alias,
    displayName: model,
    provider: "fake",
    model,
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
  }
}

function sseUpstream(onBody: (body: Record<string, unknown>) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write('data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n')
    response.write('data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}\n\n')
    response.end("data: [DONE]\n\n")
  })
  return server
}

async function listen(server: ReturnType<typeof sseUpstream>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

test("GET /v1/models advertises slug ids by default and provider-qualified ids in provider mode", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const luna = mapping("lunaclaude", "gpt-5.6-luna", upstreamURL)
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([
      ["freeclaude", free],
      ["lunaclaude", luna],
    ]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/models`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: Array<Record<string, unknown>> }
    const ids = body.data.map((entry) => entry.id)
    assert.deepEqual(ids, ["anthropic-deepseek-v4-flash-free", "anthropic-gpt-5.6-luna"])
    const display = body.data.find((entry) => entry.id === "anthropic-deepseek-v4-flash-free")
    assert.equal(display?.display_name, "deepseek-v4-flash-free")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
  }
})

test("modelDisplay: provider advertises provider-qualified ids and names", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const free = mapping("deepseek-v4-flash-free", "deepseek-v4-flash-free", upstreamURL)
  const luna = mapping("gpt-5.6-luna", "gpt-5.6-luna", upstreamURL)
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([
      ["deepseek-v4-flash-free", free],
      ["gpt-5.6-luna", luna],
    ]),
    config: { modelDisplay: "provider" },
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/models`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: Array<Record<string, unknown>> }
    const ids = body.data.map((entry) => entry.id)
    assert.deepEqual(ids, ["anthropic-fake/deepseek-v4-flash-free", "anthropic-fake/gpt-5.6-luna"])
    const display = body.data.find((entry) => entry.id === "anthropic-fake/deepseek-v4-flash-free")
    assert.equal(display?.display_name, "fake/deepseek-v4-flash-free")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
  }
})

test("slug mode falls back to provider-qualified ids for same-named models", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const a = mapping("a", "deepseek-v4-flash", upstreamURL)
  const b = { ...mapping("b", "deepseek-v4-flash", upstreamURL), provider: "fake2" }
  const proxy = await listenProxy({
    selected: a,
    mappings: new Map([
      ["fake/deepseek-v4-flash", a],
      ["fake2/deepseek-v4-flash", b],
    ]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/models`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: Array<Record<string, unknown>> }
    const ids = body.data.map((entry) => entry.id).sort()
    assert.deepEqual(ids, ["anthropic-fake/deepseek-v4-flash", "anthropic-fake2/deepseek-v4-flash"])
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
  }
})

test("a bare model slug shared by several served providers fails loudly", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const a = mapping("a", "deepseek-v4-flash", upstreamURL)
  const b = { ...mapping("b", "deepseek-v4-flash", upstreamURL), provider: "fake2" }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: a,
    mappings: new Map([
      ["fake/deepseek-v4-flash", a],
      ["fake2/deepseek-v4-flash", b],
    ]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-deepseek-v4-flash",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 500)
    const body = (await response.json()) as { error?: { message?: string } }
    assert.match(body.error?.message ?? "", /served by multiple providers/)
    // the provider-qualified id still routes
    const qualified = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-fake/deepseek-v4-flash",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(qualified.status, 200)
    await qualified.text()
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a request for anthropic-<model> routes to the configured alias for that slug", async () => {
  const seen: Array<Record<string, unknown>> = []
  const upstream = sseUpstream((body) => seen.push(body))
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-deepseek-v4-flash-free",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.model, "deepseek-v4-flash-free")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a client-provided API key is passed through when the gateway stores no credentials", async () => {
  const seen: Array<{ authorization: string | undefined }> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    void chunks
    seen.push({ authorization: request.headers.authorization })
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write('data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n')
    response.write('data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}\n\n')
    response.end("data: [DONE]\n\n")
  })
  const upstreamURL = await listen(upstream)
  const acme = mapping("qwen3.6:35b", "qwen3.6:35b", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  // the shared gateway stores nothing: empty auth store
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
  const proxy = await listenProxy({
    selected: acme,
    mappings: new Map([["acme/qwen3.6:35b", acme]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "user-own-acme-key" },
      body: JSON.stringify({
        model: "anthropic-acme/qwen3.6:35b",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.authorization, "Bearer user-own-acme-key")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a served claude-* slug routes to its provider, not the official passthrough", async () => {
  const seen: Array<Record<string, unknown>> = []
  const upstream = sseUpstream((body) => seen.push(body))
  const upstreamURL = await listen(upstream)
  const sonnet = mapping("acme/claude-sonnet-4-6", "claude-sonnet-4-6", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: sonnet,
    mappings: new Map([["acme/claude-sonnet-4-6", sonnet]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.model, "claude-sonnet-4-6")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("admin pause/resume stops serving without killing the gateway", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  const post = (path: string, body: unknown) =>
    fetch(`${proxy.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify(body),
    })
  try {
    // serving normally
    assert.equal((await post("/v1/messages", { model: "anthropic-deepseek-v4-flash-free", max_tokens: 32, messages: [{ role: "user", content: "hi" }], stream: true })).status, 200)
    // pause
    const paused = await post("/admin/pause", {})
    assert.equal(paused.status, 200)
    assert.equal(((await paused.json()) as { paused: boolean }).paused, true)
    // health reports paused (503), messages refused with a clear error, admin still works
    assert.equal((await fetch(`${proxy.url}/health`)).status, 503)
    const refused = await post("/v1/messages", { model: "anthropic-deepseek-v4-flash-free", max_tokens: 32, messages: [{ role: "user", content: "hi" }], stream: true })
    assert.equal(refused.status, 503)
    const body = (await refused.json()) as { error?: { message?: string } }
    assert.match(body.error?.message ?? "", /paused/)
    // resume
    const resumed = await post("/admin/resume", {})
    assert.equal(((await resumed.json()) as { paused: boolean }).paused, false)
    assert.equal((await fetch(`${proxy.url}/health`)).status, 200)
    assert.equal((await post("/v1/messages", { model: "anthropic-deepseek-v4-flash-free", max_tokens: 32, messages: [{ role: "user", content: "hi" }], stream: true })).status, 200)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("an unknown non-Claude model fails loudly instead of routing to a fallback", async () => {
  const seen: Array<Record<string, unknown>> = []
  const upstream = sseUpstream((body) => seen.push(body))
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
        body: JSON.stringify({
          model: "custom-weird-model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      })
    assert.equal(response.status, 500)
    const body = (await response.json()) as { error?: { message?: string } }
    assert.match(body.error?.message ?? "", /Unknown model 'custom-weird-model'/)
    // no request should have been routed to any upstream
    assert.equal(seen.length, 0)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("an official connected model routes through the catalog fallback", async () => {
  const seen: Array<Record<string, unknown>> = []
  const upstream = sseUpstream((body) => seen.push(body))
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {
      fake: {
        id: "fake",
        npm: "@ai-sdk/openai-compatible",
        api: upstreamURL,
        models: { "deepseek-v4-pro": { id: "deepseek-v4-pro" } },
      },
    },
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.model, "deepseek-v4-pro")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("GET /stats reports uptime, per-alias counters, and served models", async () => {
  const upstream = sseUpstream(() => {})
  const upstreamURL = await listen(upstream)
  const free = mapping("freeclaude", "deepseek-v4-flash-free", upstreamURL)
  const luna = mapping("lunaclaude", "gpt-5.6-luna", upstreamURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([
      ["freeclaude", free],
      ["lunaclaude", luna],
    ]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    // a couple of requests so counters are non-zero
    await (await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-freeclaude",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })).text()
    await (await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-lunaclaude",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })).text()

    const response = await fetch(`${proxy.url}/stats`)
    assert.equal(response.status, 200)
    const stats = (await response.json()) as Record<string, any>
    assert.equal(stats.status, "ok")
    assert.equal(stats.defaultModel, "freeclaude")
    assert.equal(typeof stats.uptimeSeconds, "number")
    assert.equal(stats.aliases.freeclaude.requests, 1)
    assert.equal(stats.aliases.lunaclaude.requests, 1)
    assert.equal(stats.aliases.freeclaude.bytes > 0, true)
    assert.equal(stats.totals.requests, 2)
    assert.equal(stats.totals.errors, 0)
    assert.equal(stats.models.length, 2)
    assert.equal(stats.models[0].alias, "freeclaude")
    assert.equal(stats.models[0].model, "deepseek-v4-flash-free")
    assert.equal(stats.active, 0)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("an upstream error increments the alias error counter and records the message", async () => {
  const failing = createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: "boom" } }))
  })
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve))
  const address = failing.address()
  assert.ok(address && typeof address !== "string")
  const failingURL = `http://127.0.0.1:${address.port}`

  const free = mapping("freeclaude", "deepseek-v4-flash-free", failingURL)
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "anthropic-freeclaude",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    await response.text()
    const stats = (await (await fetch(`${proxy.url}/stats`)).json()) as Record<string, any>
    assert.equal(stats.aliases.freeclaude.requests, 1)
    assert.equal(stats.aliases.freeclaude.errors, 1)
    assert.equal(stats.aliases.freeclaude.lastError, "boom")
    assert.equal(typeof stats.aliases.freeclaude.lastErrorAt, "number")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => failing.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})
test("a tool call streamed as input deltas is not re-emitted as a second tool_use", () => {
  const encoder = new AnthropicStreamEncoder({ id: "msg_1", model: "m" })
  const output: string[] = [...encoder.start()]
  const events: LLMEvent[] = [
    { type: "tool-input-start", id: "call_1", name: "Bash" },
    { type: "tool-input-delta", id: "call_1", name: "Bash", text: "{\"cmd\":" },
    { type: "tool-input-delta", id: "call_1", name: "Bash", text: "\"ls\"}" },
    { type: "tool-input-end", id: "call_1", name: "Bash" },
    { type: "tool-call", id: "call_1", name: "Bash", input: { cmd: "ls" } },
    { type: "finish", reason: "tool-calls", usage: { outputTokens: 1, visibleOutputTokens: 1 } },
  ]
  for (const event of events) output.push(...encoder.accept(event))
  const toolUses = output.join("").match(/"type":"tool_use"/g)?.length ?? 0
  assert.equal(toolUses, 1)
  assert.match(output.join(""), /"id":"call_1"/)
})

test("a tool call with no streaming deltas still renders a single tool_use", () => {
  const encoder = new AnthropicStreamEncoder({ id: "msg_1", model: "m" })
  const output: string[] = [...encoder.start()]
  const events: LLMEvent[] = [
    { type: "tool-call", id: "call_2", name: "Bash", input: { cmd: "ls" } },
    { type: "finish", reason: "tool-calls", usage: { outputTokens: 1, visibleOutputTokens: 1 } },
  ]
  for (const event of events) output.push(...encoder.accept(event))
  const toolUses = output.join("").match(/"type":"tool_use"/g)?.length ?? 0
  assert.equal(toolUses, 1)
})

test("an official claude-* model forwards to Anthropic with the client credential", async () => {
  let receivedBody = ""
  let receivedAuth = ""
  let receivedVersion = ""
  let receivedBeta = ""
  const anthropic = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    receivedBody = Buffer.concat(chunks).toString("utf8")
    receivedAuth = String(request.headers.authorization ?? "")
    receivedVersion = String(request.headers["anthropic-version"] ?? "")
    receivedBeta = String(request.headers["anthropic-beta"] ?? "")
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n')
    response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => anthropic.listen(0, "127.0.0.1", resolve))
  const address = anthropic.address()
  assert.ok(address && typeof address !== "string")
  const anthropicURL = `http://127.0.0.1:${address.port}`

  const free = mapping("freeclaude", "deepseek-v4-flash-free", "http://127.0.0.1:1")
  const previousAnthropicAPI = process.env.CCOC_ANTHROPIC_API
  process.env.CCOC_ANTHROPIC_API = anthropicURL
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
        "x-api-key": "local",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(receivedAuth, "Bearer sk-test")
    assert.equal(receivedVersion, "2023-06-01")
    assert.equal(receivedBeta, "oauth-2025-04-20")
    assert.match(receivedBody, /"model":"claude-opus-5"/)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => anthropic.close((error) => (error ? reject(error) : resolve())))
    if (previousAnthropicAPI === undefined) delete process.env.CCOC_ANTHROPIC_API
    else process.env.CCOC_ANTHROPIC_API = previousAnthropicAPI
  }
})

test("an official model without a credential returns a clear passthrough error", async () => {
  const free = mapping("freeclaude", "deepseek-v4-flash-free", "http://127.0.0.1:1")
  const previousAnthropicAPI = process.env.CCOC_ANTHROPIC_API
  process.env.CCOC_ANTHROPIC_API = "http://127.0.0.1:1"
  const proxy = await listenProxy({
    selected: free,
    mappings: new Map([["freeclaude", free]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 502)
    const body = (await response.json()) as { error?: { message?: string } }
    assert.match(body.error?.message ?? "", /No Anthropic credential/)
  } finally {
    await proxy.close()
    if (previousAnthropicAPI === undefined) delete process.env.CCOC_ANTHROPIC_API
    else process.env.CCOC_ANTHROPIC_API = previousAnthropicAPI
  }
})


