import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const stateHome = () =>
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")

const aliasesPath = () => join(stateHome(), "ccoc", "aliases.json")

export type AliasStore = Record<string, string>

export async function loadAliases(): Promise<AliasStore> {
  try {
    const parsed = JSON.parse(await readFile(aliasesPath(), "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: AliasStore = {}
      for (const [name, target] of Object.entries(parsed)) {
        if (typeof target === "string" && target.includes("/")) result[name] = target
      }
      return result
    }
    return {}
  } catch {
    return {}
  }
}

export async function saveAliases(aliases: AliasStore) {
  const path = aliasesPath()
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(aliases, null, 2) + "\n", { mode: 0o600 })
  await rename(temporary, path)
}

export const validAliasName = (name: string) => /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes("/")

export const validAliasTarget = (target: string) => /^[^/]+\/[^/]+$/.test(target)
