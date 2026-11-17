import { execFile } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Command, Panel, Plugin, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { Pulls, type Pull } from "./contract"
import { refsFromMessages } from "./shared"

// gh is not on the PATH Electron gets when the app starts from Finder.
const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]

function ghBin(): string {
  for (const candidate of GH_CANDIDATES) {
    if (candidate === "gh" || existsSync(candidate)) return candidate
  }
  return "gh"
}

function ghJson(args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      ghBin(),
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout || "[]"))),
    )
  })
}

function checksOf(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ""
  const states = value.map((item) =>
    String(
      (item as { conclusion?: unknown })?.conclusion ??
        (item as { status?: unknown })?.status ??
        "",
    ),
  )
  if (states.some((state) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(state))) return "failing"
  if (states.some((state) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING/.test(state))) return "pending"
  return "passing"
}

function toRow(raw: Record<string, unknown>): Pull {
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    branch: String(
      raw.headRefName ?? (raw.repository as { nameWithOwner?: unknown })?.nameWithOwner ?? "",
    ),
    checks: checksOf(raw.statusCheckRollup),
    review: String(raw.reviewDecision ?? "").toLowerCase().replace(/_/g, " "),
    comments: "",
    draft: Boolean(raw.isDraft),
  }
}

const MUTED = { opacity: 0.6 }

function statusColour(row: Pull): string {
  if (row.checks === "failing" || row.review === "changes requested") return "var(--icon-critical-base, #e06b75)"
  if (row.checks === "pending" || row.review === "review required") return "var(--icon-warning-base, #f1c21b)"
  if (row.checks === "passing" || row.review === "approved") return "var(--icon-success-base, #80d98f)"
  return "var(--text-weak, #808080)"
}

function checkLabel(checks: string): string {
  if (checks === "passing") return "checks passing"
  if (checks === "failing") return "checks failing"
  if (checks === "pending") return "checks pending"
  return checks
}

function checkColour(checks: string): string {
  if (checks === "failing") return "var(--icon-critical-base, #e06b75)"
  if (checks === "pending") return "var(--icon-warning-base, #f1c21b)"
  if (checks === "passing") return "var(--icon-success-base, #80d98f)"
  return "var(--text-weak, #808080)"
}

function checkBackground(checks: string): string {
  if (checks === "failing") return "var(--surface-critical-weak, rgba(224, 107, 117, 0.16))"
  if (checks === "pending") return "var(--surface-warning-weak, rgba(241, 194, 27, 0.16))"
  if (checks === "passing") return "var(--surface-success-weak, rgba(128, 217, 143, 0.16))"
  return "transparent"
}

function statusPill(foreground: string, background: string) {
  return {
    color: foreground,
    background,
    padding: "0px 5px",
    "border-radius": "4px",
  }
}

function reviewColour(review: string): string {
  if (review === "approved") return "var(--icon-success-base, #80d98f)"
  if (review === "changes requested") return "var(--icon-critical-base, #e06b75)"
  if (review === "review required") return "var(--icon-warning-base, #f1c21b)"
  return "var(--text-weak, #808080)"
}

function reviewPill(review: string) {
  return statusPill(reviewColour(review), review === "approved" ? "var(--surface-success-weak, rgba(128, 217, 143, 0.16))" : review === "changes requested" ? "var(--surface-critical-weak, rgba(224, 107, 117, 0.16))" : review === "review required" ? "var(--surface-warning-weak, rgba(241, 194, 27, 0.16))" : "transparent")
}

const GUI_LOG = "/Users/adam.farmer/.config/opencode/tui/pr-status/gui.log"

function guiLog(message: string) {
  try {
    appendFileSync(GUI_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}"

async function commentsFor(repo: string, number: number, directory: string): Promise<string> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return ""
  try {
    const raw = (await ghJson(
      [
        "api",
        "graphql",
        "-f",
        `query=${THREADS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ],
      directory,
    )) as any
    const nodes = raw?.data?.repository?.pullRequest?.reviewThreads?.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return "0 comments"
    const resolved = nodes.filter((thread: any) => thread?.isResolved === true).length
    const unresolved = nodes.length - resolved
    return [
      unresolved ? `${unresolved} unresolved` : "",
      resolved ? `${resolved} resolved` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  } catch (error) {
    guiLog(`commentsFor error ${String(error)}`)
    return ""
  }
}

async function repoOf(directory: string): Promise<string> {
  try {
    const raw = (await ghJson(["repo", "view", "--json", "nameWithOwner"], directory)) as {
      nameWithOwner?: unknown
    }
    return typeof raw?.nameWithOwner === "string" ? raw.nameWithOwner : ""
  } catch {
    return ""
  }
}

// The main context has no client, so read the session transcript over HTTP from
// the server that owns the session.
async function sessionMessages(
  ctx: { serverEndpoints: { get(id: string): { url: string; headers?: Record<string, string> } | undefined } },
  sessionID: string,
  serverID: string,
): Promise<unknown[]> {
  const endpoint = ctx.serverEndpoints.get(serverID) ?? ctx.serverEndpoints.get("sidecar")
  if (!endpoint) {
    guiLog(`no endpoint for ${serverID}`)
    return []
  }

  try {
    const response = await fetch(`${endpoint.url}/api/session/${sessionID}/message`, {
      headers: endpoint.headers,
    })
    if (!response.ok) {
      guiLog(`sessionMessages http ${response.status}`)
      return []
    }
    const res = (await response.json()) as { data?: unknown }
    if (Array.isArray(res.data)) return res.data
    return Array.isArray(res) ? res : []
  } catch (error) {
    guiLog(`sessionMessages error ${String(error)}`)
    return []
  }
}

function PullsPanel() {
  const ctx = usePlugin()
  const [rows, setRows] = createSignal<Pull[]>([])
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)

  // Cache rows by session so switching back renders the last known state at once.
  const cache = new Map<string, Pull[]>()
  let generation = 0

  const load = async (key: string, session: any) => {
    const request = ++generation
    try {
      const rawId = (session as unknown as { id: unknown }).id
      const sessionID = typeof rawId === "function" ? (rawId as () => unknown)() : rawId
      const pulls = await ctx.main(Pulls).list({
        sessionID: String(sessionID),
        serverID: session.server.id,
        directory: session.directory,
      })
      cache.set(key, pulls)
      if (request === generation) {
        setRows(pulls)
        setError(undefined)
      }
    } catch (cause) {
      if (request === generation) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === generation) setLoading(false)
    }
  }

  const currentKey = () => {
    const session = ctx.sessions.current()
    return session ? `${session.server.id}:${session.id}` : undefined
  }

  // Reload immediately when the routed session changes, restoring its cache first.
  createEffect(() => {
    const session = ctx.sessions.current()
    const key = currentKey()
    if (!session || !key) {
      setRows([])
      setLoading(false)
      return
    }
    const previous = cache.get(key)
    setRows(previous ?? [])
    setLoading(previous === undefined)
    void load(key, session)
  })
  const timer = setInterval(() => {
    const session = ctx.sessions.current()
    const key = currentKey()
    if (session && key) void load(key, session)
  }, 30_000)
  onCleanup(() => clearInterval(timer))

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "overflow-y": "auto" }}>
      <Show when={error()}>
        <div style={{ padding: "10px", "font-size": "12px", color: "var(--text-critical, #d33)" }}>{error()}</div>
      </Show>
      <Show when={!loading() && !error() && rows().length === 0}>
        <div style={{ padding: "10px", "font-size": "12px", ...MUTED }}>No open pull requests.</div>
      </Show>
      <For each={rows()}>
        {(row) => (
          <div
            style={{
              padding: "8px 10px 8px 9px",
              "border-left": `2px solid ${statusColour(row)}`,
              "border-bottom": "1px solid var(--border-weak, rgba(127,127,127,0.18))",
              "line-height": "1.5",
              "font-size": "12px",
              cursor: "pointer",
            }}
            title={row.branch}
            onClick={() => ctx.system.openExternal(row.url)}
          >
            <div style={{ display: "flex", gap: "6px", "align-items": "baseline", "min-width": "0" }}>
              <span style={{ color: statusColour(row), opacity: 0.85 }}>#{row.number}</span>
              <span
                style={{
                  flex: "1",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                  "font-weight": 500,
                  color: "inherit",
                }}
              >
                {row.title}
              </span>
              <Show when={row.draft}>
                <span style={statusPill("var(--text-weak, #808080)", "var(--surface-weak, rgba(128, 128, 128, 0.14))")}>draft</span>
              </Show>
            </div>
            <div
              style={{
                display: "flex",
                gap: "6px",
                "align-items": "center",
                "margin-top": "1px",
                "font-size": "11px",
                "white-space": "nowrap",
                "min-width": "0",
              }}
            >
              <Show when={row.checks}>
                <span style={statusPill(checkColour(row.checks), checkBackground(row.checks))}>{checkLabel(row.checks)}</span>
              </Show>
              <Show when={row.checks && row.review}>
                <span style={MUTED}>·</span>
              </Show>
              <Show when={row.review}>
                <span style={reviewPill(row.review)}>{row.review}</span>
              </Show>
              <Show when={(row.checks || row.review) && row.comments}>
                <span style={MUTED}>·</span>
              </Show>
              <Show when={row.comments}>
                <span style={{ color: "var(--text-weak, #808080)" }}>{row.comments}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

const tab: PanelTab = {
  id: "pulls",
  get title() {
    return "Pull requests"
  },
  closable: "compact",
  pinned: true,
}

export default Plugin.define({
  setup(ctx) {
    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:pulls`, session, { tab: "select", background: true })
    }

    ctx.add(
      Command,
      (): Command => ({
        id: "open",
        title: "Pull requests",
        description: "Show this session's open pull requests in the side panel",
        keywords: "pr github status",
        bind: "mod+shift+p",
        run: open,
      }),
    )

    // Prototype: show it without hunting for the command. Once per window.
    let attempts = 0
    const autoOpen = () => {
      attempts += 1
      const session = ctx.sessions.current()
      if (session && ctx.layout.ready() && ctx.layout.state(`${ctx.id}:pulls`, session) === "closed") {
        ctx.layout.open(`${ctx.id}:pulls`, session, { tab: "select", background: true })
        return
      }
      if (attempts < 10) setTimeout(autoOpen, 800)
    }
    setTimeout(autoOpen, 800)

    ctx.add(Panel, {
      id: "pulls",
      region: "side",
      width: "narrow",
      mobile: {
        get title() {
          return "Pull requests"
        },
        order: 40,
        kind: "menu",
        icon: "github",
      },
      list: () => [tab],
      render: () => <PullsPanel />,
    })
  },

  main(ctx) {
    guiLog("gui main started")
    ctx.log?.write?.("info", "pr-status gui main started")
    ctx.provide(Pulls, {
      list: async (input) => {
        ctx.log?.write?.("info", "pr-status list", { sessionID: input.sessionID, directory: input.directory })
        guiLog(`list ${input.sessionID} ${input.directory}`)
        const messages = await sessionMessages(ctx as any, input.sessionID, input.serverID)
        const fallbackRepo = await repoOf(input.directory)
        guiLog(`messages ${messages.length}`)
        const refs = refsFromMessages(messages, fallbackRepo)
        guiLog(`refs ${refs.length}`)

        const rows: Pull[] = []
        for (const ref of refs) {
          try {
            const raw = (await ghJson(
              [
                "pr",
                "view",
                String(ref.number),
                "--repo",
                ref.repo,
                "--json",
                "number,title,url,headRefName,isDraft,reviewDecision,statusCheckRollup",
              ],
              input.directory,
            )) as Record<string, unknown>
            if (raw && typeof raw === "object") {
              const row = toRow(raw)
              rows.push({ ...row, comments: await commentsFor(ref.repo, ref.number, input.directory) })
            }
          } catch {}
        }

        guiLog(`rows ${rows.length}`)
        ctx.log?.write?.("info", "pr-status rows", { count: rows.length, refs: refs.length })
        return rows
      },
    })
  },
})
