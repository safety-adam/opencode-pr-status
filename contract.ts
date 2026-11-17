import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

const StoredRef = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
})

// Imports refs saved by older Desktop versions. The server owns all new refs.
export const LegacyRefs = Ipc.define({
  id: "opencode-pr-status.legacy-refs",
  methods: {
    list: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: Schema.Array(StoredRef),
    },
  },
})
