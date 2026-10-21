#!/usr/bin/env bash
# Claude Code SessionStart hook entry point. Prints jec-index usage guidance for this repository
# to stdout, which Claude Code injects into the session context (startup, resume, /clear, compact).
# This is what makes per-project CLAUDE.md edits unnecessary.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
if ! . "$root/bin/ensure-ready.sh" 2>/dev/null; then
  exit 0   # node missing or install failed: stay silent rather than break session start
fi
exec "$NODE" "$root/dist/index.js" hook session-start
