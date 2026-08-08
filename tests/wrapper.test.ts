import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { installWrapper, removeWrapper } from "../src/wrapper.js"

test("installs and removes an executable wrapper command", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "ccoc-bin-"))
  await installWrapper("lunaclaude", binDir)
  const path = join(binDir, "lunaclaude")
  const content = await readFile(path, "utf8")
  assert.match(content, /exec ccoc -m 'lunaclaude' "\$@"/)
  // POSIX-only: Windows fs.chmod/stat never report 0o111 mode bits.
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o111, 0o111)
  }
  assert.equal(await removeWrapper("lunaclaude", binDir), true)
  await assert.rejects(readFile(path, "utf8"))
  assert.equal(await removeWrapper("lunaclaude", binDir), false)
})

test("refuses to overwrite a non-ccoc command", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "ccoc-bin-"))
  const path = join(binDir, "claude")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(path, "#!/bin/sh\necho real claude\n", { mode: 0o755 })
  await assert.rejects(installWrapper("claude", binDir), /Refusing/)
  assert.match(await readFile(path, "utf8"), /real claude/)
})

test("overwriting an existing ccoc wrapper is allowed", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "ccoc-bin-"))
  await installWrapper("solclaude", binDir)
  await installWrapper("solclaude", binDir)
  assert.match(await readFile(join(binDir, "solclaude"), "utf8"), /exec ccoc -m 'solclaude'/)
})
