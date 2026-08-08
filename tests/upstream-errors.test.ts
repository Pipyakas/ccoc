import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { test } from "node:test"
import { listenProxy } from "../src/server.js"
import type { ResolvedMapping } from "../src/catalog.js"

const baseMapping: ResolvedMapping = {
  alias: "fake",
  displayName: "fake-model",
  provider: "fake",
  model: "fake-model",
  protocol: "openai-chat",
  baseURL: "http://127.0.0.1:1",
  headers: {},
}

const quotaJSON = JSON.stringify({
  type: "error",
  error: {
    type: "GoUsageLimitError",
    message: "5-hour usage limit reached. Resets in 1hr 23min. Enable usage: https://opencode.ai/workspace/wrk_01",
  },
})

/** Start a counting upstream plus a proxy bound to it; cleanup via `close()`. */
async function upstreamProxy(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const hits = { count: 0 }
  const server = createServer((request, response) => {
    hits.count += 1
    respond(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const mapping: ResolvedMapping = { ...baseMapping, baseURL: `http://127.0.0.1:${address.port}` }
  const proxy = await listenProxy({
    selected: mapping,
    mappings: new Map([["fake", mapping]]),
    config: {},
    catalog: {},
    openCodeConfig: {},
  })
  return {
    hits,
    proxy,
    close: async () => {
      await proxy.close()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function post(url: string) {
  return fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "local" },
    body: JSON.stringify({
      model: "fake",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  })
}

function withAuth(run: () => Promise<void>) {
  const previous = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ fake: { type: "api", key: "secret" } })
  return run().finally(() => {
    if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previous
  })
}

test("a 429 quota response is not retried and surfaces the provider message", async () => {
  await withAuth(async () => {
    const { hits, proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json" })
      response.end(quotaJSON)
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      // quota before any content -> real HTTP 429, which Claude Code renders
      // cleanly (an SSE error frame in a 200 stream reads as malformed)
      assert.equal(response.status, 429)
      // quota errors are permanent: the upstream must be hit exactly once
      assert.equal(hits.count, 1)
      assert.match(body, /"type":"error"/)
      assert.match(body, /5-hour usage limit reached/)
      assert.match(body, /Enable usage: https:\/\/opencode\.ai\/workspace\/wrk_01/)
      // the raw wrapper and the HTTP status are stripped from the message
      assert.doesNotMatch(body, /RequestExecutor\.execute/)
      assert.doesNotMatch(body, /HTTP 429/)
    } finally {
      await close()
    }
  })
})

test("an HTTP 200 JSON error body surfaces as an error instead of an empty reply", async () => {
  await withAuth(async () => {
    const { hits, proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(quotaJSON)
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      assert.equal(response.status, 429)
      assert.equal(hits.count, 1)
      assert.match(body, /"type":"error"/)
      assert.match(body, /5-hour usage limit reached/)
      // not silently swallowed into a well-formed-but-empty assistant message
      assert.doesNotMatch(body, /"type":"message_delta","delta":\{"stop_reason":"end_turn"/)
    } finally {
      await close()
    }
  })
})

test("an HTTP 200 empty body surfaces as a clear error", async () => {
  await withAuth(async () => {
    const { proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end()
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      assert.equal(response.status, 502)
      assert.match(body, /"type":"error"/)
      assert.match(body, /Provider returned an empty HTTP 200 response/)
    } finally {
      await close()
    }
  })
})

test("an HTTP 200 SSE stream that only carries an error frame surfaces its message", async () => {
  await withAuth(async () => {
    const { proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write(`data: ${quotaJSON}\n\n`)
      response.end()
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      assert.equal(response.status, 429)
      assert.match(body, /"type":"error"/)
      assert.match(body, /5-hour usage limit reached/)
    } finally {
      await close()
    }
  })
})

test("a plain HTTP 200 stream still streams normally (no framing false positive)", async () => {
  await withAuth(async () => {
    const { hits, proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write('data: {"id":"u","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n')
      response.write('data: {"id":"u","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
      response.end("data: [DONE]\n\n")
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      assert.equal(response.status, 200)
      assert.equal(hits.count, 1)
      assert.match(body, /"text_delta","text":"ok"/)
      assert.match(body, /"stop_reason":"end_turn"/)
      assert.doesNotMatch(body, /"type":"error"/)
    } finally {
      await close()
    }
  })
})

test("a context-overflow error is rewritten to Anthropic's prompt-is-too-long wording", async () => {
  await withAuth(async () => {
    const { proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(400, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "prompt token count of 300000 exceeds the limit of 200000" } }))
    })
    try {
      const response = await post(proxy.url)
      const body = await response.text()
      assert.equal(response.status, 502)
      assert.match(body, /"type":"error"/)
      assert.match(body, /prompt is too long/)
      // the provider's own wording must not leak through
      assert.doesNotMatch(body, /300000 exceeds/)
    } finally {
      await close()
    }
  })
})

test("malformed JSON or an invalid request returns HTTP 400, not 500", async () => {
  const { proxy, close } = await upstreamProxy(() => {})
  try {
    const badJson = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    })
    assert.equal(badJson.status, 400)
    const badJsonBody = (await badJson.json()) as { error?: { type?: string; message?: string } }
    assert.equal(badJsonBody.error?.type, "invalid_request_error")
    assert.match(badJsonBody.error?.message ?? "", /JSON/)

    const noMessages = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake", max_tokens: 32 }),
    })
    assert.equal(noMessages.status, 400)
    const noMessagesBody = (await noMessages.json()) as { error?: { type?: string } }
    assert.equal(noMessagesBody.error?.type, "invalid_request_error")
  } finally {
    await close()
  }
})

test("a non-streaming request surfaces a quota error as HTTP 429", async () => {
  await withAuth(async () => {
    const { proxy, close } = await upstreamProxy((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json" })
      response.end(quotaJSON)
    })
    try {
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "local" },
        body: JSON.stringify({
          model: "fake",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      })
      const body = await response.text()
      assert.equal(response.status, 429)
      assert.match(body, /"type":"error"/)
      assert.match(body, /5-hour usage limit reached/)
    } finally {
      await close()
    }
  })
})
