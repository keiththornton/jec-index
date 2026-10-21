import { execFileSync } from "node:child_process";
import { Indexer } from "./indexer.js";
import { recordUsage } from "./usage.js";

interface SessionInput {
  hook_event_name?: string;
  source?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const LANG_LABEL: Record<string, string> = { typescript: "TypeScript", tsx: "TSX", javascript: "JavaScript", python: "Python", php: "PHP" };

/**
 * SessionStart hook: prints the guidance that would otherwise have to live in every project's
 * CLAUDE.md. Claude Code adds plain stdout from SessionStart hooks to the conversation context,
 * so this runs on startup, resume, /clear and after compaction. The text is built from the
 * index so it states what jec-index actually knows about *this* repo.
 */
export async function sessionStartHook(): Promise<number> {
  if (process.env.JEC_SESSION_DISABLE) return 0;
  let input: SessionInput = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    /* fall through with defaults */
  }
  let root = process.env.JEC_INDEX_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || root;
  } catch {
    /* not a git repo */
  }

  const t0 = Date.now();
  const ix = await Indexer.open(root);
  const report = await ix.refresh({ minIntervalMs: 0 });
  const files = Object.values(ix.index.files);
  if (!files.length) {
    recordUsage(ix.root, { kind: "hook", name: "session-start", args: { source: input.source }, ms: Date.now() - t0, outcome: "empty" });
    return 0; // nothing indexable here; say nothing
  }

  const langs = new Map<string, number>();
  for (const f of files) langs.set(f.lang, (langs.get(f.lang) ?? 0) + 1);
  const langList = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${n} ${LANG_LABEL[l] ?? l}`)
    .join(", ");
  const tests = ix.graph.testFiles.size;
  const runners = Object.entries(ix.index.config.runners)
    .filter(([, v]) => v)
    .map(([, v]) => v)
    .join(", ");
  let symbols = 0;
  for (const f of files) symbols += f.symbols.length;

  const lines = [
    `[jec-index] This repository is indexed: ${files.length} source files (${langList}), ${symbols} symbols, ${tests} test files${runners ? `, test runner${runners.includes(",") ? "s" : ""}: ${runners}` : ""}. The index refreshes itself on every tool call.`,
    `Use the jec-index tools instead of grep or whole-file reads:`,
    `- Unknown location, known concept → locate ("billing charge", "user repository"). Known name → find_symbol, then get_symbol to read exactly one definition with its callers and callees.`,
    `- Deciding what to read in a file → file_outline, then a ranged Read of only the lines you need.`,
    `- BEFORE editing anything imported elsewhere → impact: who depends on it, which tests cover it, and the exact test command. Run those tests, not the whole suite.`,
    `- Before writing new code in an unfamiliar directory → conventions <dir>, and follow what it reports.`,
    `- Resuming work or reviewing a branch → changed_since / recent.`,
    tests
      ? `After each edit, a hook runs only the tests that cover the changed files and reports the result inline. Treat a hook failure as something to fix before moving on; "no tests cover X" is a prompt to add one.`
      : `No test files were found in this repository, so the post-edit hook has nothing to run; when you add tests, it will start running the ones that cover each edit.`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  recordUsage(ix.root, { kind: "hook", name: "session-start", args: { source: input.source }, ms: Date.now() - t0, outcome: "ok", detail: `${files.length} files, refreshed ${report.reparsed}` });
  return 0;
}
