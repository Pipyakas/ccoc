import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { listenProxy } from "../src/server.js"
import { resolveCredential } from "../src/auth.js"
import { resolveMapping, type ResolvedMapping } from "../src/catalog.js"
import type { AnthropicRequest, ProviderCatalog } from "../src/types.js"

test("resolves an OpenCode OpenAI OAuth model to the Codex route", () => {
  const catalog: ProviderCatalog = {
    openai: {
      id: "openai",
      npm: "@ai-sdk/openai",
      models: { "gpt-5.4": { id: "gpt-5.4" } },
    },
  }
  const result = resolveMapping(
    "codex",
    {},
    catalog,
    {},
    {
      openai: {
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      },
    },
    { codex: "openai/gpt-5.4" },
  )
  assert.equal(result.provider, "openai")
  assert.equal(result.protocol, "openai-responses")
  assert.equal(result.baseURL, "https://chatgpt.com/backend-api/codex")
  assert.equal(result.codex, true)
  assert.equal(result.displayName, "gpt-5.4")
})

test("non-codex OpenAI routes are not flagged", () => {
  const catalog: ProviderCatalog = {
    openai: {
      id: "openai",
      npm: "@ai-sdk/openai",
      models: { "gpt-5.4": { id: "gpt-5.4" } },
    },
  }
  const result = resolveMapping(
    "openai/gpt-5.4",
    {},
    catalog,
    {},
    { openai: { type: "api", key: "k" } },
  )
  assert.equal(result.baseURL, "https://api.openai.com/v1")
  assert.equal(result.codex, false)
})

test("display name is the bare model id for direct selections and aliases", () => {
  const catalog: ProviderCatalog = {
    "opencode-go": {
      id: "opencode-go",
      npm: "@ai-sdk/openai-compatible",
      models: { "deepseek-v4-flash": { id: "deepseek-v4-flash" } },
    },
  }
  const direct = resolveMapping("opencode-go/deepseek-v4-flash", {}, catalog, {}, {
    "opencode-go": { type: "api", key: "k" },
  })
  assert.equal(direct.displayName, "deepseek-v4-flash")
  const aliased = resolveMapping("fast", {}, catalog, {}, {
    "opencode-go": { type: "api", key: "k" },
  }, { fast: "opencode-go/deepseek-v4-flash" })
  assert.equal(aliased.displayName, "deepseek-v4-flash")
})

test("resolveCredential falls back to the client-provided key when nothing is stored", async () => {
  const noKey = await resolveCredential(
    { provider: "acme", model: "qwen3.6:35b", protocol: "openai-chat" },
    { id: "acme", npm: "@ai-sdk/openai-compatible" },
    undefined,
    {},
    "user-own-acme-key",
  )
  assert.equal(noKey.headers.Authorization, "Bearer user-own-acme-key")
  assert.equal(noKey.source, "acme client-provided key")
  // stored keys still win over the passthrough
  const stored = await resolveCredential(
    { provider: "acme", model: "qwen3.6:35b", protocol: "openai-chat" },
    { id: "acme", npm: "@ai-sdk/openai-compatible" },
    undefined,
    { acme: { type: "api", key: "stored-key" } },
    "client-key",
  )
  assert.equal(stored.headers.Authorization, "Bearer stored-key")
  // no key anywhere -> clear error
  await assert.rejects(
    () =>
      resolveCredential(
        { provider: "acme", model: "qwen3.6:35b", protocol: "openai-chat" },
        { id: "acme", npm: "@ai-sdk/openai-compatible" },
        undefined,
        {},
      ),
    /No credentials found for 'acme'/,
  )
})

test("clientAuth models require the client key even when the gateway stores one", async () => {
  // the store HAS a key, but clientAuth means the client's key wins anyway
  const client = await resolveCredential(
    { provider: "acme", model: "qwen3.6:35b", protocol: "openai-chat", clientAuth: true },
    { id: "acme", npm: "@ai-sdk/openai-compatible" },
    undefined,
    { acme: { type: "api", key: "stored-key" } },
    "client-acme-key",
  )
  assert.equal(client.headers.Authorization, "Bearer client-acme-key")
  assert.equal(client.source, "acme client-provided key")
  // no client key -> loud error even though the store has one
  await assert.rejects(
    () =>
      resolveCredential(
        { provider: "acme", model: "qwen3.6:35b", protocol: "openai-chat", clientAuth: true },
        { id: "acme", npm: "@ai-sdk/openai-compatible" },
        undefined,
        { acme: { type: "api", key: "stored-key" } },
      ),
    /ANTHROPIC_AUTH_TOKEN/,
  )
})

test("refreshes expired OpenAI OAuth credentials for Codex", async () => {
  const originalFetch = globalThis.fetch
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  // OPENCODE_AUTH_CONTENT makes persistAuthEntry a no-op: this test must never
  // write to the real auth.json (it would overwrite real OAuth tokens).
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
  let refreshURL = ""
  globalThis.fetch = async (input, init) => {
    refreshURL = String(input)
    assert.equal(init?.method, "POST")
    return new Response(
      JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  try {
    const credential = await resolveCredential(
      { provider: "openai", model: "gpt-5.4", protocol: "openai-responses" },
      { id: "openai", npm: "@ai-sdk/openai" },
      undefined,
      {
        openai: {
          type: "oauth",
          refresh: "old-refresh",
          access: "",
          expires: 0,
          accountId: "acct",
        },
      },
    )
    assert.equal(refreshURL, "https://auth.openai.com/oauth/token")
    assert.equal(credential.headers.Authorization, "Bearer new-access")
    assert.equal(credential.headers["ChatGPT-Account-Id"], "acct")
  } finally {
    globalThis.fetch = originalFetch
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("executes Claude Code's web_search server-side via the opencode backend loop", async () => {
  const upstreamRequests: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    upstreamRequests.push(body)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    const toolTurn = (body.messages as Array<{ role: string }> | undefined)?.every(
      (message: { role: string }) => message.role !== "tool",
    )
    if (toolTurn) {
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ws_1","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"opencode proxy\\"}"}}]},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      )
    } else {
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"Found it: opencode docs"},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":3}}\n\n',
      )
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const upstreamURL = `http://127.0.0.1:${address.port}`

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://mcp.exa.ai")) {
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "1. OpenCode Docs\nhttps://opencode.ai/docs" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return originalFetch(input, init)
  }) as typeof fetch

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: { webSearch: { backend: "exa", maxTurns: 2 } },
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        messages: [{ role: "user", content: "Search the web for opencode proxy" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        stream: true,
      }),
    })
    const body = await response.text()
    assert.equal(response.status, 200)
    // web_search is executed server-side: Claude Code sees a server_tool_use
    // plus a web_search_tool_result (Anthropic's shape), not a tool_use/tool_result
    // cycle — so Claude Code renders results instead of running its own search.
    assert.match(body, /"type":"server_tool_use"/)
    assert.match(body, /"type":"web_search_tool_result"/)
    assert.doesNotMatch(body, /"type":"tool_use"/)
    assert.doesNotMatch(body, /"type":"tool_result"/)
    assert.match(body, /Found it: opencode docs/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.equal(upstreamRequests.length, 2)
    const toolSeen = upstreamRequests.every((request) =>
      (request.tools as Array<{ function?: { name?: string; parameters?: unknown } }>).every(
        (tool) => tool.function?.name !== "web_search" || Boolean(tool.function.parameters),
      ),
    )
    assert.equal(toolSeen, true)
    const followUp = upstreamRequests[1]
    assert.ok(followUp, "expected a follow-up request")
    assert.equal((followUp.messages as Array<{ role: string }>).some((message) => message.role === "tool"), true)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    globalThis.fetch = originalFetch
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a failed web search backend does not abort the message", async () => {
  const upstreamRequests: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    upstreamRequests.push(body)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    const toolTurn = (body.messages as Array<{ role: string }> | undefined)?.every(
      (message: { role: string }) => message.role !== "tool",
    )
    if (toolTurn) {
      response.write(responseForToolCall("web_search"))
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      )
    } else {
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"I could not search, so here is a direct answer."},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":3}}\n\n',
      )
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const upstreamURL = `http://127.0.0.1:${address.port}`

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://mcp.exa.ai")) {
      return new Response("search backend unavailable", { status: 503 })
    }
    return originalFetch(input, init)
  }) as typeof fetch

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: { webSearch: { backend: "exa", maxTurns: 2 } },
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        messages: [{ role: "user", content: "Search the web for opencode" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        stream: true,
      }),
    })
    const body = await response.text()
    assert.equal(response.status, 200)
    // web_search is server-side: server_tool_use + (empty fallback) tool_result,
    // then the model's direct answer.
    assert.match(body, /"type":"server_tool_use"/)
    assert.doesNotMatch(body, /"type":"tool_use"/)
    assert.match(body, /I could not search/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.doesNotMatch(body, /"type":"error"/)
    assert.equal(upstreamRequests.length, 2)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    globalThis.fetch = originalFetch
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("web search cap drops the tool and terminates the message", async () => {
  const upstreamRequests: Array<Record<string, unknown>> = []
  let requestNumber = 0
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    upstreamRequests.push(body)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    requestNumber += 1
    if (requestNumber <= 2) {
      response.write(responseForToolCall("web_search"))
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      )
    } else {
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"Final answer without more searching."},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":3}}\n\n',
      )
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const upstreamURL = `http://127.0.0.1:${address.port}`

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://mcp.exa.ai")) {
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: "1. OpenCode Docs\nhttps://opencode.ai/docs" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return originalFetch(input, init)
  }) as typeof fetch

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: { webSearch: { backend: "exa", maxTurns: 1 } },
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        messages: [{ role: "user", content: "Search more than once" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        stream: true,
      }),
    })
    const body = await response.text()
    assert.equal(response.status, 200)
    // the cap is handled server-side; the client sees server_tool_use blocks but
    // only the final answer text
    assert.match(body, /"type":"server_tool_use"/)
    assert.doesNotMatch(body, /"type":"tool_use"/)
    assert.match(body, /Final answer without more searching/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.equal(upstreamRequests.length, 3)
    const secondRequest = upstreamRequests[1] as { tools?: Array<{ function?: { name?: string } }> }
    assert.equal((secondRequest.tools ?? []).some((tool) => tool.function?.name === "web_search"), true)
    const lastRequest = upstreamRequests[2] as { tools?: Array<{ function?: { name?: string } }> }
    assert.equal((lastRequest.tools ?? []).some((tool) => tool.function?.name === "web_search"), false)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    globalThis.fetch = originalFetch
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a reasoningEffort preset applies on launch and yields once the user changes effort", async () => {
  const upstreamBodies: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(
      'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
    )
    response.write('data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}\n\n')
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const upstreamURL = `http://127.0.0.1:${address.port}`

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
    reasoning: true,
    reasoningOptions: ["low", "high", "max"],
    reasoningEffort: "max",
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const post = (budget: number) =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "local",
          "x-claude-code-session-id": "sess-default-effort",
        },
        body: JSON.stringify({
          model: "fake",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "enabled", budget_tokens: budget },
          stream: true,
        }),
      })
    // launch default: the preset wins regardless of the budget Claude Code sent
    await (await post(80_000)).text()
    assert.equal(upstreamBodies[0]?.reasoning_effort, "max")
    // user changed /effort to low -> budget deviates from the baseline, map live
    await (await post(8_000)).text()
    assert.equal(upstreamBodies[1]?.reasoning_effort, "low")
    // still in the user's control afterwards
    await (await post(30_000)).text()
    assert.equal(upstreamBodies[2]?.reasoning_effort, "high")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("budget drift within the launch tier keeps the reasoningEffort preset", async () => {
  const upstreamBodies: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(
      'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
    )
    response.write('data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}\n\n')
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: `http://127.0.0.1:${address.port}`,
    headers: {},
    reasoning: true,
    reasoningOptions: ["low", "high", "max"],
    reasoningEffort: "max",
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const post = (thinking?: AnthropicRequest["thinking"]) =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "local",
          "x-claude-code-session-id": "sess-drift",
        },
        body: JSON.stringify({
          model: "fake",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          thinking,
          stream: true,
        }),
      })
    // launch default applies; in-tier budget drift (context-length jitter) does
    // not count as the user changing /effort, so max is not lost
    await (await post({ type: "enabled", budget_tokens: 80_000 })).text()
    assert.equal(upstreamBodies[0]?.reasoning_effort, "max")
    await (await post({ type: "enabled", budget_tokens: 88_000 })).text()
    assert.equal(upstreamBodies[1]?.reasoning_effort, "max")
    await (await post({ type: "enabled", budget_tokens: 120_000 })).text()
    assert.equal(upstreamBodies[2]?.reasoning_effort, "max")
    // a request whose budget leaves the launch tier is a real user change
    await (await post({ type: "enabled", budget_tokens: 8_000 })).text()
    assert.equal(upstreamBodies[3]?.reasoning_effort, "low")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a no-thinking launch request anchors the preset to the configured effort", async () => {
  const upstreamBodies: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(
      'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
    )
    response.write('data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}\n\n')
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: `http://127.0.0.1:${address.port}`,
    headers: {},
    reasoning: true,
    reasoningOptions: ["low", "high", "max"],
    reasoningEffort: "max",
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const post = (thinking?: AnthropicRequest["thinking"]) =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "local",
          "x-claude-code-session-id": "sess-no-thinking",
        },
        body: JSON.stringify({
          model: "fake",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          thinking,
          stream: true,
        }),
      })
    // the model is not recognized as effort-capable yet: no thinking block, so
    // the preset applies and anchors the baseline to the configured effort
    await (await post(undefined)).text()
    assert.equal(upstreamBodies[0]?.reasoning_effort, "max")
    // once Claude Code enables thinking in the configured tier, the default
    // stays active instead of collapsing to a budget-mapped level
    await (await post({ type: "enabled", budget_tokens: 80_000 })).text()
    assert.equal(upstreamBodies[1]?.reasoning_effort, "max")
    // a genuine change to a lower tier still yields
    await (await post({ type: "enabled", budget_tokens: 8_000 })).text()
    assert.equal(upstreamBodies[2]?.reasoning_effort, "low")
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

test("a stream that closes without a finish signal still terminates the message", async () => {
  // Some providers (e.g. OpenCode Go's gpt-5.6-luna) close the stream without
  // ever setting finish_reason or sending the [DONE] sentinel; the LLM layer
  // then never emits a finish event. The proxy must still close the Anthropic
  // message or Claude Code reports an empty/malformed HTTP 200.
  const upstream = createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(
      'data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
    )
    response.end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: `http://127.0.0.1:${address.port}`,
    headers: {},
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    const body = await response.text()
    assert.equal(response.status, 200)
    // the emitted content is delivered and every open block is closed
    assert.match(body, /"type":"text_delta","text":"ok"/)
    assert.match(body, /"type":"content_block_stop"/)
    // the message terminates cleanly instead of ending mid-stream
    assert.match(body, /"type":"message_delta"/)
    assert.match(body, /"type":"message_stop"/)
    assert.doesNotMatch(body, /"type":"error"/)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})

function responseForToolCall(toolName: string) {
  return `data: {"id":"u","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ws_1","type":"function","function":{"name":"${toolName}","arguments":"{}"}}]},"finish_reason":null}]}\n\n`
}

test("bridges Claude Messages streaming through an OpenCode native route", async () => {
  const upstreamRequests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamRequests.push({
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      authorization: request.headers.authorization,
    })
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (Array.isArray((upstreamRequests.at(-1)?.body as { tools?: unknown[] }).tools)) {
      response.write(
        'data: {"id":"upstream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n',
      )
    } else {
      response.write('data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n')
      response.write('data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n')
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const upstreamURL = `http://127.0.0.1:${address.port}`

  const mapping: ResolvedMapping = {
    alias: "fake",
    displayName: "fake-model",
    provider: "fake",
    model: "fake-model",
    protocol: "openai-chat",
    baseURL: upstreamURL,
    headers: {},
  }
  const catalog: ProviderCatalog = {
    fake: { id: "fake", npm: "@ai-sdk/openai-compatible", api: upstreamURL },
  }
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })

  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog,
    openCodeConfig: {},
  })

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        system: "Be brief.",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: message_start/)
    assert.match(body, /"text_delta","text":"hello"/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.equal(upstreamRequests.length, 1)
    assert.equal(upstreamRequests[0]?.authorization, "Bearer secret")
    assert.equal(upstreamRequests[0]?.body.model, "fake-model")
    assert.deepEqual(upstreamRequests[0]?.body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Say hello" },
    ])

    const toolResponse = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "fake",
        max_tokens: 32,
        messages: [{ role: "user", content: "Read the README" }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
        stream: true,
      }),
    })
    const toolBody = await toolResponse.text()
    assert.equal(toolResponse.status, 200)
    assert.match(toolBody, /"type":"tool_use"/)
    assert.match(toolBody, /"stop_reason":"tool_use"/)
    assert.equal((upstreamRequests[1]?.body.tools as unknown[]).length, 1)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
  }
})
