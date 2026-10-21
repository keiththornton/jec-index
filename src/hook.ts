import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Indexer } from './indexer.js';
import { buildTestCommands } from './tests.js';
import { impact } from './tools/impact.js';
import { recordUsage } from './usage.js';

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string; [k: string]: unknown };
  cwd?: string;
}

/** Tools whose only effect is reading; a refresh after them is wasted work. */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

/** Minimum interval between running the same test file again from the hook, to absorb bursts of writes. */
const DEDUPE_WINDOW_MS = Number(process.env.JEC_HOOK_DEDUPE_SECONDS ?? 45) * 1000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean; ms: number }> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
    let output = '';
    const cap = 200_000;
    const onData = (d: Buffer) => {
      if (output.length < cap) output += d.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output, timedOut, ms: Date.now() - t0 });
    });
  });
}

/** Keep the informative tail of a test run: failure blocks and the summary. */
function summarizeFailure(output: string, maxLines = 60): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const markers = /(FAIL|✗|×|Error|AssertionError|Expected|Received|failed|FAILED|Traceback|assert)/;
  const keep: number[] = [];
  lines.forEach((l, i) => {
    if (markers.test(l)) keep.push(i);
  });
  if (!keep.length) return lines.slice(-maxLines).join('\n');
  const set = new Set<number>();
  for (const i of keep) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 4); j++) set.add(j);
  for (let j = Math.max(0, lines.length - 12); j < lines.length; j++) set.add(j);
  const idx = [...set].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -2;
  for (const i of idx) {
    if (i !== prev + 1 && out.length) out.push('  …');
    out.push(lines[i]);
    prev = i;
  }
  return out.slice(-maxLines).join('\n');
}

/** Tests the hook ran recently, so a burst of writes doesn't re-run the same files every time. */
function recentRuns(root: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path.join(root, '.jec-index', 'hook-runs.json'), 'utf8'));
  } catch {
    return {};
  }
}
function saveRecentRuns(root: string, runs: Record<string, number>): void {
  try {
    const dir = path.join(root, '.jec-index');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const k of Object.keys(runs)) if (now - runs[k] > DEDUPE_WINDOW_MS * 4) delete runs[k];
    writeFileSync(path.join(dir, 'hook-runs.json'), JSON.stringify(runs));
  } catch {
    /* best effort */
  }
}

export async function postEditHook(): Promise<number> {
  const earlyRoot = process.env.JEC_INDEX_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  recordUsage(earlyRoot, { kind: 'hook', name: 'post-edit', ms: 0, outcome: 'invoked', detail: `node ${process.version}, cwd ${process.cwd()}` });
  try {
    return await postEditHookInner();
  } catch (err) {
    recordUsage(earlyRoot, { kind: 'hook', name: 'post-edit', ms: 0, outcome: 'crashed', detail: (err as Error).stack ?? String(err) });
    process.stderr.write(`jec-index hook crashed: ${(err as Error).message}\n`);
    return 0;
  }
}

async function postEditHookInner(): Promise<number> {
  if (process.env.JEC_HOOK_DISABLE) return 0;
  let raw = '';
  let input: HookInput = {};
  try {
    raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    recordUsage(process.env.JEC_INDEX_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), { kind: 'hook', name: 'post-edit', ms: 0, outcome: 'skipped', detail: `stdin not JSON: ${raw.slice(0, 120)}` });
    return 0;
  }
  const tool = input.tool_name ?? '';
  if (READ_ONLY_TOOLS.has(tool) || tool.startsWith('mcp__plugin_jec-index')) return 0;

  let root = process.env.JEC_INDEX_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || root;
  } catch {
    /* not a git repo: use as-is */
  }
  const timeoutMs = Number(process.env.JEC_HOOK_TIMEOUT ?? 120) * 1000;
  const maxTests = Number(process.env.JEC_HOOK_MAX_TESTS ?? 12);

  const t0 = Date.now();
  const ix = await Indexer.open(root);
  const coldStart = Object.keys(ix.index.files).length === 0;
  // The refresh is the change detector: whatever the tool did (Edit, Write, a shell command that
  // scaffolded ten files, a formatter), the files whose content changed are the ones it re-parsed.
  const report = await ix.refresh({ minIntervalMs: 0 });
  if (coldStart) {
    // No index existed, so "changed" would be the entire repo. Build it and stay quiet; the next
    // tool call has a baseline to diff against. An explicit file_path is still honoured below.
    report.changedFiles = [];
    recordUsage(ix.root, { kind: 'hook', name: 'post-edit', args: { tool }, ms: Date.now() - t0, outcome: 'cold-start', detail: `indexed ${report.indexed} files` });
  }
  const changed = new Set<string>(report.changedFiles);
  const explicit = input.tool_input?.file_path;
  if (explicit) {
    const rel = ix.resolveFile(explicit);
    if (rel) changed.add(rel);
  }
  // Only source files matter; the index only contains those, so membership is the filter.
  const files = [...changed].filter((f) => ix.index.files[f]);
  // Attribution for the log: a change first noticed on a read/shell tool usually belongs to the
  // Edit/Write just before it (the refresh after that call ran before the write settled).
  const explicitRel = explicit ? ix.resolveFile(explicit) : undefined;
  if (!files.length) {
    if (explicit || report.removedFiles.length) {
      recordUsage(ix.root, { kind: 'hook', name: 'post-edit', args: { tool, file: explicit }, ms: Date.now() - t0, outcome: 'skipped', detail: explicit ? 'not in index' : `removed: ${report.removedFiles.slice(0, 5).join(', ')}` });
    }
    return 0; // nothing indexable changed (e.g. a Bash command that only read, or an edit to a .md)
  }

  // Impact across every changed file; union their tests, keep provenance for the message.
  const r = await impact(ix, { target: files.join(','), maxDepth: 3 });
  const rankOf = (reason: string) => (reason.includes('itself') ? 0 : reason.startsWith('name') || reason.startsWith('directly') ? 1 : reason.startsWith('covers') ? 2 : 3);
  const best = new Map<string, number>();
  for (const t of r.targets) for (const x of t.tests) best.set(x.file, Math.min(best.get(x.file) ?? 9, rankOf(x.reason)));
  const ranked = [...best.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([f]) => f);

  const runs = recentRuns(ix.root);
  const now = Date.now();
  const fresh = ranked.filter((f) => !(runs[f] && now - runs[f] < DEDUPE_WINDOW_MS) || changed.has(f));
  const chosen = fresh.slice(0, maxTests);
  const skipped = ranked.length - chosen.length;
  const deduped = ranked.length - fresh.length;
  const label = files.length === 1 ? files[0] : `${files.length} changed files (${files.slice(0, 3).map((f) => path.posix.basename(f)).join(', ')}${files.length > 3 ? ', …' : ''})`;

  if (!chosen.length) {
    if (ranked.length) {
      // everything relevant ran within the dedupe window
      recordUsage(ix.root, { kind: 'hook', name: 'post-edit', args: { tool, files, deduped }, ms: Date.now() - t0, outcome: 'deduped' });
      return 0;
    }
    const uncovered = r.targets.filter((t) => !t.tests.length && !ix.index.files[t.file]?.isTest).map((t) => t.file);
    recordUsage(ix.root, { kind: 'hook', name: 'post-edit', args: { tool, via: explicitRel ? 'file_path' : 'index-diff', files }, ms: Date.now() - t0, outcome: 'no-tests' });
    // Nudge once per directory within the dedupe window: ten edits to one new feature folder
    // should produce one "no tests here" note, not ten.
    const areas = [...new Set(uncovered.map((f) => path.posix.dirname(f)))];
    const quietKey = (a: string) => `no-tests:${a}`;
    const freshAreas = areas.filter((a) => !(runs[quietKey(a)] && now - runs[quietKey(a)] < DEDUPE_WINDOW_MS * 4));
    if (freshAreas.length) {
      for (const a of freshAreas) runs[quietKey(a)] = now;
      saveRecentRuns(ix.root, runs);
      const what = uncovered.length === 1 ? uncovered[0] : `${uncovered.length} changed files in ${freshAreas.map((a) => a + '/').join(', ')}`;
      emit(`jec-index: no tests cover ${what}. Consider adding some.`);
    }
    return 0;
  }

  const commands = buildTestCommands(ix.index.config, chosen);
  const results: string[] = [];
  let failed = false;
  let failureText = '';
  for (const c of commands) {
    const res = await runShell(c.command, ix.root, timeoutMs);
    const secs = (res.ms / 1000).toFixed(1);
    if (res.timedOut) {
      failed = true;
      failureText += `\n[${c.runner}] timed out after ${secs}s: ${c.command}\n`;
    } else if (res.code !== 0) {
      failed = true;
      failureText += `\n[${c.runner}] exit ${res.code} (${secs}s): ${c.command}\n${summarizeFailure(res.output)}\n`;
    } else {
      results.push(`${c.files.length} ${c.runner} test file${c.files.length > 1 ? 's' : ''} passed in ${secs}s`);
    }
  }
  for (const f of chosen) runs[f] = failed ? 0 : now; // a failure must re-run next time
  saveRecentRuns(ix.root, runs);

  recordUsage(ix.root, { kind: 'hook', name: 'post-edit', args: { tool, via: explicitRel ? 'file_path' : 'index-diff', files, tests: chosen, deduped }, ms: Date.now() - t0, outcome: failed ? 'failed' : 'passed' });
  if (failed) {
    process.stderr.write(
      `jec-index: tests impacted by ${label} FAILED. Fix before moving on.\n` +
        `Impacted tests: ${chosen.join(', ')}${skipped ? ` (+${skipped} not run)` : ''}\n` +
        failureText.trim() +
        '\n',
    );
    return 2;
  }
  const notes: string[] = [];
  if (deduped) notes.push(`${deduped} already passed moments ago`);
  if (skipped - deduped > 0) notes.push(`${skipped - deduped} deeper tests skipped; run \`impact\` for the full list`);
  emit(`jec-index: ${results.join('; ')} for ${label}${notes.length ? ` (${notes.join('; ')})` : ''}.`);
  return 0;
}

function emit(additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }) + '\n');
}
