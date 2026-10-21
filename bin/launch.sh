#!/usr/bin/env bash
# MCP server entry point used by the Claude Code plugin (.mcp.json). Installs/builds on first run.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$root/bin/ensure-ready.sh"
exec "$NODE" "$root/dist/index.js" "$@"
