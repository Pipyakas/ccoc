import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { authPath } from "./config.js"
import type {
  ApiAuth,
  AuthInfo,
  AuthStore,
  ModelMapping,
  OAuthAuth,
  ProviderCatalogEntry,
  WellKnownAuth,
} from "./types.js"

const OPENAI_ISSUER = "https://auth.openai.com"
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

export interface ResolvedCredential {
  token: string
  headers: Record<string, string>
  source: string
}

export async function loadAuthStore(): Promise<AuthStore> {
  const content = process.env.OPENCODE_AUTH_CONTENT
  if (content) return decodeAuthStore(JSON.parse(content))

  try {
    return decodeAuthStore(JSON.parse(await readFile(authPath(), "utf8")))
  } catch {
    return {}
  }
}

function decodeAuthStore(input: unknown): AuthStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const result: AuthStore = {}
  for (const [provider, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    if (item.type === "api" && typeof item.key === "string") {
      result[provider] = {
        type: "api",
        key: item.key,
        ...(isStringRecord(item.metadata) ? { metadata: item.metadata } : {}),
      }
    } else if (
      item.type === "oauth" &&
      typeof item.refresh === "string" &&
      typeof item.access === "string" &&
      typeof item.expires === "number"
    ) {
      result[provider] = {
        type: "oauth",
        refresh: item.refresh,
        access: item.access,
        expires: item.expires,
        ...(typeof item.accountId === "string" ? { accountId: item.accountId } : {}),
        ...(typeof item.enterpriseUrl === "string" ? { enterpriseUrl: item.enterpriseUrl } : {}),
      }
    } else if (item.type === "wellknown" && typeof item.key === "string" && typeof item.token === "string") {
      result[provider] = { type: "wellknown", key: item.key, token: item.token }
    }
  }
  return result
}

export async function resolveCredential(
  mapping: ModelMapping,
  provider: ProviderCatalogEntry | undefined,
  providerOptions: { apiKey?: unknown; headers?: Record<string, string> } | undefined,
  auth: AuthStore,
  /** API key sent by the client (x-api-key / Authorization Bearer). Used as
   * the last resort on a shared gateway that stores no credentials itself:
   * each client's own key is passed through to the provider. */
  clientKey?: string,
): Promise<ResolvedCredential> {
  const providerID = mapping.authProvider ?? mapping.provider
  const entry = findAuth(auth, providerID)
  const configuredKey = typeof providerOptions?.apiKey === "string" ? providerOptions.apiKey : undefined
  const environmentKey = provider?.env?.map((name) => process.env[name]).find((value): value is string => Boolean(value))

  // Client-key models (clientAuth): the client's own API key is the credential,
  // on every gateway (local or remote) — the gateway's store is not consulted,
  // so users bring their own key wherever they connect from.
  if (mapping.clientAuth) {
    if (!clientKey) {
      throw new Error(
        `'${providerID}' models require your own API key - set ANTHROPIC_AUTH_TOKEN to your ${providerID} key (it is sent to the gateway with every request).`,
      )
    }
    const headers: Record<string, string> = {
      ...(providerOptions?.headers ?? {}),
      ...(mapping.headers ?? {}),
    }
    if (mapping.protocol === "gemini") headers["x-goog-api-key"] = clientKey
    else if (mapping.protocol === "anthropic-messages") headers["x-api-key"] = clientKey
    else headers.Authorization = `Bearer ${clientKey}`
    return { token: clientKey, headers, source: `${providerID} client-provided key` }
  }

  if (entry?.type === "oauth") {
    const refreshed = normalizeProvider(providerID) === "openai" ? await ensureOpenAIAuth(providerID, entry, auth) : entry
    const headers: Record<string, string> = {
      ...(providerOptions?.headers ?? {}),
      ...(mapping.headers ?? {}),
      Authorization: `Bearer ${refreshed.access}`,
    }
    if (refreshed.accountId) headers["ChatGPT-Account-Id"] = refreshed.accountId
    return { token: refreshed.access, headers, source: `${providerID} OAuth` }
  }

  const token =
    entry?.type === "api"
      ? entry.key
      : entry?.type === "wellknown"
        ? entry.token
        : configuredKey ?? environmentKey ?? clientKey
  if (!token) {
    throw new Error(
      `No credentials found for '${providerID}'. Set ANTHROPIC_AUTH_TOKEN to your ${providerID} API key ` +
        `(sent to the gateway with every request) or configure the key on the gateway itself.`,
    )
  }

  const headers: Record<string, string> = {
    ...(providerOptions?.headers ?? {}),
    ...(mapping.headers ?? {}),
  }
  if (mapping.protocol === "gemini") headers["x-goog-api-key"] = token
  else if (mapping.protocol === "anthropic-messages") headers["x-api-key"] = token
  else headers.Authorization = `Bearer ${token}`
  const source =
    entry?.type === "api"
      ? `${providerID} API key`
      : entry?.type === "wellknown"
        ? `${providerID} well-known key`
        : clientKey !== undefined && configuredKey === undefined && environmentKey === undefined
          ? `${providerID} client-provided key`
          : `${providerID} API key`
  return { token, headers, source }
}

let openaiRefreshPromise: Promise<OAuthAuth> | undefined

async function ensureOpenAIAuth(providerID: string, auth: OAuthAuth, store: AuthStore): Promise<OAuthAuth> {
  if (auth.access && auth.expires > Date.now() + 30_000) return auth
  if (!auth.refresh) throw new Error(`OpenAI OAuth credentials for '${providerID}' have no refresh token.`)

  if (!openaiRefreshPromise) {
    openaiRefreshPromise = refreshOpenAIToken(auth.refresh)
      .then(async (tokens) => {
        const refreshed: OAuthAuth = {
          type: "oauth",
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(extractAccountId(tokens) ?? auth.accountId
            ? { accountId: extractAccountId(tokens) ?? auth.accountId }
            : {}),
        }
        store[providerID] = refreshed
        await persistAuthEntry(providerID, refreshed)
        return refreshed
      })
      .finally(() => {
        openaiRefreshPromise = undefined
      })
  }
  return openaiRefreshPromise
}

async function refreshOpenAIToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`OpenAI OAuth refresh failed with HTTP ${response.status}`)
  const value = (await response.json()) as Partial<TokenResponse>
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string")
    throw new Error("OpenAI OAuth refresh returned incomplete credentials")
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    id_token: typeof value.id_token === "string" ? value.id_token : undefined,
    expires_in: typeof value.expires_in === "number" ? value.expires_in : undefined,
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_in?: number
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function extractAccountId(tokens: TokenResponse) {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    const nested = claims?.["https://api.openai.com/auth"]
    const auth = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined
    const organizations = Array.isArray(claims?.organizations) ? claims.organizations : undefined
    const firstOrganization = organizations?.[0]
    const organizationID = firstOrganization && typeof firstOrganization === "object" ? (firstOrganization as Record<string, unknown>).id : undefined
    const accountID = claims?.chatgpt_account_id ?? auth?.chatgpt_account_id ?? organizationID
    if (typeof accountID === "string") return accountID
  }
  return undefined
}

async function persistAuthEntry(providerID: string, value: OAuthAuth) {
  if (process.env.OPENCODE_AUTH_CONTENT) return
  // Never persist obviously-invalid tokens: real OpenAI JWTs are hundreds of
  // characters. This guards against a bug writing garbage over real
  // credentials (which once clobbered a user's auth.json).
  if (value.access.length < 50 || value.refresh.length < 50) return
  const path = authPath()
  const temporary = `${path}.${process.pid}.tmp`
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch {}
  existing[providerID] = value
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function findAuth(auth: AuthStore, provider: string): AuthInfo | undefined {
  const normalized = normalizeProvider(provider)
  return auth[provider] ?? auth[normalized] ?? auth[`${provider}/`] ?? auth[`${normalized}/`]
}

function normalizeProvider(provider: string) {
  return provider === "openai-codex" ? "openai" : provider
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === "string"),
  )
}
