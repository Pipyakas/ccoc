# ccoc

Run Claude Code through models and credentials already configured in OpenCode —
now as a **standalone gateway**.

`ccoc serve` starts a long-running Anthropic Messages API proxy (the gateway) on
a fixed port. Claude Code points at it. The gateway:

- routes `anthropic-<model>` ids to OpenCode providers (OpenCode Go / Zen, and
  any catalog model)
- passes official Claude models (`claude-opus-5`, `opus`, `sonnet`, ...) straight
  through to Anthropic, so your claude.ai / Claude Code subscription login keeps
  working
- discovers its model list to Claude Code (`/model`)
- runs the proxy-side web search tool
- returns provider errors as real HTTP errors (429 quota, 400 invalid, 502
  upstream) instead of silently empty responses

## Install

Requirements: Node.js 22+, Claude Code, and OpenCode.

```sh
# global install directly from GitHub
npm install -g github:Pipyakas/ccoc

# or clone and link for development
git clone https://github.com/Pipyakas/ccoc.git
cd ccoc
npm install
npm link

opencode auth login
```

## Configure

Create `~/.config/ccoc/config.json`. Models are keyed by provider then model
id (like opencode.json), so `provider/model` ids are unambiguous:

```json
{
  "port": 6767,
  "host": "127.0.0.1",
  "modelDisplay": "slug",
  "models": {
    "opencode-go": {
      "deepseek-v4-flash": { "reasoningEffort": "max" }
    },
    "openai": {
      "gpt-5.6-luna": { "reasoningEffort": "max" }
    },
    "opencode": {
      "deepseek-v4-flash-free": {}
    }
  }
}
```

- `host` — bind address. Default `127.0.0.1` (local clients only); set
  `"0.0.0.0"` to share the gateway on a LAN.
- `modelDisplay` — `"slug"` advertises `anthropic-<model>` (falling back to
  provider-qualified ids when a model name is served by several providers),
  `"provider"` always advertises `anthropic-<provider>/<model>`.
- `providers` — optional opencode-style provider definitions (npm, baseURL,
  models) so the gateway is self-contained on a machine with no opencode
  install. When present they win over any discovered opencode config.
- Auth is read from the machine's opencode auth store **or, if absent, from
  the client's own key** (`x-api-key` / `Authorization` header) — so a shared
  gateway can store no credentials and each user's key is passed through to
  the provider.

The gateway serves **every** entry — there is no one-model limit and no
"default" model. Unknown model names fail loudly rather than silently routing
somewhere. Malformed configs (wrong models shape, old flat format) refuse to
start.

## Run the gateway

```sh
# foreground (terminal stays attached)
ccoc serve --port 6767

# Windows: start at logon (no admin, no console window)
ccoc install-service --port 6767
schtasks /Run /TN ccoc-gateway

# tray monitor: green/gray dot, click to pause/resume serving
# (the gateway process keeps running; hover for live stats)
ccoc tray
```

`ccoc install-service` registers a Windows Task Scheduler task (or falls back to
a Startup-folder entry) that launches the gateway hidden at every logon. The
tray is auto-launched alongside the gateway.

## Point Claude Code at the gateway

Add to `~/.claude/settings.json` (applies to the CLI and background agents):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:6767",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128000"
  }
}
```

Then run `claude` directly — `/model` shows the built-in Claude models **and**
the gateway models under "From gateway" (`anthropic-<model>`). Pick any.

For a **subscription-only (Claude Code) account**, do **not** set
`ANTHROPIC_AUTH_TOKEN` in the env block: the gateway forwards your real OAuth
login to Anthropic for official Claude models. (An `ANTHROPIC_AUTH_TOKEN` would
replace your login and break the passthrough.)

## Auth and configuration

Credentials are read from OpenCode's normal
`~/.local/share/opencode/auth.json`. OpenAI OAuth credentials are refreshed and
written back using the same token endpoint and Codex account-header behavior as
OpenCode. API-key providers use their OpenCode auth entry first, then the
provider environment variables from OpenCode's model catalog.

OpenCode provider overrides in `opencode.json` are honored for `baseURL`,
headers, custom models, and API-compatible providers.

Useful commands:

```sh
ccoc doctor
ccoc models                 # interactive picker (in a terminal)
ccoc models opencode-go     # plain list when stdout is not a terminal
ccoc serve --port 6767      # start the gateway
ccoc install-service        # Windows: start at logon (hidden, no admin)
ccoc uninstall-service      # Windows: remove the logon entry
ccoc tray                   # tray monitor
ccoc --version
```

Set `CCOC_CLAUDE_COMMAND` to launch a different Claude Code executable.

## Web search

Claude Code's web search is an Anthropic **server-side** tool (sent without an
`input_schema`, which most providers reject). For gateway (OpenCode) models,
ccoc executes it locally:

- server-side tool declarations (`web_search`, `text_editor`, `code_execution`,
  `bash_2025*`) are stripped from requests so they never reach the provider
- a client-side `web_search` tool is offered in their place
- when the model calls it, ccoc runs the search and feeds the results back into
  the same turn (`tool_use` → `tool_result` → continued response)

For **official Claude models**, the passthrough sends the tool to Anthropic,
which executes it natively.

Backends (`"webSearch": { "backend": "..." }` in the config):

- `ddg` — free, no key (default when nothing else is configured)
- `exa` — opencode's own web search backend; used automatically when
  `EXA_API_KEY` is set (or `OPENCODE_WEBSEARCH_PROVIDER=exa`)
- `parallel` — opencode's alternative backend (`PARALLEL_API_KEY`)
- `brave` — needs `apiKey` in the config

Set `"webSearch": false` to disable: tools are stripped and no substitute is
offered. `maxTurns` limits searches per request (default 3).

```json
{ "webSearch": { "backend": "exa" } }
```

## Error handling

The gateway surfaces provider failures the way the Anthropic API does:

| Case | Result |
|---|---|
| Quota / rate limit (before content) | HTTP 429 `rate_limit_error` |
| Context window overflow | HTTP 502, message rewritten to "prompt is too long" (Claude Code auto-compacts) |
| Malformed / invalid request | HTTP 400 `invalid_request_error` |
| Unknown model | HTTP 500 "Unknown model ..." |
| Empty / non-SSE upstream body | HTTP 502 |
| Official-model passthrough failure | HTTP 502 |

Failures before any content is produced are real HTTP errors (not 200 streams
with an `error` frame), so Claude Code renders them cleanly instead of reporting
"API returned an empty or malformed response (HTTP 200)".

## Updating

There is no auto-update. Run:

```sh
ccoc update
```

It detects how ccoc was installed: a linked git clone gets `git pull` + `npm install` in place, an installed package gets reinstalled from GitHub. Manually, that's either `npm install -g github:Pipyakas/ccoc` again or `git pull` in the clone.

The native OpenCode LLM package is currently private upstream, so this project
keeps a pinned source snapshot in `vendor/opencode-llm`. Refresh it with:

```sh
npm run update:opencode -- dev
```

## Current native routes

- OpenAI Responses, including OpenAI/Codex OAuth
- OpenAI-compatible Chat Completions, including OpenCode Go/Zen and custom endpoints
- OpenRouter Chat Completions
- Anthropic Messages
- Google Gemini

Bedrock signing and providers requiring OpenCode plugins are not yet wired into
the standalone wrapper.
