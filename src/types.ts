export type LangId = "typescript" | "tsx" | "javascript" | "python" | "php";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "trait"
  | "variable"
  | "constant";

export interface SymbolEntry {
  /** Stable id: `<relative file>#<qualified name>` (with `~N` suffix on collisions). */
  id: string;
  name: string;
  /** Dotted path including enclosing class / namespace, e.g. `UserService.findById`. */
  qualified: string;
  kind: SymbolKind;
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Declaration header without the body, whitespace-collapsed, capped. */
  signature: string;
  /** Parent symbol id (class for a method, etc). */
  parent?: string;
  exported: boolean;
  /** First line of the doc comment / docstring, if any. */
  doc?: string;
}

export type RefKind = "call" | "new" | "extends" | "implements";

/**
 * A reference inside a file. Kept compact because there are ~5x more refs than
 * symbols: the file is implied by the containing FileEntry and the enclosing
 * symbol is an index into that file's `symbols` array.
 */
export interface RefEntry {
  /** Bare callee / type name (last segment only, e.g. `findById`). */
  name: string;
  kind: RefKind;
  line: number;
  /** Index into the file's `symbols` of the innermost symbol containing this line. */
  in?: number;
}

export interface ImportEntry {
  /** Raw module specifier as written: `./users/service`, `app.models`, `App\Models\User`. */
  spec: string;
  line: number;
  /** Imported names; `default` and `*` are special. Omitted when unknown (treated as `*`). */
  names?: string[];
  /** Repo-relative file this import resolves to, when it is inside the repo. */
  resolved?: string;
}

/** Observed style facts, used by `conventions`. All derived from source, no inference. */
export interface FileFacts {
  /** Exception class names thrown/raised, with counts. */
  throws: Record<string, number>;
  indent: "tab" | "2" | "4" | "other" | "unknown";
  quotes: "single" | "double" | "mixed" | "unknown";
  /** TS/JS only. */
  semicolons?: boolean;
  /** TS/JS: default vs named exports. */
  exportStyle?: "default" | "named" | "mixed" | "none";
  /** TS/JS: esm vs cjs. */
  moduleStyle?: "esm" | "cjs" | "mixed" | "none";
  asyncFunctions: number;
  totalFunctions: number;
  /** Logging/console usage: identifier -> count. */
  loggers: Record<string, number>;
  /** Test framework detected from imports / base classes, if any. */
  testFramework?: string;
}

export interface FileEntry {
  path: string;
  lang: LangId;
  hash: string;
  mtimeMs: number;
  size: number;
  lines: number;
  symbols: SymbolEntry[];
  refs: RefEntry[];
  imports: ImportEntry[];
  /** PHP: declared (unbraced) namespace, for FQCN resolution. */
  namespace?: string;
  /** Recognized as a test file by path convention or framework import. */
  isTest: boolean;
  facts: FileFacts;
}

export interface ProjectConfig {
  /** tsconfig baseUrl relative to root. */
  tsBaseUrl?: string;
  /** tsconfig paths: pattern -> targets (relative to baseUrl or root). */
  tsPaths?: Record<string, string[]>;
  /** Candidate python source roots (relative to repo root). */
  pythonRoots: string[];
  /** composer PSR-4: namespace prefix -> dirs. */
  psr4: Record<string, string[]>;
  /** Detected test runners. */
  runners: {
    js?: "vitest" | "jest" | "mocha" | "node-test" | "bun";
    py?: "pytest" | "unittest";
    php?: "phpunit" | "pest";
  };
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
}

export interface IndexData {
  version: number;
  root: string;
  builtAt: number;
  config: ProjectConfig;
  files: Record<string, FileEntry>;
}

/** Bump whenever extraction changes so stale on-disk indexes are rebuilt. */
export const INDEX_VERSION = 6;

export function emptyFacts(): FileFacts {
  return { throws: {}, indent: "unknown", quotes: "unknown", asyncFunctions: 0, totalFunctions: 0, loggers: {} };
}

export function emptyConfig(): ProjectConfig {
  return { pythonRoots: [], psr4: {}, runners: {} };
}
