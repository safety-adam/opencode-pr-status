# Project instructions

This repository is **public**. Everything committed here — code, comments, commit
messages, and history — is world-readable. Treat that as a hard constraint on every change.

## Never commit anything sensitive or internal

Do not add any of the following, in code, comments, docs, examples, commit messages,
branches, or filenames:

- **Secrets/credentials**: API keys, access tokens, OAuth secrets, passwords, private keys
  (e.g. `gho_…`, `ghp_…`, `github_pat_…`, `sk-…`, `xoxb-…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`),
  `.env` files, or connection strings.
- **Internal identifiers**: employer/company names, private repository names, ticket keys,
  internal PR numbers, customer data, personal names, emails, or hostnames.

## Use generic placeholders

In code, comments, tests, and docs, use neutral placeholders:

- Repos: `acme/api`, `owner/repo`
- PR/issue numbers: `#42`, `#43`
- Plugin IDs: `pr-status`, `pr-monitor` (not a personal namespace)

## Scan before every push

Run the scan before committing/pushing:

```sh
scripts/secret-scan.sh
```

It is also wired as a pre-commit hook (enable once per clone):

```sh
git config core.hooksPath .githooks
```

The hook scans staged files and blocks the commit if it finds a secret or internal
reference. Do not bypass it with `--no-verify`.

### Internal identifiers

Keep the list of internal names out of this repo. Put them, one per line, in an
untracked `.denylist` file at the repo root; the scan reads it if present. That file
is gitignored — never commit it. The scanner only embeds generic credential patterns,
so this public repo never names an internal identifier.

## If a secret is ever committed

Do not simply push a follow-up fix. Rotate the exposed credential immediately, then
rewrite the history to remove it (`git filter-repo` or a fresh history) before it spreads.
Public Git history is permanent and mirrored quickly.

## Project overview

An OpenCode plugin with server, TUI, and GUI entrypoints.

- `pr-monitor.ts` registers the `monitor_pr` tool and the PR lookup RPC (entrypoint `.`).
- `pulls.ts` resolves GitHub rows and stores tracked refs on the server.
- `rpc.ts` defines the portable RPC contract shared with GUI windows.
- `tui.tsx` renders the PR stack in the terminal (entrypoint `./tui`).
- `gui.tsx` renders the Desktop and Web side panel (entrypoint `./gui-experimental`).

Detection is intentionally narrow. Only PR creation commands and `monitor_pr`
tool calls are tracked. Arbitrary transcript text, inspection commands, and file contents are ignored.
