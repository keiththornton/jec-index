import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { changedSince, isGitRepo } from "./git.js";
import { Indexer } from "./indexer.js";
import {
  allSymbols,
  calleesOf,
  callersOf,
  estTokens,
  findSymbols,
  fmtCallees,
  fmtCallers,
  fmtOutline,
  fmtSymbol,
  importersOf,
  loc,
  numbered,
  symbolById,
} from "./queries.js";
import { conventions } from "./tools/conventions.js";
import { fmtImpact, impact } from "./tools/impact.js";
import { fmtLocate, locate } from "./tools/locate.js";
import { recent } from "./tools/recent.js";
import type { SymbolEntry, SymbolKind } from "./types.js";
import { recordUsage } from "./usage.js";

const KINDS = ["function", "method", "class", "interface", "type", "enum", "trait", "variable", "constant"] as const;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

export interface ServerOptions {
  root: string;
}

export async function createServer(opts: ServerOptions): Promise<{ server: McpServer; indexer: Indexer }> {
  const indexer = await Indexer.open(opts.root);
  const server = new McpServer(
    { name: "jec-index", version: "0.1.0" },
    {
      instructions: [
        "jec-index keeps a persistent symbol + dependency index of this repository (TypeScript/JavaScript, Python, PHP) built from tree-sitter parses and git.",
        "Prefer these tools over reading whole files or grepping:",
        "- locate when you only have a concept or a few words; find_symbol when you know (part of) a name;",
        "- get_symbol to read exactly one definition with its callers and callees; file_outline before deciding what to read;",
        "- impact BEFORE editing anything shared: dependents, co-changing files, and the exact tests to run;",
        "- conventions before writing new code in an unfamiliar directory;",
        "- callers / importers for who-uses-what; recent and changed_since for history and re-orienting.",
        "Every result shows file:startLine-endLine, so follow up with a ranged Read when you need more.",
        "The index refreshes automatically; call index_status with rebuild=true only if results look stale.",
      ].join("\n"),
    },
  );

  // Every tool call is recorded to .jec-index/usage.log (name, args, duration, result size)
  // so adoption and value can be measured after the fact.
  const rawRegister = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, cfg: any, handler: (...a: any[]) => any) =>
    rawRegister(name, cfg, async (...a: any[]) => {
      const t0 = Date.now();
      try {
        const res = await handler(...a);
        const chars = Array.isArray(res?.content) ? res.content.reduce((n: number, c: any) => n + (c.text?.length ?? 0), 0) : 0;
        recordUsage(indexer.root, { kind: "tool", name, args: a[0], ms: Date.now() - t0, chars, outcome: res?.isError ? "error" : "ok" });
        return res;
      } catch (err) {
        recordUsage(indexer.root, { kind: "tool", name, args: a[0], ms: Date.now() - t0, outcome: "threw", detail: (err as Error).message });
        throw err;
      }
    });

  // Resolve a `query` (name, Class.method, or id) to a single symbol, or return an error listing candidates.
  async function resolveOne(query: string, kind?: SymbolKind, file?: string): Promise<SymbolEntry | { error: string }> {
    await indexer.refresh();
    const data = indexer.index;
    const byId = symbolById(data, query);
    if (byId) return byId;
    const matches = findSymbols(data, query, { kind, file, limit: 8 });
    if (matches.length === 0) return { error: `No symbol matches "${query}". Try find_symbol with a shorter or fuzzier query.` };
    const top = matches[0];
    const ties = matches.filter((m) => m.score === top.score);
    if (ties.length > 1 && top.score < 500) {
      const list = ties.map((m) => `  ${m.symbol.id}\n    ${m.symbol.signature}`).join("\n");
      return { error: `"${query}" is ambiguous; pass one of these ids as the query:\n${list}` };
    }
    return top.symbol;
  }

  server.registerTool(
    "index_status",
    {
      title: "Index status / rebuild",
      description:
        "Report what is indexed (files, symbols, languages) and refresh the index. Pass rebuild=true to force a full re-parse. Cheap to call.",
      inputSchema: { rebuild: z.boolean().optional().describe("Force a full re-parse of every file") },
    },
    async ({ rebuild }) => {
      const r = await indexer.refresh({ force: !!rebuild, minIntervalMs: 0 });
      const data = indexer.index;
      const files = Object.values(data.files);
      const byLang = new Map<string, number>();
      let symbols = 0;
      let refs = 0;
      let bytes = 0;
      for (const f of files) {
        byLang.set(f.lang, (byLang.get(f.lang) ?? 0) + 1);
        symbols += f.symbols.length;
        refs += f.refs.length;
        bytes += f.size;
      }
      const langs = [...byLang.entries()].map(([l, n]) => `${l}=${n}`).join(", ");
      let edges = 0;
      for (const s of indexer.graph.imports.values()) edges += s.size;
      const c = data.config;
      const runners = Object.entries(c.runners).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ");
      const lines = [
        `root: ${indexer.root}`,
        `files: ${files.length} (${langs || "none"})   symbols: ${symbols}   references: ${refs}   import edges: ${edges}   tests: ${indexer.graph.testFiles.size}`,
        `runners: ${runners || "none detected"}${c.packageManager ? `, package manager: ${c.packageManager}` : ""}${c.tsPaths ? `; tsconfig paths: ${Object.keys(c.tsPaths).join(", ")}` : ""}${Object.keys(c.psr4).length ? `; psr-4: ${Object.keys(c.psr4).join(", ")}` : ""}`,
        `source size: ~${estTokens(bytes)} tokens total if every file were read in full`,
        `refresh: scanned ${r.scanned}, re-parsed ${r.reparsed}, removed ${r.removed}, unchanged ${r.skipped}, ${r.ms} ms`,
      ];
      if (r.errors.length) lines.push(`errors (${r.errors.length}):\n  ${r.errors.slice(0, 10).join("\n  ")}`);
      if (files.length === 0) lines.push("Nothing indexed. Check that the server's root is the project directory (see --root).");
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbols by name",
      description:
        "Locate functions, classes, methods, interfaces, types, enums, constants by name. Query can be a bare name (findUser), a qualified name (UserService.findById), or a fuzzy fragment. Returns kind, location and signature only — no bodies.",
      inputSchema: {
        query: z.string().describe("Name or fragment to search for"),
        kind: z.enum(KINDS).optional().describe("Restrict to one symbol kind"),
        file: z.string().optional().describe("Substring of a file path to restrict results to"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, kind, file, limit }) => {
      await indexer.refresh();
      const matches = findSymbols(indexer.index, query, { kind, file, limit: limit ?? 20 });
      if (matches.length === 0) return text(`No symbols match "${query}".`);
      const out = matches.map((m) => fmtSymbol(m.symbol));
      return text(`${matches.length} match(es) for "${query}":\n\n${out.join("\n\n")}`);
    },
  );

  server.registerTool(
    "get_symbol",
    {
      title: "Get one symbol's source + callers + callees",
      description:
        "Return exactly one definition's source (numbered lines), plus who calls it (callers, with the enclosing function and the calling line) and what it calls (callees resolved to signatures where known). This is the slice to use instead of reading the whole file. Query accepts a name, Class.method, or an id from find_symbol.",
      inputSchema: {
        query: z.string().describe("Symbol name, qualified name, or id (path#Qualified.name)"),
        kind: z.enum(KINDS).optional(),
        file: z.string().optional().describe("Substring of a file path to disambiguate"),
        callers: z.boolean().optional().describe("Include callers (default true)"),
        callees: z.boolean().optional().describe("Include callees (default true)"),
        context: z.number().int().min(0).max(50).optional().describe("Extra lines of surrounding context above and below the body (default 0)"),
        max_body_lines: z.number().int().min(10).max(2000).optional().describe("Truncate bodies longer than this (default 300)"),
      },
    },
    async ({ query, kind, file, callers, callees, context, max_body_lines }) => {
      const r = await resolveOne(query, kind, file);
      if ("error" in r) return fail(r.error);
      const sym = r;
      const data = indexer.index;
      const src = await indexer.readSource(sym.file);
      const totalLines = data.files[sym.file]?.lines ?? src.split("\n").length;
      const ctx = context ?? 0;
      const maxBody = max_body_lines ?? 300;
      let start = Math.max(1, sym.startLine - ctx);
      let end = Math.min(totalLines, sym.endLine + ctx);
      let truncated = "";
      if (end - start + 1 > maxBody) {
        end = start + maxBody - 1;
        truncated = `\n… body truncated at ${maxBody} lines (ends at ${sym.endLine}); use Read with offset/limit or raise max_body_lines`;
      }
      const parts: string[] = [];
      parts.push(fmtSymbol(sym));
      if (sym.parent) {
        const p = symbolById(data, sym.parent);
        if (p) parts.push(`member of ${p.kind} ${p.qualified} [${loc(p)}]`);
      }
      parts.push("");
      parts.push(numbered(src, start, end) + truncated);
      if (callers !== false) {
        const { hits, total } = await callersOf(indexer, sym.name, { excludeSymbolId: sym.id, limit: 20 });
        parts.push("", `callers of ${sym.name} (${total}):`, fmtCallers(hits, total));
      }
      if (callees !== false) {
        parts.push("", "callees:", fmtCallees(calleesOf(data, sym)));
      }
      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "callers",
    {
      title: "Who references a name",
      description:
        "List every call / new / extends / implements reference to a name across the repo, grouped with the enclosing function and the referencing line. Name matching is lexical (last identifier segment), so same-named methods on different classes are all included.",
      inputSchema: {
        name: z.string().describe("Bare symbol name, e.g. findById"),
        kinds: z.array(z.enum(["call", "new", "extends", "implements"])).optional().describe("Reference kinds to include (default all)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max hits (default 40)"),
      },
    },
    async ({ name, kinds, limit }) => {
      await indexer.refresh();
      const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      const { hits, total } = await callersOf(indexer, bare, { kinds, limit: limit ?? 40 });
      return text(`references to ${bare} (${total}):\n${fmtCallers(hits, total)}`);
    },
  );

  server.registerTool(
    "file_outline",
    {
      title: "File outline (skeleton)",
      description:
        "Structure of one file: imports, then every symbol with its line range, signature and first doc line, nested by class. Typically 5-10% of the tokens of reading the file. Use it to decide which symbol to get_symbol or which line range to Read.",
      inputSchema: { path: z.string().describe("File path, relative to the project root or absolute") },
    },
    async ({ path: p }) => {
      await indexer.refresh();
      const rel = indexer.toRel(p);
      let f = indexer.index.files[rel];
      if (!f) {
        // Allow suffix matches like `service.ts` → `src/users/service.ts`.
        const cands = Object.keys(indexer.index.files).filter((k) => k.endsWith("/" + rel) || k === rel);
        if (cands.length === 1) f = indexer.index.files[cands[0]];
        else if (cands.length > 1) return fail(`Ambiguous path; candidates:\n  ${cands.join("\n  ")}`);
      }
      if (!f) return fail(`${rel} is not in the index (unsupported extension, ignored path, or outside the root).`);
      const out = fmtOutline(f);
      return text(out + `\n(outline ≈ ${estTokens(out.length)} tokens)`);
    },
  );

  server.registerTool(
    "importers",
    {
      title: "Who imports a file",
      description:
        "Files that import the given file (relative imports, path aliases by suffix, Python dotted modules, PHP use statements by class name + namespace heuristics).",
      inputSchema: { path: z.string().describe("File path, relative to the project root or absolute") },
    },
    async ({ path: p }) => {
      await indexer.refresh();
      const rel = indexer.toRel(p);
      const hits = importersOf(indexer, indexer.resolveFile(rel) ?? rel);
      if (hits.length === 0) return text(`No indexed file imports ${rel}.`);
      const heuristic = hits.some((h) => h.heuristic);
      return text(
        `${hits.length} file(s) import ${rel}${heuristic ? " (suffix heuristic; nothing resolved structurally)" : ""}:\n` +
          hits.map((h) => `  ${h.file}:${h.line}  (${h.spec}${h.names?.length && h.names[0] !== "*" ? ` → ${h.names.slice(0, 5).join(", ")}` : ""})`).join("\n"),
      );
    },
  );

  server.registerTool(
    "changed_since",
    {
      title: "Symbol-level diff vs a git ref",
      description:
        "What changed between a git ref and the working tree, at symbol granularity: for each changed file, the functions/classes whose lines were touched (with signatures), plus added, deleted and untracked files. Use when resuming work to re-orient without re-reading files. Ref defaults to HEAD (uncommitted changes); try main, HEAD~3, or a tag.",
      inputSchema: {
        ref: z.string().optional().describe("Git ref to diff against (default HEAD)"),
        limit: z.number().int().min(1).max(500).optional().describe("Max files to report (default 60)"),
      },
    },
    async ({ ref, limit }) => {
      if (!(await isGitRepo(indexer.root))) return fail("Not a git repository.");
      await indexer.refresh();
      const data = indexer.index;
      let changes;
      try {
        changes = await changedSince(indexer.root, ref ?? "HEAD");
      } catch (err) {
        return fail(`git diff failed: ${(err as Error).message.split("\n")[0]}`);
      }
      if (changes.length === 0) return text(`No changes vs ${ref ?? "HEAD"}.`);
      const out: string[] = [`${changes.length} file(s) changed vs ${ref ?? "HEAD"}:`];
      const max = limit ?? 60;
      for (const c of changes.slice(0, max)) {
        const f = data.files[c.path];
        const label = c.status === "?" ? "untracked" : c.status === "A" ? "added" : c.status === "D" ? "deleted" : c.status === "R" ? `renamed from ${c.oldPath}` : "modified";
        if (!f) {
          out.push(`\n${c.path}  (${label}${c.status === "D" ? "" : ", not indexed"})`);
          continue;
        }
        out.push(`\n${c.path}  (${label}, ${f.symbols.length} symbols)`);
        if (c.status === "A" || c.status === "?") {
          for (const s of f.symbols.filter((s) => !s.parent).slice(0, 15)) out.push(`  + ${s.kind} ${s.qualified}: ${s.signature}`);
          continue;
        }
        const touched = new Set<SymbolEntry>();
        for (const [a, b] of c.ranges) {
          for (const s of f.symbols) if (s.startLine <= b && a <= s.endLine) touched.add(s);
        }
        // Keep innermost symbols only (drop a class if one of its methods is reported).
        const ids = new Set([...touched].map((s) => s.id));
        const inner = [...touched].filter((s) => ![...touched].some((o) => o.parent === s.id && ids.has(o.id)));
        if (inner.length === 0) {
          out.push(`  ~ lines ${c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ")} (outside any symbol: imports / top-level)`);
        } else {
          for (const s of inner) out.push(`  ~ ${s.kind} ${s.qualified} [${s.startLine}-${s.endLine}]: ${s.signature}`);
        }
      }
      if (changes.length > max) out.push(`\n… ${changes.length - max} more files`);
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List indexed files",
      description:
        "Indexed files with line counts and symbol counts, optionally filtered by a path substring. Use instead of ls -R / find to get a feel for a codebase's shape.",
      inputSchema: {
        filter: z.string().optional().describe("Substring of the path to filter on"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max files (default 200)"),
      },
    },
    async ({ filter, limit }) => {
      await indexer.refresh();
      const fl = filter?.toLowerCase();
      const files = Object.values(indexer.index.files)
        .filter((f) => !fl || f.path.toLowerCase().includes(fl))
        .sort((a, b) => a.path.localeCompare(b.path));
      const max = limit ?? 200;
      const lines = files.slice(0, max).map((f) => `${f.path}  ${f.lines}L ${f.symbols.length}sym`);
      if (files.length > max) lines.push(`… ${files.length - max} more`);
      const total = allSymbols(indexer.index).length;
      return text(`${files.length} file(s)${fl ? ` matching "${filter}"` : ""}, ${total} symbols in index:\n${lines.join("\n")}`);
    },
  );

  // -------------------------------------------------------------------------
  // Structural tools: locate, impact, conventions, recent
  // -------------------------------------------------------------------------

  server.registerTool(
    "locate",
    {
      title: "Locate code by concept",
      description:
        "Find where something lives when you don't know the exact name: 2-4 descriptive words (\"billing charge\", \"user repository\", \"belongsTo relation\"), a file stem, or a symbol. " +
        "Ranks files by symbol names, path and the names they reference, boosted by how many modules import them, and lists exact definitions with line ranges. " +
        "Use it instead of grep + reading candidates; use find_symbol when you already know the name.",
      inputSchema: {
        query: z.string().describe("Descriptive words, file name, or symbol name"),
        limit: z.number().int().min(1).max(30).optional().describe("Max files (default 8)"),
        kind: z.enum([...KINDS, "file"]).optional().describe("Restrict to a symbol kind, or \"file\" for path matching only"),
        area: z.string().optional().describe("Path prefix to search within, e.g. src/services"),
        includeTests: z.boolean().optional().describe("Rank test files normally (default: demoted unless the query mentions tests)"),
      },
    },
    async (args) => {
      await indexer.refresh();
      return text(fmtLocate(locate(indexer, args)));
    },
  );

  server.registerTool(
    "impact",
    {
      title: "Impact analysis",
      description:
        "Before changing a file or symbol: who depends on it (direct and transitive importers, with why), what it depends on, which files historically change together with it, and exactly which test files cover it — plus ready-to-run test commands. " +
        "Target: a path (src/services/billing.ts), a bare file name (billing.ts), a symbol (BillingService, Money.add), an id from find_symbol, or path:Symbol; comma-separate several. " +
        "Omit target to analyze all uncommitted changes; pass since (e.g. main) to analyze everything changed on the branch.",
      inputSchema: {
        target: z.string().optional().describe("File, symbol, Class.method, id, or path:Symbol; comma-separated for several"),
        since: z.string().optional().describe("Git ref: analyze all files changed since it (main, HEAD~3, a tag)"),
        maxDepth: z.number().int().min(1).max(10).optional().describe("Import hops to follow (default 5)"),
        transitive: z.boolean().optional().describe("Include transitive dependents (default true)"),
      },
    },
    async (args) => {
      await indexer.refresh();
      return text(fmtImpact(await impact(indexer, args)));
    },
  );

  server.registerTool(
    "conventions",
    {
      title: "Observed conventions",
      description:
        "What the code actually does, with example files as evidence: test framework and location, indentation/quotes/semicolons, module and export style, file and function naming, which error classes get thrown, logging, async usage, directory layout and the most-imported hub modules. " +
        "Scope with area (e.g. src/api) because sub-projects often differ. Read this before writing new code in an unfamiliar part of the repo.",
      inputSchema: {
        area: z.string().optional().describe("Path prefix to analyze, e.g. backend or src/services; omit for the whole repo"),
      },
    },
    async (args) => {
      await indexer.refresh();
      return text(conventions(indexer, args));
    },
  );

  server.registerTool(
    "recent",
    {
      title: "Recent changes and co-change affinity",
      description:
        "Git-backed recency: uncommitted changes, recent commits for the repo or for one file/directory, files that usually change together with the given file, and the hottest files in recent history. " +
        "Use it to see why a file looks the way it does or what else a change usually touches; use changed_since for a symbol-level diff.",
      inputSchema: {
        path: z.string().optional().describe("File or directory to focus on; omit for repo-wide activity"),
        limit: z.number().int().min(1).max(50).optional().describe("Number of commits (default 10)"),
      },
    },
    async (args) => {
      await indexer.refresh();
      return text(await recent(indexer, args));
    },
  );

  return { server, indexer };
}
