import { Plugin } from "@opencode/plugin"
import { listPulls, type ListInput } from "./pulls"
import { Pulls } from "./rpc"

// Lets you ask the assistant to start tracking a PR in the PR status widget.
// The widget watches the transcript for this tool call, so the tool itself has
// no side effects. Accepts a PR URL, owner/repo#number, or a bare PR number.
export default Plugin.define({
  id: "opencode-pr-status",
  async setup(ctx) {
    await ctx.rpc.register(Pulls, {
      list: async (input) => listPulls(ctx.storage, input as ListInput),
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "monitor_pr",
        description:
          "Start tracking a GitHub pull request in the OpenCode PR status widget. Call this when the user asks to monitor, track, or watch a specific PR. Accepts a PR URL, owner/repo#number, or a bare PR number.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description:
                "PR URL (https://github.com/owner/repo/pull/123), owner/repo#123, or a PR number",
            },
          },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(input) {
          const pr = String((input as { pr?: unknown })?.pr ?? "").trim()
          return { content: `Monitoring PR ${pr}` }
        },
      })
    })
  },
})
