import path from "node:path";
import type { Indexer } from "../indexer.js";
import { loc } from "../queries.js";
import type { SymbolEntry, SymbolKind } from "../types.js";

export interface LocateOptions {
  query: string;
  limit?: number;
  kind?: SymbolKind | "file";
  includeTests?: boolean;
  /** Restrict to this path prefix. */
  area?: string;
}

export interface LocateHit {
  file: string;
  score: number;
  reasons: string[];
  symbols: SymbolEntry[];
  inDegree: number;
  isTest: boolean;
}

export interface LocateResult {
  query: string;
  tokens: string[];
  hits: LocateHit[];
  /** Exact / near-exact symbol definitions. */
  definitions: SymbolEntry[];
}

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

const STOP = new Set(["the", "where", "is", "are", "of", "in", "for", "to", "and", "or", "a", "an", "how", "does", "do", "what", "which", "that", "this", "code", "logic", "file", "files", "function", "class", "with", "from", "into"]);

/**
 * Concept search: "billing charge", "user repository", "belongsTo relation".
 * Scores symbol names, file paths, and the names each file references, then
 * boosts files that many others import. For exact names, find_symbol is sharper.
 */
export function locate(ix: Indexer, opts: LocateOptions): LocateResult {
  const g = ix.graph;
  const limit = opts.limit ?? 8;
  const rawTokens = tokenize(opts.query);
  const tokens = rawTokens.filter((t) => !STOP.has(t));
  const q = tokens.length ? tokens : rawTokens;
  const compact = opts.query.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const wantsTests = opts.includeTests ?? /\b(test|spec)s?\b/i.test(opts.query);
  const area = opts.area?.replace(/^\.\//, "").replace(/\/$/, "");
  const inArea = (f: string) => !area || f === area || f.startsWith(area + "/");

  const perFile = new Map<string, LocateHit>();
  const hit = (file: string): LocateHit => {
    let h = perFile.get(file);
    if (!h) {
      h = { file, score: 0, reasons: [], symbols: [], inDegree: g.inDegree(file), isTest: g.testFiles.has(file) };
      perFile.set(file, h);
    }
    return h;
  };
  const definitions: SymbolEntry[] = [];

  // --- symbols ---
  for (const [lname, defs] of g.symbolsByName) {
    const nameTokens = tokenize(lname);
    let s = 0;
    let why = "";
    if (lname === compact || lname === q.join("")) {
      s = 100;
      why = "exact name";
    } else if (lname === q.join("_") || nameTokens.join("") === q.join("")) {
      s = 90;
      why = "name matches";
    } else if (q.length && q.every((t) => nameTokens.includes(t))) {
      s = 70;
      why = "name contains all terms";
    } else if (q.length && q.every((t) => lname.includes(t))) {
      s = 55;
      why = "name contains terms";
    } else if (q.length > 1 && q.includes(lname)) {
      s = 48;
      why = `name equals term "${lname}"`;
    } else if (q.length > 1) {
      const overlap = q.filter((t) => nameTokens.includes(t) || lname.includes(t)).length;
      if (overlap >= Math.ceil(q.length / 2)) {
        s = 25 * (overlap / q.length);
        why = `name matches ${overlap}/${q.length} terms`;
      }
    } else if (q.length === 1 && lname.includes(q[0]) && q[0].length >= 4) {
      s = 40;
      why = "name contains term";
    }
    if (s <= 0) continue;
    for (const d of defs) {
      if (opts.kind && opts.kind !== "file" && d.kind !== opts.kind) continue;
      if (!inArea(d.file)) continue;
      const h = hit(d.file);
      let ds = s;
      if (d.exported) ds += 5;
      if (d.kind === "method") ds -= 8;
      if (d.kind === "variable") ds -= 10;
      if (g.testFiles.has(d.file) && !wantsTests) ds *= 0.4;
      h.symbols.push(d);
      if (ds > h.score) h.score = ds;
      if (s >= 55) h.reasons.push(`${d.kind} ${d.qualified} (${why}) L${d.startLine}`);
      if (s >= 90) definitions.push(d);
    }
  }

  // --- file paths ---
  if (!opts.kind || opts.kind === "file") {
    for (const f of g.files) {
      if (!inArea(f)) continue;
      const stem = path.posix.basename(f).replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "");
      const stemTokens = tokenize(stem);
      const pathTokens = tokenize(f.replace(/\.[^.]+$/, ""));
      const stemCompact = stemTokens.join("");
      let s = 0;
      let why = "";
      if (stemCompact === compact || stemCompact === q.join("")) {
        s = 85;
        why = "file name matches";
      } else if (q.length && q.every((t) => stemTokens.includes(t))) {
        s = 65;
        why = "file name contains all terms";
      } else if (q.length && q.every((t) => pathTokens.includes(t))) {
        s = 45;
        why = "path contains all terms";
      } else if (q.length > 1 && q.includes(stemCompact)) {
        s = 42;
        why = `file name equals term "${stemCompact}"`;
      } else if (q.length > 1) {
        const overlap = q.filter((t) => pathTokens.includes(t)).length;
        if (overlap >= Math.ceil(q.length / 2)) {
          s = 20 * (overlap / q.length);
          why = `path matches ${overlap}/${q.length} terms`;
        }
      } else if (q.length === 1 && stemTokens.some((t) => t.includes(q[0])) && q[0].length >= 4) {
        s = 35;
        why = "file name contains term";
      }
      if (s <= 0) continue;
      if (g.testFiles.has(f) && !wantsTests) s *= 0.4;
      const h = hit(f);
      h.score = Math.max(h.score, s) + (h.score > 0 ? Math.min(s, 15) : 0);
      if (s >= 35) h.reasons.push(why);
    }
  }

  // --- referenced names (calls, new, extends) ---
  if (q.length && (!opts.kind || opts.kind === "file")) {
    const sets = q.map((t) => g.refIndex.get(t));
    if (sets.every(Boolean)) {
      const [first, ...rest] = sets as Set<string>[];
      for (const f of first) {
        if (!rest.every((s) => s.has(f)) || !inArea(f)) continue;
        const h = hit(f);
        if (h.reasons.length === 0) {
          h.score += 18;
          h.reasons.push(`references ${q.join(", ")}`);
        } else h.score += 6;
      }
    } else if (q.length > 1) {
      const counts = new Map<string, number>();
      for (const s of sets) if (s) for (const f of s) counts.set(f, (counts.get(f) ?? 0) + 1);
      for (const [f, n] of counts) {
        if (n < Math.ceil(q.length * 0.6) || !inArea(f)) continue;
        const h = hit(f);
        if (h.reasons.length === 0) {
          h.score += 10 * (n / q.length);
          h.reasons.push(`references ${n}/${q.length} terms`);
        }
      }
    }
  }

  for (const h of perFile.values()) {
    h.score += Math.min(12, Math.log2(1 + h.inDegree) * 3);
    if (h.isTest && !wantsTests) h.score *= 0.6;
    h.symbols.sort((a, b) => a.startLine - b.startLine);
  }

  const hits = [...perFile.values()]
    .filter((h) => h.score >= 15)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
  const seen = new Set<string>();
  const defs = definitions.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))).slice(0, 10);
  return { query: opts.query, tokens: q, hits, definitions: defs };
}

export function fmtLocate(r: LocateResult): string {
  if (!r.hits.length) return `No matches for "${r.query}" (terms: ${r.tokens.join(", ") || "none"}). Try a symbol name (find_symbol), a file stem, or 2-3 distinctive words.`;
  const lines: string[] = [];
  if (r.definitions.length) {
    lines.push("Definitions:");
    for (const d of r.definitions) lines.push(`  ${d.kind} ${d.qualified}  [${loc(d)}]${d.exported ? "" : " (private)"}\n    ${d.signature}`);
    lines.push("");
  }
  lines.push("Files (best first):");
  for (const h of r.hits) {
    const tag = h.isTest ? " [test]" : "";
    const deps = h.inDegree ? `, imported by ${h.inDegree}` : "";
    lines.push(`  ${h.file}${tag}  (score ${Math.round(h.score)}${deps})`);
    const why = h.reasons.slice(0, 3);
    if (why.length) lines.push(`    why: ${why.join("; ")}`);
    const syms = h.symbols.filter((s) => s.kind !== "variable").slice(0, 4);
    if (syms.length && !why.some((w) => / L\d+$/.test(w))) lines.push(`    has: ${syms.map((s) => `${s.kind} ${s.name} L${s.startLine}`).join(", ")}`);
  }
  lines.push("", "Next: get_symbol or file_outline on the top hit, then a ranged Read.");
  return lines.join("\n");
}
