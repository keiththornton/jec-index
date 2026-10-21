import type { FileEntry, IndexData, SymbolEntry } from "./types.js";

/**
 * Derived, in-memory views over the index: resolved import edges in both
 * directions, the set of test files, symbols by name, and the names each file
 * references. Rebuilt by the indexer whenever the index changes.
 */
export class Graph {
  /** file -> files it imports (resolved, in-repo) */
  readonly imports = new Map<string, Set<string>>();
  /** file -> files that import it */
  readonly importers = new Map<string, Set<string>>();
  /** lowercase symbol name -> definitions */
  readonly symbolsByName = new Map<string, SymbolEntry[]>();
  /** lowercase referenced name -> files referencing it (calls, new, extends, implements) */
  readonly refIndex = new Map<string, Set<string>>();
  readonly testFiles = new Set<string>();
  readonly files: string[];

  constructor(readonly data: IndexData) {
    this.files = Object.keys(data.files).sort();
    for (const f of this.files) {
      this.imports.set(f, new Set());
      if (!this.importers.has(f)) this.importers.set(f, new Set());
    }
    for (const f of this.files) {
      const e = data.files[f];
      if (e.isTest) this.testFiles.add(f);
      for (const imp of e.imports) {
        if (!imp.resolved || imp.resolved === f) continue;
        this.imports.get(f)!.add(imp.resolved);
        let set = this.importers.get(imp.resolved);
        if (!set) {
          set = new Set();
          this.importers.set(imp.resolved, set);
        }
        set.add(f);
      }
      for (const s of e.symbols) {
        const key = s.name.toLowerCase();
        let list = this.symbolsByName.get(key);
        if (!list) {
          list = [];
          this.symbolsByName.set(key, list);
        }
        list.push(s);
      }
      for (const r of e.refs) {
        const key = r.name.toLowerCase();
        let set = this.refIndex.get(key);
        if (!set) {
          set = new Set();
          this.refIndex.set(key, set);
        }
        set.add(f);
      }
    }
  }

  entry(file: string): FileEntry | undefined {
    return this.data.files[file];
  }

  inDegree(file: string): number {
    return this.importers.get(file)?.size ?? 0;
  }

  /** Does `file` reference `name` by call/new/extends/implements, or import it by name? */
  references(file: string, name: string): boolean {
    if (this.refIndex.get(name.toLowerCase())?.has(file)) return true;
    const e = this.data.files[file];
    return e?.imports.some((i) => i.names?.includes(name)) ?? false;
  }

  /** Files that (transitively) import `file`, with the shortest hop count. */
  transitiveDependents(file: string, maxDepth = 6, limit = 2000): Map<string, number> {
    return this.bfs(file, this.importers, maxDepth, limit);
  }

  /** Files that `file` (transitively) imports. */
  transitiveDependencies(file: string, maxDepth = 6, limit = 2000): Map<string, number> {
    return this.bfs(file, this.imports, maxDepth, limit);
  }

  private bfs(start: string, edges: Map<string, Set<string>>, maxDepth: number, limit: number): Map<string, number> {
    const out = new Map<string, number>();
    let frontier = [start];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const dep of edges.get(f) ?? []) {
          if (dep === start || out.has(dep)) continue;
          out.set(dep, depth);
          next.push(dep);
          if (out.size >= limit) return out;
        }
      }
      frontier = next;
    }
    return out;
  }
}
