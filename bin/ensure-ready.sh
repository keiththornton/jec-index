#!/usr/bin/env bash
# Sourced by bin/launch.sh and the hook. Finds node (hooks can run with a minimal PATH)
# and, on first run after a plugin install or update, runs `npm ci` inside the plugin
# folder (which also builds dist/ through the package's prepare script). Sets $NODE.
# Requires $root to be set to the package root by the caller.
set -u
NAME="jec-index"
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.fnm/aliases/default/bin/node" \
           "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME"/.nvm/versions/node/*/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "$NAME: node not found on PATH or in common install locations (Node 20+ required)" >&2
  exit 1
fi

if [ ! -f "$root/dist/index.js" ] || [ ! -d "$root/node_modules/@modelcontextprotocol/sdk" ]; then
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="$(command -v npm 2>/dev/null || true)"
  if [ -z "$NPM" ]; then echo "$NAME: npm not found next to $NODE" >&2; exit 1; fi
  lock="$root/.install.lock"
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    echo "$NAME: first run - installing dependencies and building (one-time, ~30s)..." >&2
    if ! (cd "$root" && "$NPM" ci --no-audit --no-fund --loglevel=error >&2); then
      echo "$NAME: npm ci failed in $root" >&2
      exit 1
    fi
    rmdir "$lock" 2>/dev/null; trap - EXIT
  else
    # Another process (e.g. the hook and the server starting together) is installing; wait for it.
    for _ in $(seq 1 180); do [ -d "$lock" ] || break; sleep 1; done
  fi
  if [ ! -f "$root/dist/index.js" ]; then echo "$NAME: dist/index.js still missing after install" >&2; exit 1; fi
fi
