import { posix } from 'node:path';
import type { Indexer } from '../indexer.js';
import type { FileEntry } from '../types.js';

export interface ConventionsOptions {
  /** path prefix to scope the analysis, e.g. "src/services" */
  area?: string;
}

interface Tally {
  counts: Map<string, number>;
  examples: Map<string, string[]>;
}

function tally(): Tally {
  return { counts: new Map(), examples: new Map() };
}
function add(t: Tally, key: string, file: string, by = 1): void {
  t.counts.set(key, (t.counts.get(key) ?? 0) + by);
  const ex = t.examples.get(key) ?? [];
  if (ex.length < 3 && !ex.includes(file)) ex.push(file);
  t.examples.set(key, ex);
}
function top(t: Tally, n = 5): { key: string; count: number; examples: string[] }[] {
  return [...t.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count, examples: t.examples.get(key) ?? [] }));
}
function dominant(t: Tally): { key: string; share: number; total: number; examples: string[] } | undefined {
  const total = [...t.counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return undefined;
  const [best] = top(t, 1);
  return { key: best.key, share: best.count / total, total, examples: best.examples };
}

function fileNamingStyle(stem: string): string {
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) return 'kebab-case';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) return 'snake_case';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(stem)) return 'PascalCase';
  if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(stem)) return 'camelCase';
  if (/^[a-z0-9]+$/.test(stem)) return 'lowercase';
  return 'other';
}

export function conventions(ix: Indexer, opts: ConventionsOptions = {}): string {
  const g = ix.graph;
  const area = opts.area?.replace(/^\.\//, '').replace(/\/$/, '');
  const files = g.files.filter((f) => !area || f === area || f.startsWith(area + '/'));
  if (!files.length) return area ? `No indexed files under "${area}".` : 'Index is empty.';
  const entries = files.map((f) => g.entry(f)!);
  const src = entries.filter((e) => !e.isTest);
  const tests = entries.filter((e) => e.isTest);
  const byLang = new Map<string, FileEntry[]>();
  for (const e of entries) byLang.set(e.lang, [...(byLang.get(e.lang) ?? []), e]);

  const out: string[] = [];
  out.push(`# Conventions${area ? ` in ${area}/` : ''}  (${entries.length} files: ${[...byLang.entries()].map(([l, es]) => `${es.length} ${l}`).join(', ')}; ${tests.length} tests)`);

  // --- layout ---
  const dirs = tally();
  for (const f of files) {
    const rel = area ? f.slice(area.length + 1) : f;
    const first = rel.includes('/') ? rel.split('/')[0] : '(root)';
    add(dirs, first, f);
  }
  out.push('', `## Layout (${area ? area + '/' : 'top-level'})`);
  for (const d of top(dirs, 12)) out.push(`  ${d.key}/  ${d.count} ${plural('file', d.count)}`);

  const hubs = files
    .filter((f) => !g.testFiles.has(f))
    .map((f) => ({ f, n: g.inDegree(f) }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);
  if (hubs.length) out.push(`  Most-imported modules: ${hubs.map((h) => `${h.f} (${h.n})`).join(', ')}`);

  // --- tests ---
  out.push('', '## Testing');
  if (!tests.length) out.push('  No test files found.');
  else {
    const fw = tally();
    const loc = tally();
    for (const t of tests) {
      add(fw, t.facts.testFramework ?? `(unknown ${t.lang})`, t.path);
      const colocated = src.some((s) => posix.dirname(s.path) === posix.dirname(t.path));
      const inTestsDir = /(^|\/)(__tests__|tests?|specs?)\//.test(t.path);
      add(loc, inTestsDir ? 'separate tests/ directory' : colocated ? 'co-located with source' : 'other', t.path);
    }
    for (const x of top(fw, 4)) out.push(`  Framework: ${x.key} — ${x.count} ${plural('file', x.count)}, e.g. ${x.examples[0]}`);
    const d = dominant(loc);
    if (d) out.push(`  Location: ${d.key} (${Math.round(d.share * 100)}%), e.g. ${d.examples.slice(0, 2).join(', ')}`);
    const nameStyle = tally();
    for (const t of tests) {
      const b = posix.basename(t.path);
      const style = /\.test\./.test(b) ? '*.test.*' : /\.spec\./.test(b) ? '*.spec.*' : /^test_/.test(b) ? 'test_*.py' : /_test\.py$/.test(b) ? '*_test.py' : /Test\.php$/.test(b) ? '*Test.php' : 'other';
      add(nameStyle, style, t.path);
    }
    const ns = dominant(nameStyle);
    if (ns && ns.key !== 'other') out.push(`  Naming: ${ns.key} (${Math.round(ns.share * 100)}%)`);
    const runners = ix.index.config.runners;
    const r = Object.entries(runners)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (r.length) out.push(`  Runner: ${r.join(', ')}`);
  }

  // --- per language style ---
  for (const [lang, es] of byLang) {
    const srcEs = es.filter((e) => !e.isTest);
    const pool = srcEs.length ? srcEs : es;
    out.push('', `## ${langLabel(lang)} style`);
    const indent = tally();
    const quotes = tally();
    const semis = tally();
    const exportStyle = tally();
    const moduleStyle = tally();
    const naming = tally();
    const throws = tally();
    const loggers = tally();
    let asyncFns = 0;
    let totalFns = 0;
    for (const e of pool) {
      if (e.facts.indent !== 'unknown') add(indent, e.facts.indent === 'tab' ? 'tabs' : e.facts.indent === 'other' ? 'mixed' : `${e.facts.indent} spaces`, e.path);
      if (e.facts.quotes !== 'unknown' && e.facts.quotes !== 'mixed') add(quotes, e.facts.quotes, e.path);
      if (e.facts.semicolons !== undefined) add(semis, e.facts.semicolons ? 'with semicolons' : 'no semicolons', e.path);
      if (e.facts.exportStyle && e.facts.exportStyle !== 'none') add(exportStyle, e.facts.exportStyle, e.path);
      if (e.facts.moduleStyle && e.facts.moduleStyle !== 'none') add(moduleStyle, e.facts.moduleStyle, e.path);
      const stem = posix.basename(e.path).replace(/\.[^.]+$/, '');
      if (stem !== 'index' && stem !== '__init__') add(naming, fileNamingStyle(stem), e.path);
      for (const [k, n] of Object.entries(e.facts.throws)) add(throws, k, e.path, n);
      for (const [k, n] of Object.entries(e.facts.loggers)) add(loggers, k, e.path, n);
      asyncFns += e.facts.asyncFunctions;
      totalFns += e.facts.totalFunctions;
    }
    const line = (label: string, t: Tally) => {
      const d = dominant(t);
      if (!d) return;
      const alt = top(t, 2)[1];
      out.push(`  ${label}: ${d.key} (${Math.round(d.share * 100)}% of ${d.total} files${alt && alt.count / d.total > 0.2 ? `; ${alt.key} ${Math.round((alt.count / d.total) * 100)}%` : ''})`);
    };
    line('Indent', indent);
    line('Quotes', quotes);
    line('Semicolons', semis);
    line('Modules', moduleStyle);
    line('Exports', exportStyle);
    line('File naming', naming);
    if (totalFns) out.push(`  Async: ${Math.round((asyncFns / totalFns) * 100)}% of ${totalFns} functions`);
    const th = top(throws, 6);
    if (th.length) out.push(`  Errors thrown: ${th.map((x) => `${x.key} ×${x.count} (${posix.basename(x.examples[0])})`).join(', ')}`);
    const lg = top(loggers, 4);
    if (lg.length) out.push(`  Logging: ${lg.map((x) => `${x.key} ×${x.count} (${posix.basename(x.examples[0])})`).join(', ')}`);
    // exported symbol kinds
    const kinds = tally();
    for (const e of pool) for (const s of e.symbols) if (s.exported && s.kind !== 'method' && !s.parent) add(kinds, s.kind === 'constant' ? 'const' : s.kind, e.path);
    const kd = top(kinds, 4);
    if (kd.length) out.push(`  Public API shape: ${kd.map((x) => `${x.count} ${plural(x.key, x.count)}`).join(', ')}`);
    // symbol naming
    const symNaming = tally();
    for (const e of pool) for (const s of e.symbols) if (s.kind === 'function') add(symNaming, /_/.test(s.name) ? 'snake_case functions' : /^[a-z]/.test(s.name) ? 'camelCase functions' : 'other', e.path);
    const sn = dominant(symNaming);
    if (sn && sn.total >= 3) out.push(`  Functions: ${sn.key} (${Math.round(sn.share * 100)}%)`);
  }

  out.push('', 'Evidence is from parsed source; check the example files before assuming a rule is intentional.');
  return out.join('\n');
}

function plural(word: string, n: number): string {
  if (n === 1) return word;
  if (word === 'class') return 'classes';
  return word + 's';
}

function langLabel(l: string): string {
  return { typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', python: 'Python', php: 'PHP' }[l] ?? l;
}
