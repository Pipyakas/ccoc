# Vendored OpenCode LLM

`vendor/opencode-llm/src` is a snapshot of OpenCode's native LLM package. It is
kept as source because OpenCode currently marks `@opencode-ai/llm` private and
does not publish it as an npm package.

The snapshot is pinned to OpenCode commit `2f17fc9613771af3de3b5a2715b836037d80c4b1`
(the `dev` branch observed on 2026-08-05). Run `npm run update:opencode` to
refresh it from a chosen OpenCode ref.

The package is MIT licensed. See the upstream project at
https://github.com/anomalyco/opencode.
