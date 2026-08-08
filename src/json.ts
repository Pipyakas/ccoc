export function parseJsonc<T>(text: string, source = "JSON"): T {
  const withoutComments = stripJsonComments(text)
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, "$1")
  try {
    return JSON.parse(withoutTrailingCommas) as T
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function stripJsonComments(input: string): string {
  let output = ""
  let quoted = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]

    if (lineComment) {
      if (current === "\n") {
        lineComment = false
        output += current
      }
      continue
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false
        index += 1
      } else if (current === "\n") {
        output += current
      }
      continue
    }

    if (quoted) {
      output += current
      if (escaped) escaped = false
      else if (current === "\\") escaped = true
      else if (current === '"') quoted = false
      continue
    }

    if (current === '"') {
      quoted = true
      output += current
    } else if (current === "/" && next === "/") {
      lineComment = true
      index += 1
    } else if (current === "/" && next === "*") {
      blockComment = true
      index += 1
    } else {
      output += current
    }
  }

  return output
}
