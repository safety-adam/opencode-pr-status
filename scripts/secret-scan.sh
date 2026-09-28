#!/usr/bin/env bash
# Public-repo guard: scan tracked text files for secrets and internal identifiers.
# Exits non-zero (blocking a commit) if anything looks sensitive.
set -euo pipefail

# Generic credential patterns.
PATTERNS='(gho_|ghp_|ghs_|github_pat_)[A-Za-z0-9]{20,}'
PATTERNS="$PATTERNS"'|sk-[A-Za-z0-9]{16,}'
PATTERNS="$PATTERNS"'|xox[baprs]-[A-Za-z0-9-]{10,}'
PATTERNS="$PATTERNS"'|AKIA[0-9A-Z]{16}'
PATTERNS="$PATTERNS"'|-----BEGIN [A-Z ]*PRIVATE KEY-----'
PATTERNS="$PATTERNS"'|(api[_-]?key|apikey|secret|password|passwd|token|authorization)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+=-]{8,}'

# Internal identifiers live in an untracked per-clone denylist so this public
# repo never names them. One term per line; blank lines and # comments ignored.
LOCAL_DENYLIST=".denylist"
if [ -f "$LOCAL_DENYLIST" ]; then
  extra="$(grep -vE '^[[:space:]]*(#|$)' "$LOCAL_DENYLIST" | paste -sd'|' - || true)"
  [ -n "$extra" ] && PATTERNS="$PATTERNS|$extra"
fi

# CLAUDE.md and this script legitimately describe these patterns; skip them.
files="$(git ls-files 2>/dev/null | grep -vE '^(CLAUDE\.md|scripts/secret-scan\.sh)$' || true)"
if [ -z "$files" ]; then
  files="$(find . -type f -not -path './.git/*' -not -name 'CLAUDE.md' -not -path './scripts/secret-scan.sh' -not -name '.denylist')"
fi

if printf '%s\n' "$files" | xargs grep -IniE "$PATTERNS" 2>/dev/null; then
  echo "secret-scan: potential secret or internal reference found above" >&2
  exit 1
fi

echo "secret-scan: clean"
