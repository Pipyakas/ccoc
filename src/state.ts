import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const stateHome = () =>
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")

export const stateHomePath = stateHome()

export const lastModelPath = () => join(stateHome(), "ccoc", "last-model")

/** Settings overlay passed to `claude --settings` so connector disabling is
 * declared by setting rather than inferred from an auth-source conflict. */
export const settingsOverlayPath = () => join(stateHome(), "ccoc", "claude-settings.json")

const legacyLastModelPath = () => join(stateHome(), "ccocproxy", "last-model")

export async function loadLastModel(): Promise<string | undefined> {
  for (const path of [lastModelPath(), legacyLastModelPath()]) {
    try {
      const value = (await readFile(path, "utf8")).trim()
      if (value.length > 0) return value
    } catch {}
  }
  return undefined
}

export async function saveLastModel(target: string) {
  const path = lastModelPath()
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${target}\n`, { mode: 0o600 })
  await rename(temporary, path)
}
