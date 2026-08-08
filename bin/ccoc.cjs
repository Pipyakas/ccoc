#!/usr/bin/env node

require("tsx/cjs");
const { main } = require("../src/cli.ts");
main().catch((error) => {
  process.stderr.write(`ccoc: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
