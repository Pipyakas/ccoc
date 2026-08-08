# AGENTS.md

## Global install is a live link

This repo is `npm link`-ed globally: `%APPDATA%\npm\node_modules\ccoc` is a
junction to this directory, so the global `ccoc` command executes this clone's
`bin/ccoc.cjs`, which loads `src/*.ts` through tsx.

**Source changes go live immediately on the next `ccoc` invocation — no
reinstall, re-link, or `npm install -g` needed.** Do NOT tell the user to run
`ccoc update`, `npm link`, or reinstall after code edits; the link already
covers it. `ccoc update` in this setup does a `git pull` in the clone.

A long-running gateway process (`ccoc serve`) loads the source once at start, so
code changes require **restarting the gateway** (via the tray toggle, or by
killing the `node ... serve` process and relaunching the Startup entry) to take
effect there.

Exceptions that DO need a redeploy step:
- Changes to `bin/ccoc.cjs`, `package.json` `bin`, or npm shims: re-run
  `npm link` in this dir.
- New/changed npm dependencies (incl. `vendor/opencode-llm`): `npm install`
  in this dir.

## Verification after changes

Always run `npm test` and `npm run typecheck` after code changes, and confirm
the global command still resolves to the clone with `ccoc --version`.

## User config

The live gateway config lives in `~/.config/ccoc/config.json`: a `port` and a
`models` map keyed by model slug (per-model `reasoningEffort` is enforced by
ccoc). Config edits apply on next gateway restart.

## Architecture

The gateway (`ccoc serve`) is a single Anthropic Messages API proxy on a fixed
port that all Claude clients share. It routes:

- `anthropic-<model>` ids → OpenCode providers (via the configured `models` map
  or the catalog)
- official Claude models (`claude-*`, `opus`/`sonnet`/...) → passthrough to
  `api.anthropic.com` using the client's own OAuth credential

`ccoc install-service` / `ccoc tray` manage Windows auto-start and a system-tray
monitor (click pauses/resumes serving — the gateway process keeps running; the
pause is enforced server-side via loopback-only `/admin/pause|resume`, so model
requests get a clear 503 while paused; middle-click stops the gateway process
completely and exits the tray app itself). Pausing/stopping strips the
local-gateway env from
`~/.claude/settings.json` and repoints the model cache at the user-level remote
base URL, so Claude Code switches local↔remote cleanly; resume/start re-applies
them. The interactive CLI (`ccoc models`, `ccoc alias`, ...) is the config
surface. The tray is spawned through a `Start-Process` wrapper so it outlives
the gateway process (force-killed parents would otherwise take its WinForms
message loop down), and it is a singleton: each new instance stops older ones.
