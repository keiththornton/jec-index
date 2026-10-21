import path from "node:path";
import { changedFilesSince, coChanges, workingTreeChanges, type CoChange } from "../git.js";
import type { Indexer } from "../indexer.js";
import { findSymbols, loc, symbolById } from "../queries.js";
import { buildTestCommands, nameMappedTests, type TestCommand } from "../tests.js";
import type { SymbolEntry } from "../types.js";

export interface ImpactOptions {
  /** File path, symbol name, Class.method, id (path#Qualified), or "path:Symbol"; comma-separate for several. Omit for uncommitted changes. */
  target?: string;
  /** Git ref: analyze every file changed since it instead of `target`. */
  since?: string;
  maxDepth?: number;
  transitive?: boolean;
}

export interface FileImpact {
  file: string;
  symbol?: SymbolEntry;
  direct: { file: string; isTest: boolean; via: string }[];
  transitive: { file: string; depth: number; isTest: boolean }[];
  dependsOn: string[];
  /** Other reference sites of the symbol inside its own file. */
  internalRefs?: number;
  tests: { file: string; reason: string }[];
  coChanges?: CoChange[];
}

export interface ImpactResult {
  targets: FileImpact[];
  ambiguous?: SymbolEntry[];
  unresolved?: string[];
  tests: string[];
  commands: TestCommand[];
  truncated: boolean;
}

/** File, file+symbol, or an ambiguity to report. */
export function resolveTarget(ix: Indexer, target: string): { file: string; symbol?: SymbolEntry } | { ambiguous: SymbolEntry[] } | undefined {
  const g = ix.graph;
  const t = target.trim().replace(/\\/g, "/");
  const byId = symbolById(ix.index, t);
  if (byId) return { file: byId.file, symbol: byId };
  const m = t.match(/^(.+?\.[a-z]+)[:#]([A-Za-z_$][\w$.]*)$/);
  if (m) {
    const f = ix.resolveFile(m[1]);
    if (f) {
      const last = m[2].includes(".") ? m[2].slice(m[2].lastIndexOf(".") + 1) : m[2];
      const sym = (g.symbolsByName.get(last.toLowerCase()) ?? []).find((s) => s.file === f && (!m[2].includes(".") || s.qualified.toLowerCase().endsWith(m[2].toLowerCase())));
      return { file: f, symbol: sym };
    }
  }
  const asFile = ix.resolveFile(t);
  if (asFile && (/\.[a-z]+$/i.test(t) || t.includes("/") || !g.symbolsByName.has(t.toLowerCase()))) return { file: asFile };
  const matches = findSymbols(ix.index, t, { limit: 12 });
  if (!matches.length) return asFile ? { file: asFile } : undefined;
  const top = matches[0];
  const strong = matches.filter((x) => x.score >= 380);
  if (strong.length === 1) return { file: strong[0].symbol.file, symbol: strong[0].symbol };
  if (strong.length > 1) {
    // same-named definitions: prefer one exported non-method in production code, else ask
    const prod = strong.filter((x) => x.symbol.exported && x.symbol.kind !== "method" && !g.testFiles.has(x.symbol.file));
    if (prod.length === 1) return { file: prod[0].symbol.file, symbol: prod[0].symbol };
    const files = new Set(strong.map((x) => x.symbol.file));
    if (files.size === 1) return { file: strong[0].symbol.file, symbol: strong[0].symbol };
    return { ambiguous: strong.map((x) => x.symbol) };
  }
  if (top.score >= 250) return { file: top.symbol.file, symbol: top.symbol };
  return asFile ? { file: asFile } : undefined;
}

export async function impact(ix: Indexer, opts: ImpactOptions): Promise<ImpactResult> {
  const maxDepth = opts.maxDepth ?? 5;
  const result: ImpactResult = { targets: [], tests: [], commands: [], truncated: false };
  let targets: { file: string; symbol?: SymbolEntry }[] = [];

  if (opts.since) {
    for (const f of await changedFilesSince(ix.root, opts.since)) {
      const r = ix.resolveFile(f);
      if (r) targets.push({ file: r });
      else (result.unresolved ??= []).push(f);
    }
  } else if (!opts.target) {
    for (const c of await workingTreeChanges(ix.root)) {
      const r = ix.resolveFile(c.file);
      if (r) targets.push({ file: r });
    }
  } else {
    for (const raw of opts.target.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
      const r = resolveTarget(ix, raw);
      if (!r) (result.unresolved ??= []).push(raw);
      else if ("ambiguous" in r) (result.ambiguous ??= []).push(...r.ambiguous);
      else targets.push(r);
    }
  }
  const seen = new Set<string>();
  targets = targets.filter((t) => {
    const k = `${t.file}:${t.symbol?.id ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (targets.length > 25) {
    targets = targets.slice(0, 25);
    result.truncated = true;
  }
  const allTests = new Set<string>();
  for (const t of targets) {
    const fi = await impactOne(ix, t.file, t.symbol, maxDepth, opts.transitive ?? true);
    result.targets.push(fi);
    for (const tt of fi.tests) allTests.add(tt.file);
  }
  result.tests = [...allTests].sort();
  result.commands = buildTestCommands(ix.index.config, result.tests);
  return result;
}

async function impactOne(ix: Indexer, file: string, symbol: SymbolEntry | undefined, maxDepth: number, includeTransitive: boolean): Promise<FileImpact> {
  const g = ix.graph;
  const entry = g.entry(file)!;
  const direct: FileImpact["direct"] = [];
  const parentName = symbol?.parent ? symbolById(ix.index, symbol.parent)?.name : undefined;

  for (const dep of g.importers.get(file) ?? []) {
    const depEntry = g.entry(dep);
    if (!depEntry) continue;
    const imps = depEntry.imports.filter((i) => i.resolved === file);
    if (symbol) {
      const refsName = g.refIndex.get(symbol.name.toLowerCase())?.has(dep) ?? false;
      if (parentName) {
        // A method: the dependent must actually reference the method name, and the parent
        // must be in scope (imported or referenced) so same-named methods elsewhere don't count.
        const usesParent = (g.refIndex.get(parentName.toLowerCase())?.has(dep) ?? false) || imps.some((i) => !i.names || i.names.includes(parentName) || i.names.includes("*"));
        if (!refsName || !usesParent) continue;
        direct.push({ file: dep, isTest: g.testFiles.has(dep), via: `calls ${parentName}.${symbol.name}` });
        continue;
      }
      const importsName = imps.some((i) => !i.names || i.names.includes(symbol.name) || i.names.includes("*") || (i.names.includes("default") && symbol.exported));
      if (!importsName && !refsName) continue;
      const via = refsName ? `references ${symbol.name}` : imps.some((i) => i.names?.includes(symbol.name)) ? `imports ${symbol.name}` : `imports the module`;
      direct.push({ file: dep, isTest: g.testFiles.has(dep), via });
    } else {
      const names = imps.flatMap((i) => i.names ?? []).filter((n) => n !== "*" && n !== "default");
      const via = names.length ? `imports ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}` : `imports ${path.posix.basename(file)}`;
      direct.push({ file: dep, isTest: g.testFiles.has(dep), via });
    }
  }
  // Symbol-level: also count files that reference the name without an import edge
  // (dynamic dispatch, same-namespace PHP, globals) — but only when the name is distinctive.
  if (symbol && symbol.name.length >= 5 && (g.symbolsByName.get(symbol.name.toLowerCase())?.length ?? 0) === 1 && !(parentName && entry.lang === "php" && !symbol.exported)) {
    for (const f of g.refIndex.get(symbol.name.toLowerCase()) ?? []) {
      if (f === file || direct.some((d) => d.file === f)) continue;
      direct.push({ file: f, isTest: g.testFiles.has(f), via: `references ${symbol.name} (no import edge)` });
    }
  }
  direct.sort((a, b) => Number(a.isTest) - Number(b.isTest) || g.inDegree(b.file) - g.inDegree(a.file) || a.file.localeCompare(b.file));

  const transitive: FileImpact["transitive"] = [];
  if (includeTransitive && maxDepth > 1) {
    const seen = new Set<string>([file, ...direct.map((d) => d.file)]);
    let frontier = direct.map((d) => d.file);
    for (let depth = 2; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const dep of g.importers.get(f) ?? []) {
          if (seen.has(dep)) continue;
          seen.add(dep);
          transitive.push({ file: dep, depth, isTest: g.testFiles.has(dep) });
          next.push(dep);
        }
      }
      frontier = next;
      if (transitive.length > 500) break;
    }
  }

  const tests = new Map<string, string>();
  for (const d of direct) if (d.isTest) tests.set(d.file, `directly ${d.via}`);
  for (const t of transitive) if (t.isTest) tests.set(t.file, `depends on it (${t.depth} hops)`);
  for (const t of nameMappedTests(file, entry.lang, g.testFiles)) if (!tests.has(t)) tests.set(t, "name matches");
  if (!symbol) {
    for (const d of direct.slice(0, 20)) {
      if (d.isTest) continue;
      const de = g.entry(d.file);
      if (!de) continue;
      for (const t of nameMappedTests(d.file, de.lang, g.testFiles)) if (!tests.has(t)) tests.set(t, `covers dependent ${path.posix.basename(d.file)}`);
    }
  }
  if (entry.isTest) tests.set(file, "is itself a test");

  let internalRefs: number | undefined;
  if (symbol) {
    const selfIdx = entry.symbols.indexOf(symbol);
    internalRefs = entry.refs.filter((r) => r.name === symbol.name && r.in !== selfIdx).length;
  }
  const co = await coChanges(ix.root, file, 200, 6);
  return {
    file,
    symbol,
    direct,
    transitive,
    dependsOn: [...(g.imports.get(file) ?? [])].sort(),
    internalRefs,
    tests: [...tests.entries()].map(([f, reason]) => ({ file: f, reason })),
    coChanges: co.related.length ? co.related : undefined,
  };
}

export function fmtImpact(r: ImpactResult): string {
  const lines: string[] = [];
  if (r.ambiguous?.length) {
    lines.push(`Ambiguous — several definitions match. Re-run with an id, "path/to/file.ext:Name" or "Class.method":`);
    for (const d of r.ambiguous.slice(0, 12)) lines.push(`  ${d.id}  [${loc(d)}]`);
    lines.push("");
  }
  if (r.unresolved?.length) lines.push(`Not found in index: ${r.unresolved.join(", ")}\n`);
  if (!r.targets.length) {
    if (!lines.length) lines.push("Nothing to analyze: no target given and no uncommitted changes.");
    return lines.join("\n");
  }
  for (const t of r.targets) {
    lines.push(t.symbol ? `## ${t.symbol.kind} ${t.symbol.qualified}  [${loc(t.symbol)}]` : `## ${t.file}`);
    if (t.symbol) lines.push(`   ${t.symbol.signature}`);
    if (t.internalRefs) lines.push(`   referenced ${t.internalRefs}× elsewhere in its own file`);
    if (t.direct.length) {
      lines.push(`Direct dependents (${t.direct.length}):`);
      for (const d of t.direct.slice(0, 25)) lines.push(`  ${d.file}${d.isTest ? " [test]" : ""}  — ${d.via}`);
      if (t.direct.length > 25) lines.push(`  … ${t.direct.length - 25} more`);
    } else lines.push(`Direct dependents: none${t.symbol && !t.symbol.exported ? " (private)" : ""}`);
    if (t.transitive.length) {
      const nonTest = t.transitive.filter((x) => !x.isTest);
      const byDepth = new Map<number, string[]>();
      for (const x of nonTest) byDepth.set(x.depth, [...(byDepth.get(x.depth) ?? []), x.file]);
      lines.push(`Transitive dependents (${nonTest.length} more non-test files${t.transitive.length - nonTest.length ? `, ${t.transitive.length - nonTest.length} tests` : ""}):`);
      for (const [depth, files] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`  ${depth} hops: ${files.slice(0, 8).join(", ")}${files.length > 8 ? `, … +${files.length - 8}` : ""}`);
      }
    }
    if (t.dependsOn.length) lines.push(`Depends on: ${t.dependsOn.slice(0, 10).join(", ")}${t.dependsOn.length > 10 ? `, … +${t.dependsOn.length - 10}` : ""}`);
    if (t.coChanges?.length) lines.push(`Often changed together (git): ${t.coChanges.map((c) => `${c.file} (${c.count}×)`).join(", ")}`);
    if (t.tests.length) {
      lines.push("Tests:");
      for (const x of t.tests.slice(0, 15)) lines.push(`  ${x.file}  — ${x.reason}`);
    } else lines.push("Tests: none found — consider adding one.");
    lines.push("");
  }
  if (r.commands.length) {
    lines.push("Run impacted tests:");
    for (const c of r.commands) lines.push(`  ${c.command}`);
  }
  if (r.truncated) lines.push("(target list truncated to 25)");
  return lines.join("\n").trimEnd();
}
