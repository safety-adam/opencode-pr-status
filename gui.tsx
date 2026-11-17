import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Command, Panel, Plugin, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { LegacyRefs } from "./contract"
import { Pulls, type Pull } from "./rpc"
import { GITHUB_MERGED_PURPLE } from "./shared"

const MUTED = { opacity: 0.6 }

const TONE_COLOURS: Record<string, string> = {
  critical: "#e06b75",
  warning: "#f1c21b",
  success: "var(--icon-success-base, #80d98f)",
  info: "#80d0ff",
  neutral: "#808080",
  merged: GITHUB_MERGED_PURPLE,
}

function statusColour(row: Pull): string {
  return TONE_COLOURS[row.tone] ?? TONE_COLOURS.neutral
}

function statusBackground(row: Pull): string {
  if (row.tone === "neutral") return "transparent"
  return `color-mix(in srgb, ${statusColour(row)} 10%, transparent)`
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
      const sessionID = String(typeof rawId === "function" ? (rawId as () => unknown)() : rawId)
      const client = session.server.client ?? ctx.client
      const response = await client.message.list({ sessionID, limit: 200, order: "desc" })
      const refs =
        ctx.app.platform === "desktop"
          ? await ctx.main(LegacyRefs).list({ sessionID }).catch(() => [])
          : []
      const pulls = (await ctx.client.rpc(Pulls).list({
        sessionID,
        directory: session.directory,
        messages: Array.isArray(response.data) ? response.data : [],
        refs,
      })) as Pull[]
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
              "border-left": "none",
              position: "relative",
              background: statusBackground(row),
              "border-bottom": "1px solid var(--border-weak, rgba(127,127,127,0.18))",
              "line-height": "1.5",
              "font-size": "12px",
              cursor: "pointer",
            }}
            title={row.branch}
            onClick={() => ctx.system.openExternal(row.url)}
          >
            <span
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "3px",
                background: statusColour(row),
                "flex-shrink": 0,
              }}
            />
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
                <span style={statusPill("var(--text-base, #ededed)", "rgba(255, 255, 255, 0.16)")}>draft</span>
              </Show>
              <Show when={row.additions || row.deletions}>
                <span style={{ color: "#80d98f", "flex-shrink": 0 }}>{`+${row.additions}`}</span>
                <span style={{ color: "#e06b75", "flex-shrink": 0 }}>{`-${row.deletions}`}</span>
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
              <Show when={row.status !== "Merged" && row.status !== "Closed" && row.checks}>
                <span style={statusPill(checkColour(row.checks), checkBackground(row.checks))}>{checkLabel(row.checks)}</span>
              </Show>
              <Show when={row.status !== "Merged" && row.status !== "Closed" && row.checks && row.review}>
                <span style={MUTED}>·</span>
              </Show>
              <Show when={row.status !== "Merged" && row.status !== "Closed" && row.review}>
                <span style={reviewPill(row.review)}>{row.review}</span>
              </Show>
              <Show when={row.status !== "Merged" && row.status !== "Closed" && row.queued}>
                <span
                  style={statusPill(
                    "var(--text-interactive-base, #80d0ff)",
                    "var(--surface-info-weak, rgba(128, 208, 255, 0.16))",
                  )}
                >
                  {row.status}
                </span>
              </Show>
              <Show when={row.status === "Merged"}>
                <span
                  style={statusPill(
                    "#d2a8ff",
                    "rgba(130, 80, 223, 0.14)",
                  )}
                >
                  Merged
                </span>
              </Show>
              <Show when={row.status === "Closed"}>
                <span
                  style={statusPill(
                    "var(--text-weak, #808080)",
                    "var(--surface-weak, rgba(128, 128, 128, 0.14))",
                  )}
                >
                  Closed
                </span>
              </Show>
              <Show when={(row.checks || row.review) && row.comments}>
                <span style={MUTED}>·</span>
              </Show>
                <span style={{ "margin-left": "auto", color: "var(--text-weak, #808080)" }}>{row.comments || "0 comments"}</span>
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
    const savedRefs = ctx.storage.store("pr-status", {
      schema: Schema.Unknown,
      initial: { refs: {} },
    })
    ctx.provide(LegacyRefs, {
      list: async (input) => ((savedRefs.value as any)?.refs?.[input.sessionID] ?? []),
    })
  },
})
