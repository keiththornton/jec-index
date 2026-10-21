import { coChanges, currentBranch, hotFiles, recentCommits, recentCommitsWithFiles, workingTreeChanges } from '../git.js';
import { isGitRepo } from '../git.js';
import type { Indexer } from '../indexer.js';

export interface RecentOptions {
  /** file or directory; omit for the whole repo */
  path?: string;
  limit?: number;
}

export async function recent(ix: Indexer, opts: RecentOptions = {}): Promise<string> {
  if (!(await isGitRepo(ix.root))) return 'Not a git repository — no history available.';
  const limit = opts.limit ?? 10;
  const out: string[] = [];
  const branch = await currentBranch(ix.root);

  let path = opts.path?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (path) {
    const file = ix.resolveFile(path);
    if (file) path = file;
  }

  const wt = await workingTreeChanges(ix.root);
  const wtScoped = path ? wt.filter((e) => e.file === path || e.file.startsWith(path + '/')) : wt;

  out.push(`# Recent activity${path ? ` for ${path}` : ''}${branch ? `  (branch: ${branch})` : ''}`);
  if (wtScoped.length) {
    out.push('', `## Uncommitted (${wtScoped.length})`);
    for (const e of wtScoped.slice(0, 20)) out.push(`  ${e.status.padEnd(2)} ${e.file}`);
    if (wtScoped.length > 20) out.push(`  … ${wtScoped.length - 20} more`);
  } else out.push('', 'Working tree clean' + (path ? ' for this path' : '') + '.');

  if (path) {
    const commits = await recentCommitsWithFiles(ix.root, limit, path);
    out.push('', `## Last ${commits.length} commits touching it`);
    if (!commits.length) out.push('  (no history — new or untracked)');
    for (const c of commits) {
      const others = (c.files ?? []).filter((f) => f !== path && !f.startsWith(path + '/'));
      out.push(`  ${c.hash}  ${c.date.slice(0, 10)}  ${c.author}: ${c.subject}${others.length ? `  (+${others.length} other file${others.length > 1 ? 's' : ''})` : ''}`);
    }
    const isFile = Boolean(ix.graph.entry(path));
    if (isFile) {
      const co = await coChanges(ix.root, path, 200, 8);
      if (co.related.length) {
        out.push('', `## Usually changed alongside (last ${co.commits} commits)`);
        for (const r of co.related) out.push(`  ${r.file}  ${r.count}× (${Math.round(r.ratio * 100)}%)`);
      }
    }
  } else {
    const commits = await recentCommits(ix.root, undefined, limit);
    out.push('', `## Last ${commits.length} commits`);
    for (const c of commits) out.push(`  ${c.hash}  ${c.date.slice(0, 10)}  ${c.author}: ${c.subject}`);
    const hot = await hotFiles(ix.root, 100, 10);
    if (hot.length) {
      out.push('', '## Hot files (most commits in last 100)');
      for (const h of hot) out.push(`  ${h.file}  ${h.count}×`);
    }
  }
  return out.join('\n');
}
