import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "U" | "?";
  oldPath?: string;
  /** New-side line ranges touched, 1-based inclusive. Empty for deletions. */
  ranges: [number, number][];
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

function parseHunks(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
      if (count === 0) out.get(current)!.push([start, start]); // pure deletion: point at the seam
      else out.get(current)!.push([start, start + count - 1]);
    }
  }
  return out;
}

/**
 * Files changed between `ref` and the working tree (staged + unstaged + untracked).
 * `ref` may be a commit, branch, or range like `main...HEAD`.
 */
export async function changedSince(root: string, ref: string): Promise<ChangedFile[]> {
  const nameStatus = await git(root, ["diff", "--name-status", "-M", ref, "--"]);
  const files = new Map<string, ChangedFile>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0] as ChangedFile["status"];
    if (code === "R") {
      files.set(parts[2], { path: parts[2], status: "R", oldPath: parts[1], ranges: [] });
    } else {
      files.set(parts[1], { path: parts[1], status: code, ranges: [] });
    }
  }
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  for (const p of untracked.split("\n")) if (p.trim()) files.set(p, { path: p, status: "?", ranges: [] });

  const diff = await git(root, ["diff", "-U0", "-M", ref, "--"]);
  const hunks = parseHunks(diff);
  for (const [p, ranges] of hunks) {
    const f = files.get(p);
    if (f) f.ranges = ranges;
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// History: recent commits, co-change affinity, working tree, hot files
// ---------------------------------------------------------------------------

/** Like `git` but returns "" instead of throwing (missing history, not a repo, bad ref). */
async function gitSafe(root: string, args: string[]): Promise<string> {
  try {
    return await git(root, args);
  } catch {
    return "";
  }
}

export interface Commit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files?: string[];
}

export interface CoChange {
  file: string;
  count: number;
  /** fraction of the target's commits that also touched this file */
  ratio: number;
}

const SEP = '\x1f';
const FORMAT = `%H${SEP}%an${SEP}%aI${SEP}%s`;

function parseLog(out: string, withFiles: boolean): Commit[] {
  const commits: Commit[] = [];
  let current: Commit | undefined;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes(SEP)) {
      const [hash, author, date, subject] = line.split(SEP);
      current = { hash: hash.slice(0, 10), author, date, subject, files: withFiles ? [] : undefined };
      commits.push(current);
    } else if (withFiles && current) {
      current.files!.push(line.trim());
    }
  }
  return commits;
}

export async function recentCommits(root: string, path?: string, limit = 10): Promise<Commit[]> {
  const args = ['log', `-n${limit}`, `--format=${FORMAT}`, '--no-merges'];
  if (path) args.push('--follow', '--', path);
  const out = await gitSafe(root, args);
  return parseLog(out, false);
}

export async function recentCommitsWithFiles(root: string, limit = 50, path?: string): Promise<Commit[]> {
  if (!path) {
    const out = await gitSafe(root, ['log', `-n${limit}`, `--format=${FORMAT}`, '--name-only', '--no-merges']);
    return parseLog(out, true);
  }
  // `git log --name-only -- path` filters the file list to the pathspec, so fetch the commit
  // hashes first and then show each commit's full file list.
  const hashes = (await gitSafe(root, ['log', `-n${limit}`, '--format=%H', '--no-merges', '--', path])).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!hashes.length) return [];
  const out = await gitSafe(root, ['show', '--name-only', `--format=${FORMAT}`, ...hashes]);
  return parseLog(out, true);
}

/** Files that tend to change in the same commits as `path`. */
export async function coChanges(root: string, path: string, lookback = 200, top = 8): Promise<{ commits: number; related: CoChange[] }> {
  // Sweeping commits (reformat-everything, initial import) say nothing about affinity.
  const commits = (await recentCommitsWithFiles(root, lookback, path)).filter((c) => (c.files?.length ?? 0) <= 40);
  const counts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.files ?? []) {
      if (f === path) continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  const related = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([file, count]) => ({ file, count, ratio: commits.length ? count / commits.length : 0 }));
  return { commits: commits.length, related };
}

export interface StatusEntry {
  file: string;
  status: string;
}

/** Uncommitted changes (staged + unstaged + untracked). */
export async function workingTreeChanges(root: string): Promise<StatusEntry[]> {
  const out = await gitSafe(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries: StatusEntry[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.length < 4) continue;
    const status = p.slice(0, 2).trim() || '??';
    let file = p.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) {
      // renamed: "R  new\0old"
      i++;
    }
    entries.push({ file, status });
  }
  return entries;
}

/** Files changed between `ref` and the working tree (e.g. ref = "main", "HEAD~3"). */
export async function changedFilesSince(root: string, ref: string): Promise<string[]> {
  const out = await gitSafe(root, ['diff', '--name-only', ref, '--']);
  const committed = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const wt = (await workingTreeChanges(root)).map((e) => e.file);
  return [...new Set([...committed, ...wt])];
}

/** Most frequently changed files in the last N commits. */
export async function hotFiles(root: string, lookback = 100, top = 10): Promise<{ file: string; count: number }[]> {
  const commits = await recentCommitsWithFiles(root, lookback);
  const counts = new Map<string, number>();
  for (const c of commits) for (const f of c.files ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([file, count]) => ({ file, count }));
}

export async function currentBranch(root: string): Promise<string | undefined> {
  const out = (await gitSafe(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return out || undefined;
}
