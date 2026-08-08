import crossSpawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process"

interface CrossSpawn {
  spawn(command: string, args?: readonly string[], options?: object): ChildProcess
  spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>
  sync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>
}

const cspawn = crossSpawn as unknown as CrossSpawn

/**
 * cross-spawn wrappers: resolves .cmd/.bat on Windows without a shell, so npm
 * works there without Node's deprecated shell+args mode (DEP0190).
 */
export const spawn = cspawn.spawn
export const spawnSync = (cspawn.spawnSync ?? cspawn.sync).bind(cspawn)
