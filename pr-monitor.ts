import { Plugin } from "@opencode/plugin"

// Lets you ask the assistant to start tracking a PR in the PR status widget.
// The widget watches the transcript for this tool call, so the tool itself has
// no side effects — it just surfaces the PR reference. Accepts a PR URL,
// owner/repo#number, or a bare PR number.
export default Plugin.define({
  id: "pr-monitor",
  async setup(ctx) {
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
