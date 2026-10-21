import path from "node:path";
import type { Indexer } from "./indexer.js";
import type { FileEntry, IndexData, RefEntry, SymbolEntry, SymbolKind } from "./types.js";

export const estTokens = (chars: number) => Math.ceil(chars / 4);

// ---------------------------------------------------------------------------
// Symbol lookup
// ---------------------------------------------------------------------------

export function allSymbols(data: IndexData): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  for (const f of Object.values(data.files)) for (const s of f.symbols) out.push(s);
  return out;
}

function fuzzyScore(needle: string, hay: string): number {
  // Subsequence match; returns 0 if not matched, otherwise a small positive score
  // that favours tight matches.
  let hi = 0;
  let gaps = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const idx = hay.indexOf(needle[ni], hi);
    if (idx < 0) return 0;
    gaps += idx - hi;
    hi = idx + 1;
  }
  return Math.max(1, 20 - gaps);
}

export interface Match {
  symbol: SymbolEntry;
  score: number;
}

export function findSymbols(
  data: IndexData,
  query: string,
  opts: { kind?: SymbolKind; file?: string; limit?: number } = {},
): Match[] {
  const q = query.trim();
  if (!q) return [];
  // `path#qualified` is an exact id lookup.
  if (q.includes("#")) {
    for (const f of Object.values(data.files)) for (const s of f.symbols) if (s.id === q) return [{ symbol: s, score: 1000 }];
  }
  const ql = q.toLowerCase();
  const qLast = ql.includes(".") ? ql.slice(ql.lastIndexOf(".") + 1) : ql;
  const fileFilter = opts.file?.toLowerCase();
  const out: Match[] = [];
  for (const f of Object.values(data.files)) {
    if (fileFilter && !f.path.toLowerCase().includes(fileFilter)) continue;
    for (const s of f.symbols) {
      if (opts.kind && s.kind !== opts.kind) continue;
      const name = s.name.toLowerCase();
      const qual = s.qualified.toLowerCase();
      let score = 0;
      if (qual === ql) score = 500;
      else if (name === ql) score = 400;
      else if (qual.endsWith("." + ql)) score = 380;
      else if (ql.includes(".") && qual.includes(ql)) score = 300;
      else if (name.startsWith(qLast)) score = 250;
      else if (qual.startsWith(ql)) score = 240;
      else if (name.includes(qLast)) score = 180;
      else if (qual.includes(qLast)) score = 150;
      else {
        const fz = fuzzyScore(qLast, name);
        if (fz > 0) score = 40 + fz;
      }
      if (score === 0) continue;
      if (s.exported) score += 5;
      if (s.kind === "class" || s.kind === "interface") score += 2;
      if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./.test(f.path)) score -= 15;
      out.push({ symbol: s, score });
    }
  }
  out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.startLine - b.symbol.startLine);
  return out.slice(0, opts.limit ?? 20);
}

export function symbolById(data: IndexData, id: string): SymbolEntry | undefined {
  const hash = id.indexOf("#");
  if (hash < 0) return undefined;
  const f = data.files[id.slice(0, hash)];
  return f?.symbols.find((s) => s.id === id);
}

export function symbolsNamed(data: IndexData, name: string): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  for (const f of Object.values(data.files)) for (const s of f.symbols) if (s.name === name) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers (compact on purpose: every char here lands in context)
// ---------------------------------------------------------------------------

export function loc(s: SymbolEntry): string {
  return `${s.file}:${s.startLine}-${s.endLine}`;
}

export function fmtSymbol(s: SymbolEntry, withDoc = true): string {
  let line = `${s.kind} ${s.qualified}  [${loc(s)}]\n  ${s.signature}`;
  if (withDoc && s.doc) line += `\n  // ${s.doc}`;
  return line;
}

export function numbered(src: string, startLine: number, endLine: number): string {
  const lines = src.split("\n");
  const width = String(endLine).length;
  const out: string[] = [];
  for (let i = startLine; i <= endLine && i <= lines.length; i++) {
    out.push(`${String(i).padStart(width)}| ${lines[i - 1]}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Callers / callees
// ---------------------------------------------------------------------------

export interface CallerHit {
  file: string;
  line: number;
  kind: RefEntry["kind"];
  enclosing?: SymbolEntry;
  lineText: string;
}

class SourceCache {
  private cache = new Map<string, Promise<string[]>>();
  constructor(private ix: Indexer) {}
  async lines(rel: string): Promise<string[]> {
    let p = this.cache.get(rel);
    if (!p) {
      p = this.ix.readSource(rel).then((s) => s.split("\n")).catch(() => []);
      this.cache.set(rel, p);
    }
    return p;
  }
}

export const isTestPath = (p: string) => /(^|\/)(test|tests|__tests__|spec|specs|fixtures|testing)(\/|$)|\.(test|spec)\.|_test\.|Test\.php$|test_[^/]*\.py$/.test(p);

export async function callersOf(
  ix: Indexer,
  name: string,
  opts: { limit?: number; excludeSymbolId?: string; kinds?: RefEntry["kind"][] } = {},
): Promise<{ hits: CallerHit[]; total: number }> {
  const data = ix.index;
  const cache = new SourceCache(ix);
  const raw: { file: string; ref: RefEntry; enclosing?: SymbolEntry }[] = [];
  for (const f of Object.values(data.files)) {
    for (const r of f.refs) {
      if (r.name !== name) continue;
      if (opts.kinds && !opts.kinds.includes(r.kind)) continue;
      const enclosing = r.in !== undefined ? f.symbols[r.in] : undefined;
      if (opts.excludeSymbolId && enclosing?.id === opts.excludeSymbolId) continue;
      raw.push({ file: f.path, ref: r, enclosing });
    }
  }
  // Collapse multiple references from the same enclosing symbol to one hit (first line).
  const seen = new Set<string>();
  const uniq: typeof raw = [];
  for (const r of raw) {
    const key = r.enclosing?.id ?? `${r.file}:${r.ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  // Production code before tests, then by path and line.
  uniq.sort((a, b) => Number(isTestPath(a.file)) - Number(isTestPath(b.file)) || a.file.localeCompare(b.file) || a.ref.line - b.ref.line);
  const limit = opts.limit ?? 30;
  const hits: CallerHit[] = [];
  for (const r of uniq.slice(0, limit)) {
    const lines = await cache.lines(r.file);
    hits.push({
      file: r.file,
      line: r.ref.line,
      kind: r.ref.kind,
      enclosing: r.enclosing,
      lineText: (lines[r.ref.line - 1] ?? "").trim().slice(0, 160),
    });
  }
  return { hits, total: uniq.length };
}

export function fmtCallers(hits: CallerHit[], total: number): string {
  if (hits.length === 0) return "(no callers found in index)";
  const out: string[] = [];
  for (const h of hits) {
    const where = h.enclosing ? `${h.enclosing.kind} ${h.enclosing.qualified}` : "(top level)";
    const tag = h.kind === "call" ? "" : ` (${h.kind})`;
    out.push(`${h.file}:${h.line}  ${where}${tag}\n    ${h.lineText}`);
  }
  if (total > hits.length) out.push(`… ${total - hits.length} more (raise limit or narrow by name)`);
  return out.join("\n");
}

export interface CalleeSummary {
  name: string;
  kind: RefEntry["kind"];
  count: number;
  resolved: SymbolEntry[];
}

export function calleesOf(data: IndexData, sym: SymbolEntry): CalleeSummary[] {
  const f = data.files[sym.file];
  if (!f) return [];
  // Include refs inside nested symbols (e.g. a class's methods when asked about the class).
  const nestedIds = new Set<string>([sym.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of f.symbols) if (s.parent && nestedIds.has(s.parent) && !nestedIds.has(s.id)) (nestedIds.add(s.id), (grew = true));
  }
  const byName = new Map<string, CalleeSummary>();
  for (const r of f.refs) {
    if (r.in === undefined || !nestedIds.has(f.symbols[r.in].id)) continue;
    const key = `${r.kind}:${r.name}`;
    let c = byName.get(key);
    if (!c) {
      c = { name: r.name, kind: r.kind, count: 0, resolved: [] };
      byName.set(key, c);
    }
    c.count++;
  }
  for (const c of byName.values()) {
    const cands = symbolsNamed(data, c.name).filter((s) => s.id !== sym.id);
    // Prefer same file, then same directory, then production code over tests.
    const dir = path.posix.dirname(sym.file);
    const rank = (s: SymbolEntry) => (s.file === sym.file ? 0 : path.posix.dirname(s.file) === dir ? 1 : isTestPath(s.file) ? 3 : 2);
    cands.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
    c.resolved = cands;
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function fmtCallees(callees: CalleeSummary[], limit = 25): string {
  if (callees.length === 0) return "(no calls recorded)";
  const out: string[] = [];
  const known = callees.filter((c) => c.resolved.length > 0);
  const external = callees.filter((c) => c.resolved.length === 0);
  for (const c of known.slice(0, limit)) {
    const tag = c.kind === "call" ? "" : ` (${c.kind})`;
    if (c.resolved.length === 1) {
      const s = c.resolved[0];
      out.push(`${c.name}${tag} ×${c.count} → ${loc(s)}\n    ${s.signature}`);
    } else {
      const first = c.resolved[0];
      out.push(`${c.name}${tag} ×${c.count} → ${c.resolved.length} candidates, e.g. ${loc(first)}\n    ${first.signature}`);
    }
  }
  if (known.length > limit) out.push(`… ${known.length - limit} more resolved callees`);
  if (external.length) {
    const names = external.slice(0, 40).map((c) => (c.kind === "call" ? c.name : `${c.kind}:${c.name}`));
    out.push(`not in index (library / builtin / dynamic): ${names.join(", ")}${external.length > 40 ? ", …" : ""}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// File outline
// ---------------------------------------------------------------------------

export function fmtOutline(f: FileEntry): string {
  const out: string[] = [];
  const fullTokens = estTokens(f.size);
  out.push(`${f.path}  (${f.lang}, ${f.lines} lines, ~${fullTokens} tokens if read in full)`);
  if (f.imports.length) {
    const specs = [...new Set(f.imports.map((i) => i.spec))];
    out.push(`imports: ${specs.join(", ")}`);
  }
  if (f.symbols.length === 0) {
    out.push("(no top-level symbols)");
  } else {
    const children = new Map<string | undefined, SymbolEntry[]>();
    for (const s of f.symbols) {
      const arr = children.get(s.parent) ?? [];
      arr.push(s);
      children.set(s.parent, arr);
    }
    const emit = (parent: string | undefined, depth: number) => {
      for (const s of children.get(parent) ?? []) {
        const pad = "  ".repeat(depth);
        const exp = s.exported ? "" : " (private)";
        out.push(`${pad}${s.startLine}-${s.endLine} ${s.kind}${exp}: ${s.signature}`);
        if (s.doc) out.push(`${pad}    // ${s.doc}`);
        emit(s.id, depth + 1);
      }
    };
    emit(undefined, 0);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Importers (who imports this file)
// ---------------------------------------------------------------------------

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

function stripExt(p: string): string {
  return p.replace(/\.(d\.)?(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|php)$/i, "");
}

export interface ImporterHit {
  file: string;
  spec: string;
  line: number;
  /** Imported names when known. */
  names?: string[];
  /** True when the edge came from the suffix heuristic rather than structural resolution. */
  heuristic?: boolean;
}

/**
 * Files that import `targetRel`. Structural resolution (tsconfig paths, python
 * roots, PSR-4, declared namespaces) is the source of truth; the older suffix
 * heuristic is only consulted when resolution found nothing, and its hits are
 * marked so callers can present them as guesses.
 */
export function importersOf(ix: Indexer, targetRel: string): ImporterHit[] {
  const data = ix.index;
  const target = targetRel.split(path.sep).join("/");
  const out: ImporterHit[] = [];
  for (const from of ix.graph.importers.get(target) ?? []) {
    const f = data.files[from];
    const imp = f?.imports.find((i) => i.resolved === target);
    if (imp) out.push({ file: from, spec: imp.spec, line: imp.line, names: imp.names });
  }
  if (out.length) return out.sort((a, b) => Number(isTestPath(a.file)) - Number(isTestPath(b.file)) || a.file.localeCompare(b.file));
  return importersHeuristic(data, target).map((h) => ({ ...h, heuristic: true }));
}

function importersHeuristic(data: IndexData, target: string): { file: string; spec: string; line: number }[] {
  const targetNoExt = stripExt(target);
  const targetDirIndex = targetNoExt.replace(/\/index$/, "");
  const targetPyModule = targetNoExt.replace(/\/__init__$/, "").replace(/\//g, ".");
  const targetBase = path.posix.basename(targetNoExt);
  const out: { file: string; spec: string; line: number }[] = [];

  for (const f of Object.values(data.files)) {
    if (f.path === target) continue;
    const fromDir = path.posix.dirname(f.path);
    for (const imp of f.imports) {
      let hit = false;
      if (f.lang === "python") {
        const spec = imp.spec;
        if (spec.startsWith(".")) {
          const dots = spec.match(/^\.+/)![0].length;
          let base = fromDir;
          for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
          const rest = spec.slice(dots).replace(/\./g, "/");
          const resolved = path.posix.normalize(rest ? `${base}/${rest}` : base);
          hit = resolved === targetNoExt || resolved === targetDirIndex || resolved === targetNoExt.replace(/\/__init__$/, "");
        } else {
          hit = spec === targetPyModule || targetPyModule.endsWith("." + spec) || spec.startsWith(targetPyModule + ".");
        }
      } else if (f.lang === "php") {
        const segs = imp.spec.replace(/^\\/, "").split("\\");
        const last = segs[segs.length - 1];
        if (last === targetBase) {
          const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
          const tpath = target.toLowerCase();
          hit = dirs.every((d) => tpath.includes("/" + d + "/") || tpath.startsWith(d + "/"));
        } else if (/\.php$/i.test(imp.spec)) {
          hit = path.posix.normalize(`${fromDir}/${imp.spec}`) === target || imp.spec.endsWith("/" + path.posix.basename(target));
        }
      } else {
        const spec = imp.spec;
        if (spec.startsWith(".") || spec.startsWith("/")) {
          const resolved = stripExt(path.posix.normalize(spec.startsWith("/") ? spec.slice(1) : `${fromDir}/${spec}`));
          hit = resolved === targetNoExt || resolved === targetDirIndex;
          if (!hit) for (const e of JS_EXTS) if (resolved + e === target) hit = true;
        } else {
          const noAlias = stripExt(spec.replace(/^@\/?/, "").replace(/^~\/?/, ""));
          hit = noAlias.length > 2 && (targetNoExt.endsWith("/" + noAlias) || targetNoExt === noAlias || targetDirIndex.endsWith("/" + noAlias));
        }
      }
      if (hit) {
        out.push({ file: f.path, spec: imp.spec, line: imp.line });
        break;
      }
    }
  }
  return out;
}
