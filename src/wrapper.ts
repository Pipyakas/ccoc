import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawnSync } from "./spawn.js"

const POSIX_MARKER = "#!/bin/sh\n# ccoc wrapper alias\n"
const CMD_MARKER = "rem ccoc wrapper alias"

/** Directory where wrapper commands are installed: the global npm bin dir
 * (prefix/bin on POSIX, the prefix itself on Windows, since npm drops .cmd
 * shims straight into it). Overridable with CCOC_BIN_DIR (tests). */
export function wrapperDir(): string {
  if (process.env.CCOC_BIN_DIR) return process.env.CCOC_BIN_DIR
  const prefix = globalNpmPrefix()
  if (prefix) return process.platform === "win32" ? prefix : join(prefix, "bin")
  const bin = process.argv[1]
  return bin ? dirname(bin) : "."
}

function globalNpmPrefix(): string | undefined {
  try {
    const result = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 10_000 })
    const prefix = String(result.stdout ?? "").trim()
    return prefix || undefined
  } catch {
    return undefined
  }
}

export async function installWrapper(name: string, binDir: string = wrapperDir()): Promise<void> {
  const path = join(binDir, name)
  const existing = await readMaybe(path)
  if (existing !== undefined && !existing.startsWith(POSIX_MARKER)) {
    throw new Error(
      `Refusing to create command '${name}': ${path} already exists and is not a ccoc wrapper. Pick another alias name.`,
    )
  }
  await mkdir(binDir, { recursive: true })
  await writeFile(path, `${POSIX_MARKER}exec ccoc -m '${name}' "$@"\n`, { mode: 0o755 })
  await chmod(path, 0o755)

  if (process.platform === "win32") {
    const cmdPath = join(binDir, `${name}.cmd`)
    const cmdExisting = await readMaybe(cmdPath)
    if (cmdExisting !== undefined && !cmdExisting.includes(CMD_MARKER)) {
      throw new Error(`Refusing to create command '${name}.cmd': ${cmdPath} already exists and is not a ccoc wrapper.`)
    }
    await writeFile(cmdPath, `@echo off\r\n${CMD_MARKER}\r\nccoc -m ${name} %*\r\n`, { mode: 0o755 })
  }
}

export async function removeWrapper(name: string, binDir: string = wrapperDir()): Promise<boolean> {
  let removed = false
  for (const path of [join(binDir, name), join(binDir, `${name}.cmd`)]) {
    const existing = await readMaybe(path)
    if (existing !== undefined && (existing.startsWith(POSIX_MARKER) || existing.includes(CMD_MARKER))) {
      await rm(path)
      removed = true
    }
  }
  return removed
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}
