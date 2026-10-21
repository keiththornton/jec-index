#!/usr/bin/env bash
# Claude Code PostToolUse hook entry point. Logs from the shell before anything else can fail,
# makes sure the package is installed and built (first run after a plugin install), locates
# node even when the hook environment has a minimal PATH, then execs the real hook.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
project="${JEC_INDEX_ROOT:-${CLAUDE_PROJECT_DIR:-$PWD}}"
log="$project/.jec-index/usage.log"
mkdir -p "$project/.jec-index" 2>/dev/null || true
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"ts":"%s","kind":"hook","name":"post-edit","ms":0,"outcome":"shell-start","detail":"cwd=%s PATH=%s"}\n' "$ts" "$PWD" "$(printf '%s' "$PATH" | tr -d '"\\')" >> "$log" 2>/dev/null || true

if ! . "$root/bin/ensure-ready.sh"; then
  printf '{"ts":"%s","kind":"hook","name":"post-edit","ms":0,"outcome":"crashed","detail":"ensure-ready failed (node missing or npm ci failed)"}\n' "$ts" >> "$log" 2>/dev/null || true
  exit 0
fi
exec "$NODE" "$root/dist/index.js" hook post-edit
