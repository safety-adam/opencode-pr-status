import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

// One row in the panel. Every field is a string or number so the bridge never
// has to encode null.
export const Pull = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  branch: Schema.String,
  checks: Schema.String,
  review: Schema.String,
  comments: Schema.String,
  status: Schema.String,
  tone: Schema.String,
  queued: Schema.Boolean,
  draft: Schema.Boolean,
})

export type Pull = Schema.Schema.Type<typeof Pull>

// main runs gh, the window can only call it.
export const Pulls = Ipc.define({
  id: "opencode-pr-status.pulls",
  methods: {
    list: {
      input: Schema.Struct({ sessionID: Schema.String, serverID: Schema.String, directory: Schema.String }),
      output: Schema.Array(Pull),
    },
  },
})
