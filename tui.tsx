import { Plugin } from "@opencode/plugin/tui"
import { For, createEffect, createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// PR status stack — watches the current session for GitHub PRs the agent is
// working on, resolves each with `gh`, and renders a vertically stacked list
// above the prompt composer:
//
//     ⑂ #42  acme/api  Tool retry loops        +1,621 -10  ● CI(2) Checks pending  ▲  ×
//     ⑂ #43  acme/api  fix/retry-backoff          +42   -7             Merged  ×
//
// Detection is deliberately narrow: only explicit `gh pr ...` commands and
// PR-creating tool calls count. Arbitrary transcript text and file contents are
// ignored, so reading a file that happens to mention a PR does not surface it.
//
// Each open row also shows review state, unresolved review comments, and
// mergeability (fetched per PR via GraphQL), and the CI panel lists them.
//
// Clicking the CI badge opens a "CI monitoring" panel with two toggles:
//   ☐ Auto-fix CI & address comments   -> prompts the session when checks fail
//   ☐ Auto-merge when ready            -> `gh pr merge --auto` once CI is clean
// ---------------------------------------------------------------------------

const RESOLVE_FIELDS =
  "number,title,headRefName,additions,deletions,statusCheckRollup,url,state,mergedAt,isDraft,mergeStateStatus,reviewDecision,mergeable,latestReviews"

// Review state, mergeability, and unresolved review threads are most reliable
// from GraphQL (REST `mergeable` often lags as UNKNOWN, and REST exposes no
// thread resolution at all).
const GRAPH_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision mergeable mergeStateStatus reviewThreads(first:100){nodes{isResolved}}}}}"

type Check = { name: string; conclusion?: string; status?: string; state?: string }
type PrData = {
  number: number
  repo: string
  branch: string
  title: string
  additions: number
  deletions: number
  url: string
  state: string // OPEN | MERGED | CLOSED
  mergedAt: string | null
  isDraft: boolean
  mergeStateStatus: string
  reviewDecision: string // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN | ""
  unresolved: number
  checks: Check[]
}
type RowData = PrData & { key: string }
type Ref = { repo: string; number: number }
type Controls = { autoFix?: boolean; autoMerge?: boolean }

type SessionState = {
  refs: Ref[]
  resolved: Map<string, RowData | null>
  repo: string | null
  cwd: string
  scanning: boolean
  timer: any
}

function pick(...values: any[]): any {
  for (const v of values) if (v !== undefined && v !== null) return v
  return undefined
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

function ciState(checks: Check[]): "pass" | "fail" | "pending" | "none" {
  if (!checks.length) return "none"
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

function failingNames(checks: Check[]): string {
  return checks
    .filter((c) => {
      const conclusion = (c.conclusion ?? "").toUpperCase()
      const state = (c.state ?? "").toUpperCase()
      return (
        ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion) ||
        ["FAILURE", "ERROR"].includes(state)
      )
    })
    .map((c) => c.name)
    .sort()
    .join(",")
}

function run(cmd: string, args: string[], cwd: string): Promise<string | null> {
  // Async, and deliberately not promisify(execFile): that resolves an object
  // ({ stdout, stderr }), not stdout. This wrapper returns stdout directly.
  return new Promise((resolve) => {
    void (async () => {
      try {
        const mod: any = await import("node:child_process")
        mod.execFile(
          cmd,
          args,
          { cwd, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
          (err: any, stdout: any) => resolve(err ? null : String(stdout ?? "")),
        )
      } catch {
        resolve(null)
      }
    })()
  })
}

async function ghJson(args: string[], cwd: string): Promise<any | null> {
  const out = await run("gh", args, cwd)
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------

function collectStrings(value: any, out: string[], depth = 0) {
  if (out.length > 4000 || depth > 8) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (typeof value !== "object" || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  for (const key of Object.keys(value)) {
    if (key === "providerState" || key === "providerResultState" || key === "snapshot") continue
    collectStrings(value[key], out, depth + 1)
  }
}

const URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const SLASH_RE = /\b([\w.-]+\/[\w.-]+)#(\d{1,6})\b/g

// Tools that create a PR directly (e.g. GitHub MCP create_pull_request).
const CREATE_PR_TOOL_RE = /create[_ ]?(pr$|pr_|pull.?request)/i
// Any explicit `gh pr <subcommand>` invocation.
const GH_PR_RE = /\bgh\s+pr\s+([a-z][a-z-]*)([^\n;&|]*)/gi
const REPO_FLAG_RE = /(?:--repo|-R)[=\s]+([\w.-]+\/[\w.-]+)/

type RefMap = Map<string, Ref>

function addRef(found: RefMap, repo: string, number: number) {
  if (!repo || !number) return
  const key = `${repo}#${number}`
  if (!found.has(key)) found.set(key, { repo, number })
}

// PR references in free text: full PR URLs and owner/repo#123.
function addFromText(found: RefMap, text: string) {
  for (const m of text.matchAll(URL_RE)) addRef(found, m[1], Number(m[2]))
  for (const m of text.matchAll(SLASH_RE)) {
    if (/github\.com\//i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    addRef(found, m[1], Number(m[2]))
  }
}

// `gh pr view 1631 --repo owner/repo`, `gh pr edit ...`, `-R owner/repo`, etc.
// `create` is skipped: its PR number only appears in the command output.
function addFromGhCommands(found: RefMap, command: string, bareRepo: string) {
  for (const m of command.matchAll(GH_PR_RE)) {
    const sub = m[1].toLowerCase()
    if (sub === "create") continue
    const rest = m[2] ?? ""
    const repo = REPO_FLAG_RE.exec(rest)?.[1] ?? bareRepo
    const num = rest.match(/(?:^|\s)(\d{1,6})(?=\s|$)/)?.[1]
    if (repo && num) addRef(found, repo, Number(num))
  }
}

// Only PRs the agent is actively working on: read PR references out of the
// agent's own `gh pr ...` commands and their output — never out of arbitrary
// transcript text or file contents, which pulled in unrelated PRs.
function refsFromMessages(messages: any[], fallbackRepo: string): Ref[] {
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

    let sawGhPr = false
    for (const command of commands) {
      if (/\bgh\s+pr\s+/i.test(command)) {
        sawGhPr = true
        addFromGhCommands(found, command, fallbackRepo)
        addFromText(found, command)
      }
    }
    // Outputs are only trusted when the agent actually ran a `gh pr` command
    // (so this is PR output, not the contents of a file the agent read).
    if (sawGhPr || createTool) {
      for (const output of outputs) addFromText(found, output)
    }
  }

  return [...found.values()]
}

function toRow(ref: Ref, pr: any): RowData | null {
  if (!pr || typeof pr.number !== "number") return null
  const checks: Check[] = Array.isArray(pr.statusCheckRollup)
    ? pr.statusCheckRollup.map((c: any) => ({
        name: c.name ?? c.context ?? c.workflowName ?? "check",
        conclusion: c.conclusion ?? undefined,
        status: c.status ?? undefined,
        state: c.state ?? undefined,
      }))
    : []

  // reviewDecision is the authoritative field; fall back to latestReviews.
  let reviewDecision: string = pr.reviewDecision ?? ""
  if (!reviewDecision && Array.isArray(pr.latestReviews)) {
    const states = pr.latestReviews.map((r: any) => String(r?.state ?? "").toUpperCase())
    if (states.includes("CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED"
    else if (states.includes("APPROVED")) reviewDecision = "APPROVED"
  }

  const repo = ref.repo || ""
  return {
    key: `${repo}#${pr.number}`,
    number: pr.number,
    repo,
    branch: pr.headRefName ?? "",
    title: pr.title || pr.headRefName || "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    url: pr.url ?? "",
    state: pr.state ?? "OPEN",
    mergedAt: pr.mergedAt ?? null,
    isDraft: pr.isDraft ?? false,
    mergeStateStatus: pr.mergeStateStatus ?? "",
    reviewDecision,
    mergeable: pr.mergeable ?? "",
    unresolved: 0,
    checks,
  }
}

// Enrich a row from GraphQL: review decision, mergeability, unresolved threads.
async function fetchGraphMeta(
  repo: string,
  number: number,
  cwd: string,
): Promise<{ reviewDecision: string; mergeable: string; mergeStateStatus: string; unresolved: number } | null> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return null
  const out = await run(
    "gh",
    ["api", "graphql", "-f", `query=${GRAPH_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`],
    cwd,
  )
  if (!out) return null
  try {
    const pr = JSON.parse(out)?.data?.repository?.pullRequest
    if (!pr) return null
    const nodes = pr.reviewThreads?.nodes
    return {
      reviewDecision: pr.reviewDecision ?? "",
      mergeable: pr.mergeable ?? "",
      mergeStateStatus: pr.mergeStateStatus ?? "",
      unresolved: Array.isArray(nodes) ? nodes.filter((n: any) => !n.isResolved).length : 0,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function Stack(props: {
  context: any
  rows: () => RowData[]
  onOpen: (row: RowData) => void
  onChecks: (row: RowData) => void
  onDismiss: (row: RowData) => void
}) {
  const theme = props.context.theme
  const chipBg = pick(theme.background?.element, theme.background?.action?.secondary)
  const textBase = pick(theme.text?.base, theme.text, "white")
  const textMuted = pick(theme.text?.muted, theme.text?.base, "gray")
  const green = pick(theme.hue?.green?.[200], theme.text?.feedback?.success?.base, "green")
  const red = pick(theme.hue?.red?.[200], theme.text?.feedback?.error?.base, "red")
  // hue.yellow is aliased to gray in this theme, so themed hue lookups render
  // grey/white. The semantic warning colour is yellow here; "yellow" is a
  // last-resort named colour.
  const yellow = pick(theme.text?.feedback?.warning?.base, "yellow")
  const purpleBg = pick(theme.hue?.purple?.[800], theme.hue?.purple?.[700], theme.hue?.purple?.[900])
  const purpleText = pick(theme.hue?.purple?.[100], theme.hue?.purple?.[200], "magenta")
  const purpleMuted = pick(theme.hue?.purple?.[400], theme.hue?.purple?.[300], "gray")

  const merged = (row: RowData) => row.state === "MERGED"
  const closed = (row: RowData) => row.state === "CLOSED"

  // GitHub-aligned PR status: the most important merge-box state wins.
  const prStatus = (row: RowData): { label: string; color: any } => {
    const checks = ciState(row.checks)
    if (row.isDraft || row.mergeStateStatus === "DRAFT") return { label: "Draft", color: textMuted }
    if (row.mergeable === "CONFLICTING" || row.mergeStateStatus === "DIRTY")
      return { label: "Conflicts", color: red }
    if (checks === "fail") return { label: "Checks failed", color: red }
    if (row.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", color: red }
    if (checks === "pending" || row.mergeStateStatus === "UNSTABLE")
      return { label: "Checks pending", color: yellow }
    if (row.mergeStateStatus === "BEHIND") return { label: "Behind base", color: yellow }
    if (row.reviewDecision === "REVIEW_REQUIRED" || row.mergeStateStatus === "BLOCKED")
      return { label: "Review required", color: yellow }
    if (row.mergeStateStatus === "CLEAN" || (checks === "pass" && row.reviewDecision === "APPROVED"))
      return { label: "Ready to merge", color: green }
    if (checks === "pass") return { label: "All checks passed", color: green }
    return { label: "Open", color: textMuted }
  }

  // Merged/closed rows read as a single coloured bar: branch name,
  // right-aligned state, dismiss — no diff stats, no CI badge.
  const stateRow = (row: RowData, bg: any, fg: any, mutedFg: any, label: string) => (
    <box
      flexDirection="row"
      gap={2}
      alignItems="center"
      backgroundColor={bg}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      onMouseUp={() => props.onOpen(row)}
    >
      <box flexDirection="row" gap={1} alignItems="center" flexGrow={1} minWidth={0}>
        <text fg={fg} flexShrink={0}>
          {"⑂"}
        </text>
        <text fg={fg} flexShrink={0}>
          {`#${row.number}`}
        </text>
        <text fg={mutedFg} flexShrink={0}>
          {row.repo}
        </text>
        <text fg={fg} wrapMode="none" truncate flexShrink={1} minWidth={0}>
          {row.branch}
        </text>
      </box>
      <text fg={fg} flexShrink={0}>
        {label}
      </text>
      <text
        fg={mutedFg}
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onDismiss(row)
        }}
      >
        {"×"}
      </text>
    </box>
  )

  const mergedRow = (row: RowData) => stateRow(row, purpleBg, purpleText, purpleMuted, "Merged")
  const closedRow = (row: RowData) =>
    stateRow(row, pick(theme.background?.element, chipBg), textMuted, textMuted, "Closed")

  const openRow = (row: RowData) => (
    <box
      flexDirection="row"
      gap={1}
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      onMouseUp={() => props.onOpen(row)}
    >
      <text fg={green} flexShrink={0}>
        {"⑂"}
      </text>
      <text fg={textBase} flexShrink={0}>
        {`#${row.number}`}
      </text>
      <text fg={textMuted} flexShrink={0}>
        {row.repo}
      </text>
      <text fg={textBase} wrapMode="none" truncate flexGrow={1} minWidth={0}>
        {row.title}
      </text>
      <text fg={green} flexShrink={0}>
        {`+${fmt(row.additions)}`}
      </text>
      <text fg={red} flexShrink={0}>
        {`-${fmt(row.deletions)}`}
      </text>
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={chipBg}
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onChecks(row)
        }}
      >
        <text fg={prStatus(row).color} flexShrink={0}>
          {"●"}
        </text>
        <text fg={textBase} flexShrink={0}>
          {"CI"}
        </text>
        <text fg={row.unresolved > 0 ? yellow : textMuted} flexShrink={0}>
          {`(${row.unresolved})`}
        </text>
        <text fg={prStatus(row).color} flexShrink={0}>
          {prStatus(row).label}
        </text>
      </box>
      <text
        fg={textMuted}
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onChecks(row)
        }}
      >
        {"▲"}
      </text>
      <text
        fg={textMuted}
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onDismiss(row)
        }}
      >
        {"×"}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.rows()}>
        {(row) => (merged(row) ? mergedRow(row) : closed(row) ? closedRow(row) : openRow(row))}
      </For>
    </box>
  )
}

// The "CI monitoring" panel: status summary plus the two toggles.
function ControlPanel(props: {
  context: any
  row: RowData
  controls: () => Controls
  toggle: (field: keyof Controls) => void
  onOpen: () => void
}) {
  const theme = props.context.theme
  const textBase = pick(theme.text?.base, theme.text, "white")
  const textMuted = pick(theme.text?.muted, theme.text?.base, "gray")
  const green = pick(theme.hue?.green?.[200], theme.text?.feedback?.success?.base, "green")
  const red = pick(theme.hue?.red?.[200], theme.text?.feedback?.error?.base, "red")
  // hue.yellow is aliased to gray in this theme, so themed hue lookups render
  // grey/white. The semantic warning colour is yellow here; "yellow" is a
  // last-resort named colour.
  const yellow = pick(theme.text?.feedback?.warning?.base, "yellow")
  const accent = pick(theme.hue?.accent?.[200], theme.text?.feedback?.info?.base, "cyan")

  const state = () => ciState(props.row.checks)
  const label = () =>
    state() === "pass"
      ? "Checks passed"
      : state() === "fail"
        ? "Checks failed"
        : state() === "pending"
          ? "Checks pending"
          : "No checks"
  const color = () =>
    state() === "pass" ? green : state() === "fail" ? red : state() === "pending" ? yellow : textMuted

  const review =
    props.row.reviewDecision === "APPROVED"
      ? { text: "Approved", color: green }
      : props.row.reviewDecision === "CHANGES_REQUESTED"
        ? { text: "Changes requested", color: red }
        : props.row.reviewDecision === "REVIEW_REQUIRED"
          ? { text: "Review required", color: yellow }
          : { text: "—", color: textMuted }

  const merge =
    props.row.mergeStateStatus === "CLEAN"
      ? { text: "Mergeable", color: green }
      : props.row.mergeable === "CONFLICTING" || props.row.mergeStateStatus === "DIRTY"
        ? { text: "Conflicts", color: red }
        : props.row.mergeStateStatus === "BEHIND"
          ? { text: "Behind base", color: yellow }
          : props.row.mergeStateStatus === "BLOCKED"
            ? { text: "Blocked", color: textMuted }
            : props.row.mergeStateStatus === "UNSTABLE"
              ? { text: "Unstable", color: yellow }
              : props.row.mergeStateStatus === "DRAFT"
                ? { text: "Draft", color: textMuted }
                : props.row.mergeStateStatus === "HAS_HOOKS"
                  ? { text: "Hooks", color: textMuted }
                  : props.row.mergeable === "MERGEABLE"
                    ? { text: "Mergeable", color: green }
                    : { text: "Unknown", color: textMuted }

  const infoRow = (name: string, value: string, c: any) => (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={textMuted} flexGrow={1} minWidth={0} wrapMode="none" truncate>
        {name}
      </text>
      <text fg={c} flexShrink={0}>
        {value}
      </text>
    </box>
  )

  const option = (field: keyof Controls, text: string) => (
    <box
      flexDirection="row"
      gap={1}
      alignItems="center"
      onMouseUp={() => props.toggle(field)}
    >
      <text fg={props.controls()[field] ? accent : textMuted} flexShrink={0}>
        {props.controls()[field] ? "☑" : "☐"}
      </text>
      <text fg={textBase} wrapMode="none" truncate flexGrow={1} minWidth={0}>
        {text}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" padding={1} gap={1} minWidth={54}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={textMuted} flexGrow={1} minWidth={0} wrapMode="none" truncate>
          {"CI monitoring"}
        </text>
        <text fg={textMuted} flexShrink={0} onMouseUp={() => props.onOpen()}>
          {"↗"}
        </text>
      </box>

      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={color()} flexShrink={0}>
          {"●"}
        </text>
        <text fg={textBase} flexGrow={1} minWidth={0} wrapMode="none" truncate>
          {label()}
        </text>
        <text fg={textMuted} flexShrink={0}>
          {String(props.row.checks.length)}
        </text>
      </box>

      {infoRow("Review", review.text, review.color)}
      {infoRow(
        "Unresolved comments",
        String(props.row.unresolved),
        props.row.unresolved > 0 ? yellow : green,
      )}
      {infoRow("Mergeable", merge.text, merge.color)}

      <text fg={pick(theme.border?.base, textMuted)} flexShrink={0}>
        {"──────────────────────────────────────"}
      </text>

      {option("autoFix", "Auto-fix CI & address comments")}
      {option("autoMerge", "Auto-merge when ready")}
    </box>
  )
}

// Owns the session id for this slot render and reads only that session's rows.
function ComposerSlot(props: {
  context: any
  input: any
  rows: () => Record<string, RowData[]>
  schedule: (sessionID: string) => void
  onOpen: (row: RowData) => void
  onChecks: (row: RowData) => void
  onDismiss: (sessionID: string, row: RowData) => void
}) {
  const sid = () => props.input?.sessionID as string | undefined
  createEffect(() => {
    const s = sid()
    if (s) props.schedule(s)
  })
  return (
    <Stack
      context={props.context}
      rows={() => {
        const s = sid()
        return s ? (props.rows()[s] ?? []) : []
      }}
      onOpen={props.onOpen}
      onChecks={props.onChecks}
      onDismiss={(row) => {
        const s = sid()
        if (s) props.onDismiss(s, row)
      }}
    />
  )
}

export default Plugin.define({
  id: "pr-status",
  setup(context: any) {
    const rootCwd: string = context.location?.directory ?? process.cwd()

    const [rows, setRows] = createSignal<Record<string, RowData[]>>({})

    // One durable store holds dismissals, per-PR control toggles, and the last
    // action taken per PR (so auto-actions fire once, not every poll).
    let readStore: () => any
    let updateStore: (fn: (draft: any) => void) => void
    try {
      const [settings, update] = context.storage.store("pr-status", {
        initial: { dismissed: {}, controls: {}, acted: {} },
      })
      readStore = () => {
        const v = typeof settings === "function" ? settings() : settings
        return v ?? {}
      }
      updateStore = (fn) => update(fn)
    } catch {
      const mem: any = { dismissed: {}, controls: {}, acted: {} }
      readStore = () => mem
      updateStore = (fn) => fn(mem)
    }

    const readDismissed = (): Record<string, string[]> => readStore().dismissed ?? {}
    const readControls = (): Record<string, Controls> => readStore().controls ?? {}
    const readActed = (): Record<string, string> => readStore().acted ?? {}

    const controlsFor = (key: string): Controls => readControls()[key] ?? {}
    const setControl = (key: string, field: keyof Controls, value: boolean) =>
      updateStore((draft: any) => {
        draft.controls ??= {}
        draft.controls[key] ??= {}
        draft.controls[key][field] = value
      })
    const setActed = (key: string, signature: string) =>
      updateStore((draft: any) => {
        draft.acted ??= {}
        draft.acted[key] = signature
      })

    const states = new Map<string, SessionState>()

    const sessionDir = (sessionID: string): string => {
      try {
        const s = context.data.session.get?.(sessionID)
        return s?.location?.directory ?? s?.directory ?? rootCwd
      } catch {
        return rootCwd
      }
    }

    const stateFor = (sessionID: string): SessionState => {
      let st = states.get(sessionID)
      if (!st) {
        st = { refs: [], resolved: new Map(), repo: null, cwd: sessionDir(sessionID), scanning: false, timer: null }
        states.set(sessionID, st)
      }
      return st
    }

    const loadRepo = async (st: SessionState): Promise<string> => {
      if (st.repo !== null) return st.repo
      const info = await ghJson(["repo", "view", "--json", "nameWithOwner"], st.cwd)
      st.repo = info?.nameWithOwner ?? ""
      return st.repo
    }

    const loadMessages = async (sessionID: string): Promise<any[]> => {
      try {
        await context.data.session.message.sync?.(sessionID)
        const list = context.data.session.message.list?.(sessionID)
        if (Array.isArray(list) && list.length) return list
      } catch {}
      try {
        const res: any = await context.client.session.message.list({ sessionID })
        return Array.isArray(res?.data) ? res.data : (res ?? [])
      } catch {
        return []
      }
    }

    const resolve = async (st: SessionState, ref: Ref): Promise<RowData | null> => {
      const key = `${ref.repo}#${ref.number}`
      if (st.resolved.has(key)) return st.resolved.get(key) ?? null
      const args = ["pr", "view", String(ref.number), "--json", RESOLVE_FIELDS]
      if (ref.repo) args.push("--repo", ref.repo)
      const pr = await ghJson(args, st.cwd)
      const row = toRow(ref, pr)
      if (row && row.state === "OPEN" && row.repo) {
        const meta = await fetchGraphMeta(row.repo, row.number, st.cwd)
        if (meta) {
          row.unresolved = meta.unresolved
          if (meta.reviewDecision) row.reviewDecision = meta.reviewDecision
          if (meta.mergeable) row.mergeable = meta.mergeable
          if (meta.mergeStateStatus) row.mergeStateStatus = meta.mergeStateStatus
        }
      }
      st.resolved.set(key, row)
      return row
    }

    // Fire the enabled automations for a resolved row, at most once per state.
    const maybeAct = async (sessionID: string, list: RowData[], st: SessionState) => {
      for (const row of list) {
        const key = `${row.repo}#${row.number}`
        const c = controlsFor(key)
        const acted = readActed()

        if (
          c.autoMerge &&
          row.state === "OPEN" &&
          !row.isDraft &&
          row.mergeStateStatus === "CLEAN" &&
          acted[key] !== "merged"
        ) {
          const out = await run(
            "gh",
            ["pr", "merge", String(row.number), "--repo", row.repo, "--auto", "--squash"],
            st.cwd,
          )
          setActed(key, "merged")
          context.ui.toast.show({
            message: out != null ? `Auto-merge enabled for #${row.number}` : `Auto-merge failed for #${row.number}`,
            variant: out != null ? "success" : "error",
          })
        }

        if (c.autoFix && ciState(row.checks) === "fail") {
          const signature = `fix:${failingNames(row.checks)}`
          if (acted[key] !== signature) {
            try {
              await context.client.session.prompt({
                sessionID,
                text: `CI is failing for ${row.repo}#${row.number} (${row.url}). Investigate the failing checks and address the review comments, then push fixes.`,
              })
              setActed(key, signature)
              context.ui.toast.show({ message: `Auto-fix prompted for #${row.number}`, variant: "info" })
            } catch {
              context.ui.toast.show({ message: `Auto-fix could not prompt for #${row.number}`, variant: "error" })
            }
          }
        }
      }
    }

    const scan = async (sessionID: string) => {
      const st = stateFor(sessionID)
      if (st.scanning) return
      st.scanning = true
      try {
        const all = await loadMessages(sessionID)
        // Only the tail matters for references; keeps the sync walk cheap.
        const messages = all.length > 500 ? all.slice(-500) : all

        const fallback = await loadRepo(st)
        const found = refsFromMessages(messages, fallback)
        const merged = new Map<string, Ref>()
        for (const r of [...st.refs, ...found]) merged.set(`${r.repo}#${r.number}`, r)
        st.refs = [...merged.values()]

        const resolved = await Promise.all(st.refs.map((r) => resolve(st, r)))
        let list = resolved.filter((r): r is RowData => r !== null)

        const gone = new Set(readDismissed()[sessionID] ?? [])
        list = list.filter((r) => !gone.has(`${r.repo}#${r.number}`))

        setRows((prev) => ({ ...prev, [sessionID]: list }))
        await maybeAct(sessionID, list, st)
      } finally {
        st.scanning = false
      }
    }

    const schedule = (sessionID: string) => {
      const st = stateFor(sessionID)
      clearTimeout(st.timer)
      st.timer = setTimeout(() => void scan(sessionID), 500)
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current?.()
        return route?.type === "session" ? route.sessionID : undefined
      } catch {
        return undefined
      }
    }

    const on = (type: string, fn: (e: any) => void) => {
      try {
        return context.data.on(type, fn)
      } catch {
        return undefined
      }
    }
    let stopListen: any
    try {
      stopListen = context.data.listen?.((event: any) => {
        const d = event?.details ?? event
        const type = d?.type
        if (typeof type !== "string") return
        const sid = d?.properties?.sessionID
        if (!sid) return
        // Only react to the session in view. Background sessions streaming in
        // other tabs would otherwise trigger scans (and `gh` calls) constantly.
        if (sid !== currentSessionID()) return
        if (type.startsWith("message") || type.startsWith("part") || type === "session.idle") {
          schedule(sid)
        }
      })
    } catch {}
    const offs = [
      on("session.idle", (e: any) => {
        const sid = e?.data?.sessionID ?? currentSessionID()
        if (!sid) return
        stateFor(sid).resolved.clear()
        schedule(sid)
      }),
    ].filter(Boolean)
    // Poll only the session in view — scanning every known session meant an
    // ever-growing amount of `gh` work in the background.
    const poll = setInterval(() => {
      const sid = currentSessionID()
      if (!sid) return
      stateFor(sid).resolved.clear()
      void scan(sid)
    }, 30_000)

    const openUrl = async (url: string) => {
      if (!url) return
      await run("open", [url], rootCwd)
    }

    const openControls = (row: RowData) => {
      const key = `${row.repo}#${row.number}`
      const [controls, setControls] = createSignal<Controls>(controlsFor(key))
      try {
        context.ui.dialog.set?.({ size: "medium", centered: true })
      } catch {}
      context.ui.dialog.show(
        () => (
          <ControlPanel
            context={context}
            row={row}
            controls={controls}
            toggle={(field) => {
              const next = !controls()[field]
              setControl(key, field, next)
              setControls({ ...controls(), [field]: next })
            }}
            onOpen={() => void openUrl(row.url)}
          />
        ),
        () => {},
      )
    }

    const dismiss = (sessionID: string, row: RowData) => {
      const key = `${row.repo}#${row.number}`
      updateStore((draft: any) => {
        draft.dismissed ??= {}
        draft.dismissed[sessionID] ??= []
        if (!draft.dismissed[sessionID].includes(key)) draft.dismissed[sessionID].push(key)
      })
      setRows((prev) => ({
        ...prev,
        [sessionID]: (prev[sessionID] ?? []).filter((r) => r.key !== key),
      }))
    }

    // Parse a manually supplied PR reference: URL, owner/repo#123, or a number
    // (resolved against the session's repo).
    const parseManualRef = async (st: SessionState, input: string): Promise<Ref | null> => {
      const text = input.trim()
      const url = text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
      if (url) return { repo: url[1], number: Number(url[2]) }
      const slash = text.match(/([\w.-]+\/[\w.-]+)#(\d{1,6})/)
      if (slash) return { repo: slash[1], number: Number(slash[2]) }
      const num = text.match(/(\d{1,6})/)?.[1]
      if (num) {
        const repo = await loadRepo(st)
        if (repo) return { repo, number: Number(num) }
      }
      return null
    }

    // Add a PR to tracking on request (from the assistant's `monitor_pr` tool —
    // detected via the transcript — or the /monitor-pr command).
    const addManual = async (sessionID: string, input: string) => {
      const st = stateFor(sessionID)
      const ref = await parseManualRef(st, input)
      if (!ref) {
        context.ui.toast.show({
          message: `Could not read a PR from "${input}"`,
          variant: "error",
        })
        return
      }
      const key = `${ref.repo}#${ref.number}`
      if (!st.refs.some((r) => `${r.repo}#${r.number}` === key)) st.refs.push(ref)
      // Un-dismiss it if it was previously removed.
      updateStore((draft: any) => {
        const arr = draft.dismissed?.[sessionID]
        if (Array.isArray(arr)) draft.dismissed[sessionID] = arr.filter((k: string) => k !== key)
      })
      await scan(sessionID)
      context.ui.toast.show({ message: `Monitoring ${key}`, variant: "success" })
    }

    context.ui.slot({
      append: "session.composer.top",
      render: (input: any) => (
        <ComposerSlot
          context={context}
          input={input}
          rows={rows}
          schedule={schedule}
          onOpen={(r: RowData) => void openUrl(r.url)}
          onChecks={openControls}
          onDismiss={dismiss}
        />
      ),
    })

    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap?.layer?.(() => ({
            mode: "global",
            commands: [
              {
                id: "pr-status.refresh",
                title: "PR status: refresh",
                group: "PR status",
                palette: true,
                run: () => {
                  const sid = currentSessionID()
                  if (!sid) return
                  stateFor(sid).resolved.clear()
                  void scan(sid)
                },
              },
              {
                id: "pr-status.restore",
                title: "PR status: restore dismissed",
                group: "PR status",
                palette: true,
                run: () => {
                  const sid = currentSessionID()
                  if (!sid) return
                  updateStore((draft: any) => {
                    if (draft.dismissed) delete draft.dismissed[sid]
                  })
                  void scan(sid)
                },
              },
              {
                id: "pr-status.monitor",
                title: "PR status: monitor a PR",
                group: "PR status",
                palette: true,
                slash: { name: "monitor-pr", arguments: true },
                run: async (input: any) => {
                  const sid = currentSessionID()
                  if (!sid) {
                    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
                    return
                  }
                  let value = typeof input === "string" ? input.trim() : ""
                  if (!value) {
                    value =
                      (await context.ui.dialog.prompt({
                        title: "Monitor PR",
                        placeholder: "PR URL, owner/repo#123, or number",
                      })) ?? ""
                  }
                  value = value.trim()
                  if (value) await addManual(sid, value)
                },
              },
            ],
            bindings: ["pr-status.refresh", "pr-status.restore", "pr-status.monitor"],
          }))
        } catch {}
        return null
      },
    })

    return () => {
      for (const st of states.values()) clearTimeout(st.timer)
      clearInterval(poll)
      offs.forEach((off: any) => off?.())
      stopListen?.()
    }
  },
})
