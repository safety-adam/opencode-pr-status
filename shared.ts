// Shared PR detection used by both the TUI and GUI entrypoints of this plugin.
// Keep the rules in one place so the two surfaces never disagree.

export type Ref = { repo: string; number: number }
export type Check = { name: string; conclusion?: string; status?: string; state?: string }

export function collectStrings(value: unknown, out: string[], depth = 0) {
  if (out.length > 1000 || depth > 8) return
  if (typeof value === "string") {
    out.push(value.length > 20_000 ? value.slice(0, 20_000) : value)
    return
  }
  if (typeof value !== "object" || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  for (const key of Object.keys(value)) {
    if (key === "providerState" || key === "providerResultState" || key === "snapshot") continue
    collectStrings((value as Record<string, unknown>)[key], out, depth + 1)
  }
}

const URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const SLASH_RE = /\b([\w.-]+\/[\w.-]+)#(\d{1,6})\b/g
const CREATE_PR_TOOL_RE = /create[_ ]?(pr$|pr_|pull.?request)/i

type RefMap = Map<string, Ref>

function addRef(found: RefMap, repo: string, number: number) {
  if (!repo || !number) return
  const key = `${repo}#${number}`
  if (!found.has(key)) found.set(key, { repo, number })
}

function addFromText(found: RefMap, text: string) {
  for (const match of text.matchAll(URL_RE)) addRef(found, match[1], Number(match[2]))
  for (const match of text.matchAll(SLASH_RE)) {
    if (/github\.com\//i.test(text.slice(Math.max(0, match.index - 12), match.index))) continue
    addRef(found, match[1], Number(match[2]))
  }
}

export function ciState(checks: Check[]): "pass" | "fail" | "pending" | "none" {
  if (!Array.isArray(checks) || checks.length === 0) return "none"
  let pending = false
  for (const c of checks) {
    // CheckRuns use status/conclusion; StatusContexts use state.
    const conclusion = (c.conclusion ?? "").toUpperCase()
    const status = (c.status ?? "").toUpperCase()
    const state = (c.state ?? "").toUpperCase()
    if (
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion) ||
      ["FAILURE", "ERROR"].includes(state)
    )
      return "fail"
    if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].includes(status)) pending = true
    if (["PENDING", "EXPECTED"].includes(state)) pending = true
    if (conclusion === "" && status === "" && state === "") pending = true
  }
  return pending ? "pending" : "pass"
}

// Only PRs raised in this session, or ones the user explicitly asked to monitor.
// Reading `gh pr view` and `gh pr list` output pulled in old PRs the agent was
// only inspecting, so we do not track those.
export function refsFromMessages(messages: any[], fallbackRepo: string): Ref[] {
  const found: RefMap = new Map()

  for (const m of messages) {
    const commands: string[] = []
    const outputs: string[] = []
    let createTool = false

    if (m?.type === "shell") {
      if (typeof m.command === "string") commands.push(m.command)
      if (typeof m.output?.output === "string") outputs.push(m.output.output)
    } else if (m?.type === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type !== "tool") continue
        const name = String(part.name ?? "")
        collectStrings(part.state?.input, commands)
        collectStrings(part.state?.content, outputs)
        if (CREATE_PR_TOOL_RE.test(name)) createTool = true

        // Explicit "monitor this PR" tool call: always track, regardless of
        // whether any `gh pr` command was run.
        if (/monitor/i.test(name) && /pr/i.test(name)) {
          const strs: string[] = []
          collectStrings(part.state?.input, strs)
          collectStrings(part.state?.content, strs)
          for (const s of strs) {
            addFromText(found, s)
            if (fallbackRepo) {
              const num = s.match(/(?:^|\D)(\d{1,6})(?:\D|$)/)
              if (num) addRef(found, fallbackRepo, Number(num[1]))
            }
          }
        }
      }
    }

    let createdHere = false
    for (const command of commands) {
      if (/\bgh\s+pr\s+create\b/i.test(command)) createdHere = true
    }
    // Only read output when this session created the PR, or a create tool ran.
    if (createdHere || createTool) {
      for (const output of outputs) addFromText(found, output)
    }
  }

  return [...found.values()]
}
