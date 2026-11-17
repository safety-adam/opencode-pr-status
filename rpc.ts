import { Rpc } from "@opencode/plugin/rpc"

export type Pull = {
  number: number
  title: string
  url: string
  branch: string
  checks: string
  review: string
  comments: string
  status: string
  tone: string
  queued: boolean
  additions: number
  deletions: number
  draft: boolean
}

const PULL_SCHEMA = {
  type: "object",
  properties: {
    number: { type: "number" },
    title: { type: "string" },
    url: { type: "string" },
    branch: { type: "string" },
    checks: { type: "string" },
    review: { type: "string" },
    comments: { type: "string" },
    status: { type: "string" },
    tone: { type: "string" },
    queued: { type: "boolean" },
    additions: { type: "number" },
    deletions: { type: "number" },
    draft: { type: "boolean" },
  },
  required: [
    "number",
    "title",
    "url",
    "branch",
    "checks",
    "review",
    "comments",
    "status",
    "tone",
    "queued",
    "additions",
    "deletions",
    "draft",
  ],
  additionalProperties: false,
} as const

export const Pulls = Rpc.define({
  id: "opencode-pr-status",
  methods: {
    list: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          directory: { type: "string" },
          messages: { type: "array", items: {} },
          refs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                repo: { type: "string" },
                number: { type: "number" },
              },
              required: ["repo", "number"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "directory", "messages", "refs"],
        additionalProperties: false,
      },
      output: { type: "array", items: PULL_SCHEMA },
    },
  },
  events: {},
})
