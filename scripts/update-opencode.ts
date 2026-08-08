import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = promisify(execFile)
const ref = process.argv[2] ?? "dev"
const temporary = join(tmpdir(), `ccoc-opencode-${process.pid}`)
const root = new URL("../", import.meta.url).pathname

try {
  await run("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/anomalyco/opencode.git", temporary])
  const { stdout } = await run("git", ["-C", temporary, "rev-parse", "HEAD"])
  const commit = stdout.trim()
  const llmTarget = join(root, "vendor", "opencode-llm", "src")
  const schemaTarget = join(root, "vendor", "opencode-schema", "src")
  await rm(llmTarget, { recursive: true, force: true })
  await mkdir(join(root, "vendor", "opencode-llm"), { recursive: true })
  await cp(join(temporary, "packages", "llm", "src"), llmTarget, { recursive: true })
  await cp(join(temporary, "packages", "schema", "src", "llm.ts"), join(schemaTarget, "llm.ts"))
  await cp(join(temporary, "packages", "schema", "src", "schema.ts"), join(schemaTarget, "schema.ts"))

  for (const path of [join(llmTarget, "route", "executor.ts"), join(llmTarget, "schema", "options.ts")]) {
    const source = await readFile(path, "utf8")
    if (!source.startsWith("// @ts-nocheck")) await writeFile(path, `// @ts-nocheck\n${source}`)
  }

  const readmePath = join(root, "vendor", "README.md")
  const readme = await readFile(readmePath, "utf8")
  await writeFile(readmePath, readme.replace(/OpenCode commit `[^`]+`/, `OpenCode commit \`${commit}\``))
  process.stdout.write(`Updated vendored OpenCode LLM to ${commit}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
