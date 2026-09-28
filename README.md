# opencode-pr-status

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![OpenCode v2](https://img.shields.io/badge/OpenCode-v2-blue)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

A GitHub pull request status widget for the [OpenCode](https://opencode.ai) terminal UI.

It watches the current session for PRs the agent is working on and renders a compact
stacked status just above the prompt composer:

<img width="1559" height="117" alt="image" src="https://github.com/user-attachments/assets/eadb38c8-ddd2-4422-be22-89b6f325bb03" />


## Features

- **Per-session stacks.** Every session shows only its own PRs; nothing leaks between sessions.
- **Deliberately narrow detection.** A PR is tracked only when the agent runs an explicit
  `gh pr ...` command for it (or calls the `monitor_pr` tool). File contents and prose are
  never scanned, so reading a file that mentions a PR does not surface it.
- **Collapsed status chip.** Dot colour + `CI` + unresolved-review-comment count + GitHub-aligned
  state (`Checks pending`, `Review required`, `Changes requested`, `Conflicts`, `Behind base`,
  `Ready to merge`, `Draft`).
- **Merged / closed rows.** Rendered as distinct bars.
- **CI monitoring panel** (click the chip or `▲`): review state, unresolved comments, mergeability,
  plus two opt-in automations — *Auto-fix CI & address comments* and *Auto-merge when ready*.
- **Ask the assistant to track a PR.** The `monitor_pr` tool lets you say "monitor PR #123".
- **`/monitor-pr` command** to add a PR manually.

## Requirements

- [OpenCode](https://opencode.ai) v2
- The [`gh`](https://cli.github.com) CLI, installed and authenticated (`gh auth login`)

## Install

This package exposes two entrypoints:

- `.` — the server plugin that registers the `monitor_pr` tool
- `./tui` — the terminal UI plugin that renders the stack

Add it to `opencode.json(c)` (server side) and `cli.json` (terminal side):

```jsonc title="opencode.jsonc"
{
  "plugins": ["opencode-pr-status"]
}
```

```jsonc title="cli.json"
{
  "plugins": ["opencode-pr-status"]
}
```

Using local files instead of a package:

```jsonc title="opencode.jsonc"
{ "plugins": ["file:///absolute/path/to/pr-monitor.ts"] }
```

```jsonc title="cli.json"
{ "plugins": ["/absolute/path/to/tui.tsx"] }
```

## Usage

- The stack appears automatically as the agent runs `gh pr` commands.
- Click a row to open the PR, click the status chip or `▲` for the monitoring panel, click `×` to dismiss.
- Palette (`Ctrl+P`): *PR status: refresh*, *PR status: restore dismissed*, *PR status: monitor a PR*.
- Slash command: `/monitor-pr <url | owner/repo#123 | number>`.
- Ask the assistant: "monitor PR #123" (it calls the `monitor_pr` tool).

## How detection works

For each session the plugin scans the transcript for:

- shell/tool commands matching `gh pr <subcommand> ...` and reads the PR reference from the command
  (`--repo`/`-R` + number) or its output URL, and
- `monitor_pr` tool calls (explicit user request).

Review state, unresolved review threads, and mergeability are fetched per open PR via the GitHub
GraphQL API through `gh`.

## Security

- No credentials are stored by this plugin; it relies on your existing `gh` authentication.
- It runs `gh`, `gh api graphql`, and `open` (to open a PR) as subprocesses.
- It reads the current session's transcript to find PR references.

See `CLAUDE.md` for the repository's public-repo content policy.

## License

MIT
