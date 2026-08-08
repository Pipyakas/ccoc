import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isTabKey,
  isUpKey,
  makeTheme,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
  type KeypressEvent,
} from "@inquirer/core"
import { cursorHide } from "@inquirer/ansi"
import { styleText } from "node:util"
import figures from "@inquirer/figures"

export interface ServeModelChoice {
  value: string
  name: string
  description?: string
  checked?: boolean
}

export interface ServeModelsResult {
  models: string[]
  modelDisplay: "slug" | "provider"
}

/** Filter choices by a query: every space-separated term must appear in the
 * choice's name or description (case-insensitive substring match). */
export function filterServeModelChoices<Value>(choices: ServeModelChoice[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return choices
  return choices.filter((choice) => {
    const haystack = `${choice.name} ${choice.description ?? ""}`.toLowerCase()
    return terms.every((part) => haystack.includes(part))
  })
}

const theme = makeTheme({
  icon: {
    checked: styleText("green", figures.circleFilled),
    unchecked: figures.circle,
    cursor: figures.pointer,
  },
})

/**
 * Multi-select for choosing served models with:
 * - type-to-filter (substring across provider/model + description)
 * - inline id-form toggle: Tab switches `slug` ⇄ `provider` (shown in the
 *   header, no separate prompt step)
 * - full available height (pageSize from terminal rows)
 * Space toggles, Enter confirms, Backspace/Delete edits the filter.
 */
export const serveModelsPrompt = createPrompt<
  ServeModelsResult,
  { message: string; choices: ServeModelChoice[]; initialDisplay: "slug" | "provider" }
>((config, done) => {
  const { choices, initialDisplay } = config
  const pageSize = Math.max(5, (process.stdout.rows ?? 20) - 5)
  const [status, setStatus] = useState<"idle" | "done">("idle")
  const prefix = usePrefix({ status })
  const [filter, setFilter] = useState("")
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(choices.filter((choice) => choice.checked).map((choice) => choice.value)),
  )
  const [active, setActive] = useState(0)
  const [modelDisplay, setModelDisplay] = useState<"slug" | "provider">(initialDisplay)

  const filtered = useMemo(() => filterServeModelChoices(choices, filter), [choices, filter])

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setStatus("done")
      done({ models: [...checked], modelDisplay })
      return
    }
    if (isTabKey(key)) {
      setModelDisplay(modelDisplay === "slug" ? "provider" : "slug")
      return
    }
    if (isSpaceKey(key)) {
      const current = filtered[active]
      if (current) {
        const next = new Set(checked)
        if (next.has(current.value)) next.delete(current.value)
        else next.add(current.value)
        setChecked(next)
      }
      return
    }
    if (isUpKey(key)) {
      setActive(Math.max(0, active - 1))
      return
    }
    if (isDownKey(key)) {
      setActive(Math.min(filtered.length - 1, active + 1))
      return
    }
    if (isBackspaceKey(key) || key.name === "delete") {
      setFilter(filter.slice(0, -1))
      return
    }
    const rawKey = key as KeypressEvent & { sequence?: string }
    const char = typeof rawKey.sequence === "string" ? rawKey.sequence : rawKey.name
    if (
      typeof char === "string" &&
      char.length === 1 &&
      char.charCodeAt(0) >= 0x20 &&
      char.charCodeAt(0) < 0x7f
    ) {
      setFilter(filter + char)
      setActive(0)
    }
  })

  if (status === "done") {
    const selected = [...checked].join(", ")
    return `${prefix} ${config.message} ${selected || styleText("dim", "(none selected)")}`
  }

  const page = usePagination({
    items: filtered,
    active: Math.min(active, Math.max(0, filtered.length - 1)),
    pageSize,
    renderItem: ({ item, isActive }) => {
      const marker = checked.has(item.value) ? theme.icon.checked : theme.icon.unchecked
      const cursor = isActive ? theme.icon.cursor : " "
      const name = isActive ? styleText("cyan", item.name) : item.name
      const description = item.description ? ` ${styleText("dim", item.description)}` : ""
      return `${cursor} ${marker} ${name}${description}`
    },
  })

  const displayLabel = modelDisplay === "provider" ? "provider" : "slug"
  const displayHint =
    modelDisplay === "provider" ? "anthropic-<provider>/<model>" : "anthropic-<model>"
  const filterLine = filter.length > 0 ? styleText("yellow", `filter: ${filter}`) : styleText("dim", "type to filter")
  const lines = [
    `${prefix} ${config.message}`,
    `  ids: ${styleText("bold", displayLabel)} (${styleText("dim", displayHint)})  ·  Tab toggles  ·  ${filterLine}`,
    page,
  ].join("\n")
  return `${lines}${cursorHide}`
})
