#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { postEditHook } from "./hook.js";
import { Indexer } from "./indexer.js";
import { createServer } from "./server.js";
import { buildTestCommands } from "./tests.js";
import { conventions } from "./tools/conventions.js";
import { fmtImpact, impact } from "./tools/impact.js";
import { fmtLocate, locate } from "./tools/locate.js";
import { recent } from "./tools/recent.js";

const HELP = `jec-index — MCP symbol + dependency index for coding agents

Usage:
  jec-index [serve] [--root <dir>] [--no-warm]     Run the MCP server over stdio (default)
  jec-index index [--rebuild]                      Build or refresh the index and print stats
  jec-index locate <words...> [--area P] [--limit N]
  jec-index impact [target] [--since REF]
  jec-index conventions [area]
  jec-index recent [path] [--limit N]
  jec-index tests <test-file...>                   Print the runner command(s) for test files
  jec-index hook post-edit                         Claude Code PostToolUse hook (JSON on stdin): runs impacted tests

Options:
  --root <dir>   Project to index. Default: git toplevel of $JEC_INDEX_ROOT, $CLAUDE_PROJECT_DIR, or cwd.
  --no-warm      (serve) Don't build the index at startup; build lazily on the first tool call.
  --json         Machine-readable output where supported.

Hook env: JEC_HOOK_TIMEOUT (seconds per command, default 120), JEC_HOOK_MAX_TESTS (default 12), JEC_HOOK_DISABLE=1
`;

const COMMANDS = new Set(["serve", "index", "locate", "impact", "conventions", "recent", "tests", "hook", "help"]);

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key !== "no-warm" && key !== "rebuild" && key !== "json" && key !== "help" && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else if (a === "-h") flags.help = true;
    else positional.push(a);
  }
  const cmd = positional.length && COMMANDS.has(positional[0]) ? positional.shift()! : "serve";
  return { cmd, positional, flags };
}

/** Explicit --root is used verbatim; anything else widens to its git toplevel so a subdirectory cwd still indexes the whole repo. */
function findRoot(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit);
  const start = path.resolve(process.env.JEC_INDEX_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || start;
  } catch {
    return start;
  }
}

async function openFresh(root: string): Promise<Indexer> {
  const ix = await Indexer.open(root);
  await ix.refresh({ minIntervalMs: 0 });
  return ix;
}

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const root = findRoot(typeof flags.root === "string" ? flags.root : undefined);

  switch (cmd) {
    case "serve": {
      const { server, indexer } = await createServer({ root });
      const transport = new StdioServerTransport();
      await server.connect(transport);
      if (!flags["no-warm"]) {
        // Build in the background so the client gets the handshake immediately.
        indexer.refresh({ minIntervalMs: 0 }).then(
          (r) => process.stderr.write(`[jec-index] ${indexer.root}: ${r.indexed} files indexed (${r.reparsed} parsed, ${r.ms} ms)\n`),
          (err) => process.stderr.write(`[jec-index] initial index failed: ${(err as Error).message}\n`),
        );
      }
      return -1; // keep running
    }
    case "index": {
      const ix = await Indexer.open(root);
      const r = await ix.refresh({ force: Boolean(flags.rebuild), minIntervalMs: 0 });
      let symbols = 0;
      let refs = 0;
      let edges = 0;
      const langs: Record<string, number> = {};
      for (const f of Object.values(ix.index.files)) {
        symbols += f.symbols.length;
        refs += f.refs.length;
        langs[f.lang] = (langs[f.lang] ?? 0) + 1;
      }
      for (const s of ix.graph.imports.values()) edges += s.size;
      if (flags.json) process.stdout.write(JSON.stringify({ root: ix.root, files: r.indexed, symbols, refs, edges, tests: ix.graph.testFiles.size, langs, config: ix.index.config, refresh: r }, null, 2) + "\n");
      else
        process.stdout.write(
          `${ix.root}\n${r.indexed} files (${Object.entries(langs).map(([l, n]) => `${l}=${n}`).join(" ")}), ${symbols} symbols, ${refs} references, ${edges} import edges, ${ix.graph.testFiles.size} test files\n` +
            `refresh: parsed ${r.reparsed}, removed ${r.removed}, unchanged ${r.skipped}, ${r.ms} ms${r.errors.length ? `, ${r.errors.length} errors` : ""}\n` +
            `runners: ${JSON.stringify(ix.index.config.runners)}\n`,
        );
      return 0;
    }
    case "locate": {
      const query = positional.join(" ");
      if (!query) {
        process.stderr.write("usage: jec-index locate <words...>\n");
        return 1;
      }
      const ix = await openFresh(root);
      const r = locate(ix, { query, area: typeof flags.area === "string" ? flags.area : undefined, limit: flags.limit ? Number(flags.limit) : undefined });
      process.stdout.write((flags.json ? JSON.stringify(r, null, 2) : fmtLocate(r)) + "\n");
      return 0;
    }
    case "impact": {
      const ix = await openFresh(root);
      const r = await impact(ix, { target: positional.join(",") || undefined, since: typeof flags.since === "string" ? flags.since : undefined });
      process.stdout.write((flags.json ? JSON.stringify(r, null, 2) : fmtImpact(r)) + "\n");
      return 0;
    }
    case "conventions": {
      const ix = await openFresh(root);
      process.stdout.write(conventions(ix, { area: positional[0] }) + "\n");
      return 0;
    }
    case "recent": {
      const ix = await openFresh(root);
      process.stdout.write((await recent(ix, { path: positional[0], limit: flags.limit ? Number(flags.limit) : undefined })) + "\n");
      return 0;
    }
    case "tests": {
      const ix = await openFresh(root);
      const files = positional.map((p) => ix.resolveFile(p) ?? p);
      for (const c of buildTestCommands(ix.index.config, files)) process.stdout.write(c.command + "\n");
      return 0;
    }
    case "hook": {
      if (positional[0] !== "post-edit") {
        process.stderr.write("usage: jec-index hook post-edit\n");
        return 1;
      }
      return postEditHook();
    }
    default:
      process.stderr.write(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`[jec-index] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
