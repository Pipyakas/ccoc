export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Anthropic server-side tool types. Claude Code sends these without an
 * `input_schema`; upstream providers cannot model them, so they must never
 * reach the provider. */
export const SERVER_SIDE_TOOL_TYPES = new Set([
  "web_search_20250305",
  "web_search_20250819",
  "web_search_20250930",
  "web_search_20251023",
  "text_editor_20250124",
  "code_execution_20250124",
  "bash_20250325",
])

const SERVER_SIDE_TOOL_NAMES = new Set(["web_search", "text_editor", "code_execution", "bash"])

export function isServerSideTool(tool: { type?: string; name?: string; input_schema?: unknown }) {
  if (tool.type && SERVER_SIDE_TOOL_TYPES.has(tool.type)) return true
  return Boolean(tool.name && SERVER_SIDE_TOOL_NAMES.has(tool.name) && !tool.input_schema)
}

export const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query" },
    maxResults: { type: "number", description: "Maximum number of results to return" },
  },
  required: ["query"],
} as const

export const WEB_SEARCH_DESCRIPTION =
  "Search the web for up-to-date information. Use when the user asks about recent events, current documentation, or anything you are not certain about."

export function extractSearchQuery(input: unknown): string {
  if (input && typeof input === "object") {
    const query = (input as Record<string, unknown>).query
    if (typeof query === "string" && query.trim()) return query.trim()
  }
  const serialized = JSON.stringify(input)
  return serialized && serialized !== "{}" ? serialized : "web search"
}

export async function searchWeb(
  query: string,
  options: { backend?: "ddg" | "brave" | "exa" | "parallel"; apiKey?: string },
): Promise<SearchResult[]> {
  if (options.backend === "brave") {
    if (!options.apiKey) throw new Error("Web search backend 'brave' needs an apiKey in the ccoc config")
    return searchBrave(query, options.apiKey)
  }
  if (options.backend === "exa") {
    return searchExa(query, options.apiKey)
  }
  if (options.backend === "parallel") {
    return searchParallel(query, options.apiKey)
  }
  return searchDuckDuckGo(query)
}

/** Resolve the search backend the way opencode does: explicit config wins,
 * then OPENCODE_WEBSEARCH_PROVIDER, then Exa when its key is present,
 * otherwise DuckDuckGo. */
export function resolveSearchBackend(
  configured: { backend?: "ddg" | "brave" | "exa" | "parallel"; apiKey?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { backend: "ddg" | "brave" | "exa" | "parallel"; apiKey?: string } {
  if (configured?.backend) return { backend: configured.backend, apiKey: configured.apiKey }
  const override = env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return { backend: override, apiKey: exaKey(env) }
  if (env.EXA_API_KEY) return { backend: "exa", apiKey: env.EXA_API_KEY }
  return { backend: "ddg" }
}

const exaKey = (env: NodeJS.ProcessEnv) => env.EXA_API_KEY

/** The exact Exa MCP call opencode makes for its built-in websearch tool. */
export async function searchExa(query: string, apiKey?: string): Promise<SearchResult[]> {
  const url = apiKey ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}` : "https://mcp.exa.ai/mcp"
  const text = await mcpCall(url, "web_search_exa", {
    query,
    type: "auto",
    numResults: 5,
    livecrawl: "fallback",
    contextMaxCharacters: 10_000,
  })
  return [{ title: "Web search results", url: "", snippet: text }]
}

/** The exact Parallel MCP call opencode makes for its websearch tool. */
export async function searchParallel(query: string, apiKey?: string): Promise<SearchResult[]> {
  const text = await mcpCall(
    "https://search.parallel.ai/mcp",
    "web_search",
    {
      objective: query,
      search_queries: [query],
      session_id: "ccoc",
      model_name: "ccoc",
    },
    apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  )
  return [{ title: "Web search results", url: "", snippet: text }]
}

async function mcpCall(url: string, tool: string, arguments_: Record<string, unknown>, headers?: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: arguments_ },
    }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new Error(`${tool} request failed with HTTP ${response.status}`)
  const body = await response.text()
  const text = parseMcpResult(body)
  if (!text) throw new Error(`${tool} returned no results`)
  return text
}

function parseMcpResult(body: string): string | undefined {
  const payloads: string[] = [body.trim()]
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) payloads.push(line.substring(6).trim())
  }
  for (const payload of payloads) {
    if (!payload.startsWith("{")) continue
    try {
      const parsed = JSON.parse(payload) as {
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      const text = parsed.result?.content?.find((item) => item.text)?.text
      if (text) return text
    } catch {}
  }
  return undefined
}

export async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "ccoc/0.1 (+https://github.com/Pipyakas/ccoc)" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`)
  const html = await response.text()
  const results: SearchResult[] = []
  const pattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && results.length < 5) {
    const href = match[1] ?? ""
    const url = decodeDuckDuckGoUrl(href)
    results.push({
      title: cleanHtml(match[2] ?? ""),
      url,
      snippet: cleanHtml(match[3] ?? ""),
    })
  }
  if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results")
  return results
}

export async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Brave search failed with HTTP ${response.status}`)
  const data = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
  return (data.web?.results ?? []).map((result) => ({
    title: result.title ?? "",
    url: result.url ?? "",
    snippet: result.description ?? "",
  }))
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No web results found."
  return results
    .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
    .join("\n")
}

function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href)
    const redirect = url.searchParams.get("uddg")
    if (redirect) return decodeURIComponent(redirect)
  } catch {}
  return href
}

function cleanHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}
