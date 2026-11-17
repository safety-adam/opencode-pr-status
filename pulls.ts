import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { ciState, pullStatus, refsFromMessages, type Check, type Ref } from "./shared"
import type { Pull } from "./rpc"

const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]
const STORE_KEY = "pr-status"
const REFS_VERSION = 2
const RESOLVE_FIELDS =
  "number,title,url,headRefName,isDraft,reviewDecision,statusCheckRollup,state,mergeable,mergeStateStatus,mergedAt,additions,deletions"
const META_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue mergeQueueEntry{position} latestReviews(first:20){nodes{state}} reviewThreads(first:100){totalCount nodes{isResolved}}}}}"

type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
}

export type ListInput = {
  sessionID: string
  directory: string
  messages: unknown[]
  refs: Ref[]
}

type Stored = {
  refs?: Record<string, Ref[]>
  refsVersion?: number
}

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

function checksOf(value: unknown[]): string {
  if (value.length === 0) return ""
  const state = ciState(value as Check[])
  return state === "pass" ? "passing" : state === "fail" ? "failing" : "pending"
}

function toRow(raw: Record<string, unknown>): Pull {
  let reviewDecision = String(raw.reviewDecision ?? "").toUpperCase()
  if (!reviewDecision && Array.isArray(raw.latestReviews)) {
    const states = raw.latestReviews.map((r: any) => String(r?.state ?? "").toUpperCase())
    if (states.includes("CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED"
    else if (states.includes("APPROVED")) reviewDecision = "APPROVED"
  }

  const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []
  const overall = pullStatus({
    checks,
    state: String(raw.state ?? ""),
    reviewDecision,
    mergeable: String(raw.mergeable ?? ""),
    mergeStateStatus: String(raw.mergeStateStatus ?? ""),
    isDraft: Boolean(raw.isDraft),
    unresolved: Number(raw.unresolved ?? 0),
    queued: Boolean(raw.queued),
    queuePosition: typeof raw.queuePosition === "number" ? raw.queuePosition : null,
  })

  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    branch: String(
      raw.headRefName ?? (raw.repository as { nameWithOwner?: unknown })?.nameWithOwner ?? "",
    ),
    checks: checksOf(checks),
    review: reviewDecision.toLowerCase().replace(/_/g, " "),
    comments: String(raw.comments ?? "0 comments"),
    status: overall.label,
    tone: overall.tone,
    queued: Boolean(raw.queued),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    draft: Boolean(raw.isDraft),
  }
}

async function metaFor(repo: string, number: number, directory: string) {
  const fallback = {
    comments: "0 comments",
    unresolved: 0,
    queued: false,
    queuePosition: null as number | null,
    latestReviews: [] as { state?: string }[],
  }
  const [owner, name] = repo.split("/")
  if (!owner || !name) return fallback
  try {
    const raw = (await ghJson(
      [
        "api",
        "graphql",
        "-f",
        `query=${META_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ],
      directory,
    )) as any
    const pr = raw?.data?.repository?.pullRequest
    if (!pr) return fallback
    const nodes = Array.isArray(pr.reviewThreads?.nodes) ? pr.reviewThreads.nodes : []
    const resolved = nodes.filter((thread: any) => thread?.isResolved === true).length
    const unresolved = nodes.length - resolved
    return {
      unresolved,
      comments:
        [
          unresolved ? `${unresolved} unresolved` : "",
          resolved ? `${resolved} resolved` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "0 comments",
      queued: pr.isInMergeQueue === true || Boolean(pr.mergeQueueEntry),
      queuePosition:
        typeof pr.mergeQueueEntry?.position === "number" ? pr.mergeQueueEntry.position : null,
      latestReviews: pr.latestReviews?.nodes ?? [],
    }
  } catch {
    return fallback
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

async function trackedRefs(storage: Storage, input: ListInput): Promise<Ref[]> {
  const stored = ((await storage.get(STORE_KEY)) ?? {}) as Stored
  const saved = stored.refsVersion === REFS_VERSION ? (stored.refs?.[input.sessionID] ?? []) : []
  const fallbackRepo = await repoOf(input.directory)
  const messages = input.messages.length > 500 ? input.messages.slice(-500) : input.messages
  const found = refsFromMessages(messages, fallbackRepo)
  const merged = new Map<string, Ref>()

  for (const ref of [...saved, ...input.refs, ...found]) {
    if (ref.repo && Number.isInteger(ref.number) && ref.number > 0) {
      merged.set(`${ref.repo}#${ref.number}`, { repo: ref.repo, number: ref.number })
    }
  }

  const refs = [...merged.values()]
  if (refs.length !== saved.length) {
    await storage.set(STORE_KEY, {
      refs: { ...(stored.refs ?? {}), [input.sessionID]: refs },
      refsVersion: REFS_VERSION,
    })
  }
  return refs
}

export async function listPulls(storage: Storage, input: ListInput): Promise<Pull[]> {
  const refs = await trackedRefs(storage, input)
  const rows: Pull[] = []

  for (const ref of refs) {
    try {
      const raw = (await ghJson(
        ["pr", "view", String(ref.number), "--repo", ref.repo, "--json", RESOLVE_FIELDS],
        input.directory,
      )) as Record<string, unknown>
      if (raw && typeof raw === "object") {
        rows.push(toRow({ ...raw, ...(await metaFor(ref.repo, ref.number, input.directory)) }))
      }
    } catch {
      // One unavailable PR must not remove every other row from the panel.
    }
  }
  return rows
}
