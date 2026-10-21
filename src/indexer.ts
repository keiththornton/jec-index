import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Graph } from "./graph.js";
import { extractFile, langForPath } from "./languages.js";
import { Resolver, loadProjectConfig } from "./resolve.js";
import { isTestPath } from "./tests.js";
import { INDEX_VERSION, emptyConfig, type FileEntry, type IndexData } from "./types.js";

const INDEX_DIR = ".jec-index";
const INDEX_FILE = "index.json";
const MAX_FILE_BYTES = 1_500_000;

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".vscode",
  INDEX_DIR,
]);

export interface RefreshReport {
  scanned: number;
  indexed: number;
  reparsed: number;
  removed: number;
  skipped: number;
  ms: number;
  errors: string[];
  /** Files whose content changed (re-parsed with a new hash) or that are new. */
  changedFiles: string[];
  /** Files that disappeared since the last refresh. */
  removedFiles: string[];
}

export class Indexer {
  readonly root: string;
  private data: IndexData;
  /** Derived views; rebuilt on every change (see relink). */
  graph: Graph;
  private ignoreDirs: Set<string>;
  private ignorePrefixes: string[] = [];
  private ignoreExts: string[] = [];
  private lastRefresh = 0;
  private refreshing: Promise<RefreshReport> | null = null;
  private dirty = false;

  private constructor(root: string, data: IndexData) {
    this.root = root;
    this.data = data;
    this.ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
    this.graph = new Graph(data);
  }

  static async open(root: string): Promise<Indexer> {
    root = path.resolve(root);
    let data: IndexData | undefined;
    try {
      const raw = await fs.readFile(path.join(root, INDEX_DIR, INDEX_FILE), "utf8");
      const parsed = JSON.parse(raw) as IndexData;
      if (parsed.version === INDEX_VERSION && parsed.root === root) data = parsed;
    } catch {
      /* no index yet */
    }
    const ix = new Indexer(root, data ?? { version: INDEX_VERSION, root, builtAt: 0, config: emptyConfig(), files: {} });
    await ix.loadGitignore();
    // Re-detect project config and re-resolve imports on every open: tsconfig/composer edits and
    // resolver fixes then apply without a full re-parse.
    if (data) ix.relink();
    return ix;
  }

  get index(): IndexData {
    return this.data;
  }

  private async loadGitignore() {
    try {
      const raw = await fs.readFile(path.join(this.root, ".gitignore"), "utf8");
      for (let line of raw.split("\n")) {
        line = line.trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        if (line.startsWith("*.") && !line.slice(2).includes("*") && !line.includes("/")) {
          this.ignoreExts.push(line.slice(1));
          continue;
        }
        if (/[*?\[\]]/.test(line)) continue; // unsupported glob, skip
        const clean = line.replace(/^\/+/, "").replace(/\/+$/, "");
        if (!clean) continue;
        if (clean.includes("/")) this.ignorePrefixes.push(clean);
        else this.ignoreDirs.add(clean);
      }
    } catch {
      /* no .gitignore */
    }
  }

  private isIgnoredRel(rel: string, name: string, isDir: boolean): boolean {
    if (this.ignoreDirs.has(name)) return true;
    for (const p of this.ignorePrefixes) if (rel === p || rel.startsWith(p + "/")) return true;
    if (!isDir) for (const e of this.ignoreExts) if (name.endsWith(e)) return true;
    return false;
  }

  /** Enumerate candidate source files (relative, posix-style). */
  private async walk(): Promise<Map<string, { mtimeMs: number; size: number }>> {
    const found = new Map<string, { mtimeMs: number; size: number }>();
    const stack: string[] = [""];
    while (stack.length) {
      const relDir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(path.join(this.root, relDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!this.isIgnoredRel(rel, e.name, true)) stack.push(rel);
        } else if (e.isFile()) {
          if (!langForPath(e.name)) continue;
          if (this.isIgnoredRel(rel, e.name, false)) continue;
          try {
            const st = await fs.stat(path.join(this.root, rel));
            if (st.size > MAX_FILE_BYTES) continue;
            found.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            /* vanished */
          }
        }
      }
    }
    return found;
  }

  /**
   * Bring the index up to date. Cheap when nothing changed (one stat per file).
   * Calls within `minIntervalMs` of the last refresh are coalesced.
   */
  async refresh(opts: { force?: boolean; minIntervalMs?: number } = {}): Promise<RefreshReport> {
    const minInterval = opts.minIntervalMs ?? 1500;
    if (!opts.force && Date.now() - this.lastRefresh < minInterval) {
      return { scanned: 0, indexed: Object.keys(this.data.files).length, reparsed: 0, removed: 0, skipped: 0, ms: 0, errors: [], changedFiles: [], removedFiles: [] };
    }
    if (this.refreshing) {
      if (!opts.force) return this.refreshing;
      await this.refreshing.catch(() => undefined);
    }
    this.refreshing = this.doRefresh(opts.force ?? false).finally(() => {
      this.refreshing = null;
      this.lastRefresh = Date.now();
    });
    return this.refreshing;
  }

  private async doRefresh(force: boolean): Promise<RefreshReport> {
    const t0 = Date.now();
    const report: RefreshReport = { scanned: 0, indexed: 0, reparsed: 0, removed: 0, skipped: 0, ms: 0, errors: [], changedFiles: [], removedFiles: [] };
    const current = await this.walk();
    report.scanned = current.size;

    for (const rel of Object.keys(this.data.files)) {
      if (!current.has(rel)) {
        delete this.data.files[rel];
        report.removed++;
        report.removedFiles.push(rel);
        this.dirty = true;
      }
    }

    const work: string[] = [];
    for (const [rel, st] of current) {
      const prev = this.data.files[rel];
      if (!force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        report.skipped++;
        continue;
      }
      work.push(rel);
    }

    // Parse in small batches so a huge repo doesn't hold everything in memory at once.
    const BATCH = 32;
    for (let i = 0; i < work.length; i += BATCH) {
      await Promise.all(
        work.slice(i, i + BATCH).map(async (rel) => {
          const st = current.get(rel)!;
          try {
            const entry = await this.indexOne(rel, st, force);
            if (entry) {
              this.data.files[rel] = entry;
              report.reparsed++;
              report.changedFiles.push(rel);
              this.dirty = true;
            } else {
              report.skipped++;
            }
          } catch (err) {
            report.errors.push(`${rel}: ${(err as Error).message}`);
          }
        }),
      );
    }

    report.changedFiles.sort();
    report.indexed = Object.keys(this.data.files).length;
    if (this.dirty) {
      this.data.builtAt = Date.now();
      this.relink();
      await this.save();
    }
    report.ms = Date.now() - t0;
    return report;
  }

  private async indexOne(rel: string, st: { mtimeMs: number; size: number }, force: boolean): Promise<FileEntry | null> {
    const lang = langForPath(rel)!;
    const abs = path.join(this.root, rel);
    const buf = await fs.readFile(abs);
    const hash = createHash("sha1").update(buf).digest("hex");
    const prev = this.data.files[rel];
    if (!force && prev && prev.hash === hash) {
      // Touched but unchanged: just refresh the stat so next scan is a cheap skip.
      prev.mtimeMs = st.mtimeMs;
      prev.size = st.size;
      this.dirty = true;
      return null;
    }
    const src = buf.toString("utf8");
    const { symbols, refs, imports, namespace, facts } = await extractFile(lang, rel, src);
    let lines = 1;
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lines++;
    const isTest = isTestPath(rel, lang) || (Boolean(facts.testFramework) && /test|spec/i.test(rel));
    const entry: FileEntry = { path: rel, lang, hash, mtimeMs: st.mtimeMs, size: st.size, lines, symbols, refs, imports, isTest, facts };
    if (namespace) entry.namespace = namespace;
    return entry;
  }

  /**
   * Re-detect project config (tsconfig paths, python roots, PSR-4, runners),
   * resolve every import against the current file set, and rebuild the graph.
   * Cheap relative to parsing: string work only.
   */
  relink(): void {
    const files = Object.keys(this.data.files);
    this.data.config = loadProjectConfig(this.root, files);
    const entries = Object.values(this.data.files);
    const resolver = new Resolver(this.data.config, entries);
    for (const e of entries) {
      for (const imp of e.imports) {
        const r = resolver.resolve(e.path, e.lang, imp.spec);
        if (r) imp.resolved = r;
        else delete imp.resolved;
      }
    }
    this.graph = new Graph(this.data);
  }

  /** Resolve a user-supplied path (absolute, relative, bare file name, or stem) to an indexed file. */
  resolveFile(p: string): string | undefined {
    const rel = this.toRel(p).replace(/^\.\//, "");
    if (rel.startsWith("..")) return undefined;
    if (this.data.files[rel]) return rel;
    const files = this.graph.files;
    const bySuffix = files.filter((f) => f === rel || f.endsWith("/" + rel));
    if (bySuffix.length === 1) return bySuffix[0];
    if (bySuffix.length > 1) return undefined;
    if (!/\.[a-z]+$/i.test(rel)) {
      const byStem = files.filter((f) => {
        const stem = f.replace(/\.[^.]+$/, "");
        return stem === rel || stem.endsWith("/" + rel);
      });
      if (byStem.length === 1) return byStem[0];
    }
    return undefined;
  }

  async save() {
    const dir = path.join(this.root, INDEX_DIR);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, INDEX_FILE + ".tmp");
    await fs.writeFile(tmp, JSON.stringify(this.data));
    await fs.rename(tmp, path.join(dir, INDEX_FILE));
    // Keep the index out of git by default.
    try {
      await fs.access(path.join(dir, ".gitignore"));
    } catch {
      await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
    }
    this.dirty = false;
  }

  async readSource(rel: string): Promise<string> {
    return fs.readFile(path.join(this.root, rel), "utf8");
  }

  toRel(p: string): string {
    const abs = path.isAbsolute(p) ? p : path.join(this.root, p);
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}
