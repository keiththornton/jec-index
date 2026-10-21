import { createRequire } from "node:module";
import { Parser, Language, type Node, type Tree } from "web-tree-sitter";
import { emptyFacts, type FileFacts, type ImportEntry, type LangId, type RefEntry, type RefKind, type SymbolEntry, type SymbolKind } from "./types.js";

const require = createRequire(import.meta.url);

const WASM: Record<LangId, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  php: "tree-sitter-php/tree-sitter-php.wasm",
};

const EXT: Record<string, LangId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".php": "php",
  ".phtml": "php",
};

export function langForPath(p: string): LangId | undefined {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT[p.slice(dot).toLowerCase()];
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXT);

let initialized = false;
const languages = new Map<LangId, Language>();
const parsers = new Map<LangId, Parser>();

export async function getParser(lang: LangId): Promise<Parser> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  let parser = parsers.get(lang);
  if (parser) return parser;
  let language = languages.get(lang);
  if (!language) {
    language = await Language.load(require.resolve(WASM[lang]));
    languages.set(lang, language);
  }
  parser = new Parser();
  parser.setLanguage(language);
  parsers.set(lang, parser);
  return parser;
}

export interface Extraction {
  symbols: SymbolEntry[];
  refs: RefEntry[];
  imports: ImportEntry[];
  /** PHP: the file's unbraced namespace, if declared. */
  namespace?: string;
  facts: FileFacts;
}

const LOGGER_NAMES = new Set(["console", "logger", "log", "pino", "winston", "bunyan", "debug", "logging", "structlog", "loguru", "Log", "error_log", "var_dump", "dd", "dump"]);
const TEST_IMPORTS: Record<string, string> = {
  vitest: "vitest",
  "@jest/globals": "jest",
  jest: "jest",
  mocha: "mocha",
  "node:test": "node:test",
  "bun:test": "bun",
  "@playwright/test": "playwright",
  cypress: "cypress",
  pytest: "pytest",
  unittest: "unittest",
  hypothesis: "hypothesis",
  "django.test": "django-test",
  "PHPUnit\\Framework\\TestCase": "phpunit",
  "Tests\\TestCase": "phpunit",
};

function bump(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

/** Indentation and quote style from raw text; language-agnostic. */
function textFacts(src: string, facts: FileFacts, lang: LangId): void {
  let tabs = 0;
  let two = 0;
  let four = 0;
  for (const line of src.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("\t")) tabs++;
    else if (line.startsWith("    ")) four++;
    else if (line.startsWith("  ")) two++;
  }
  const total = tabs + two + four;
  if (total < 3) facts.indent = "unknown";
  else if (tabs / total > 0.6) facts.indent = "tab";
  else if (two > four * 1.5) facts.indent = "2";
  else if (four > two * 1.5) facts.indent = "4";
  else facts.indent = "other";
  const single = (src.match(/'[^'\n\\]{0,80}'/g) ?? []).length;
  const double = (src.match(/"[^"\n\\]{0,80}"/g) ?? []).length;
  if (single + double < 3) facts.quotes = "unknown";
  else if (single > double * 2) facts.quotes = "single";
  else if (double > single * 2) facts.quotes = "double";
  else facts.quotes = "mixed";
  if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    const esm = (src.match(/^\s*(import\s|export\s)/gm) ?? []).length;
    const cjs = (src.match(/\brequire\s*\(|^\s*module\.exports\b|^\s*exports\.\w+\s*=/gm) ?? []).length;
    facts.moduleStyle = esm && cjs ? "mixed" : esm ? "esm" : cjs ? "cjs" : "none";
    const def = (src.match(/^\s*export\s+default\b/gm) ?? []).length;
    const named = (src.match(/^\s*export\s+(?!default)(const|let|var|function|async|class|abstract|interface|type|enum|\{|\*)/gm) ?? []).length;
    facts.exportStyle = def && named ? "mixed" : def ? "default" : named ? "named" : "none";
    const semi = (src.match(/;\s*$/gm) ?? []).length;
    const stmtLines = (src.match(/^\s*(const|let|var|return|import|export|throw)\b[^\n]*[^;{\s]\s*$/gm) ?? []).length;
    if (semi + stmtLines >= 3) facts.semicolons = semi >= stmtLines;
  }
}

const SIGNATURE_MAX = 220;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function capSignature(s: string): string {
  s = collapse(s).replace(/\s*[{:]\s*$/, "");
  if (s.length > SIGNATURE_MAX) s = s.slice(0, SIGNATURE_MAX - 1) + "…";
  return s;
}

function firstDocLine(comment: string): string | undefined {
  const lines = comment
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\s*#\s?/gm, "")
    .replace(/^\s*\/\/\/?\s?/gm, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\s*("""|''')/, "")
    .replace(/("""|''')\s*$/, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("@"));
  if (lines.length === 0) return undefined;
  const l = lines[0];
  return l.length > 160 ? l.slice(0, 159) + "…" : l;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/** Strip a trailing `.d` / extension-less module path quirks are left to the caller. */
function lastSegment(name: string): string {
  const m = name.match(/[A-Za-z_$][\w$]*$/);
  return m ? m[0] : name;
}

interface Ctx {
  lang: LangId;
  file: string;
  src: string;
  symbols: SymbolEntry[];
  refs: RefEntry[];
  imports: ImportEntry[];
  /** Enclosing symbol qualified-name stack. */
  scope: string[];
  /** Enclosing symbol id stack. */
  scopeIds: string[];
  namespace: string;
  ids: Set<string>;
  facts: FileFacts;
  /** The first unbraced `namespace X;` seen (PHP). */
  fileNamespace?: string;
}

function makeId(ctx: Ctx, qualified: string): string {
  const base = `${ctx.file}#${qualified}`;
  if (!ctx.ids.has(base)) {
    ctx.ids.add(base);
    return base;
  }
  let n = 2;
  while (ctx.ids.has(`${base}~${n}`)) n++;
  const id = `${base}~${n}`;
  ctx.ids.add(id);
  return id;
}

function addSymbol(
  ctx: Ctx,
  opts: {
    name: string;
    kind: SymbolKind;
    node: Node;
    /** Node whose start marks the signature start (export statement, decorator...). */
    headNode?: Node;
    bodyNode?: Node | null;
    exported: boolean;
    doc?: string;
  },
): SymbolEntry {
  const head = opts.headNode ?? opts.node;
  const sigEnd = opts.bodyNode ? opts.bodyNode.startIndex : undefined;
  let sigText: string;
  if (sigEnd !== undefined && sigEnd > head.startIndex) {
    sigText = ctx.src.slice(head.startIndex, sigEnd);
  } else {
    const firstLineEnd = ctx.src.indexOf("\n", head.startIndex);
    sigText = ctx.src.slice(
      head.startIndex,
      firstLineEnd < 0 || firstLineEnd > head.endIndex ? head.endIndex : firstLineEnd,
    );
  }
  const prefix = ctx.namespace ? ctx.namespace + "." : "";
  const qualified = prefix + [...ctx.scope, opts.name].join(".");
  const entry: SymbolEntry = {
    id: makeId(ctx, qualified),
    name: opts.name,
    qualified,
    kind: opts.kind,
    file: ctx.file,
    startLine: head.startPosition.row + 1,
    endLine: opts.node.endPosition.row + 1,
    signature: capSignature(sigText),
    exported: opts.exported,
  };
  const parentId = ctx.scopeIds[ctx.scopeIds.length - 1];
  if (parentId) entry.parent = parentId;
  if (opts.doc) entry.doc = opts.doc;
  ctx.symbols.push(entry);
  return entry;
}

function addRef(ctx: Ctx, name: string | undefined, kind: RefKind, node: Node) {
  if (!name) return;
  const bare = lastSegment(name);
  if (!bare) return;
  ctx.refs.push({ name: bare, kind, line: node.startPosition.row + 1 });
}

function withScope(ctx: Ctx, entry: SymbolEntry, fn: () => void) {
  ctx.scope.push(entry.name);
  ctx.scopeIds.push(entry.id);
  try {
    fn();
  } finally {
    ctx.scope.pop();
    ctx.scopeIds.pop();
  }
}

/** Doc comment immediately preceding `node` (JS/TS/PHP style). */
function leadingComment(node: Node): string | undefined {
  let prev = node.previousNamedSibling;
  if (!prev || prev.type !== "comment") return undefined;
  // Must be adjacent (at most one blank line between).
  if (node.startPosition.row - prev.endPosition.row > 2) return undefined;
  const text = prev.text;
  if (!(text.startsWith("/**") || text.startsWith("///") || text.startsWith("#"))) {
    // Allow a run of // lines too, but only report when it looks intentional.
    if (!text.startsWith("//")) return undefined;
  }
  return firstDocLine(text);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript / TSX
// ---------------------------------------------------------------------------

const TS_FN_VALUE = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

/**
 * `await x.y<T>(...)` parses with the await wrapping the callee rather than the call;
 * `x!(…)`, `(x)(…)` and `(x as F)(…)` wrap it too. Peel those off.
 */
function unwrapCallee(fn: Node | null): Node | null {
  while (fn && (fn.type === "await_expression" || fn.type === "non_null_expression" || fn.type === "parenthesized_expression" || fn.type === "as_expression" || fn.type === "satisfies_expression")) {
    fn = fn.namedChildren[0] ?? null;
  }
  return fn;
}

/** `(x) => …` wrapped in parens or an `as`/`satisfies` cast is still a function value. */
function unwrapValue(v: Node | null): Node | null {
  while (v && (v.type === "parenthesized_expression" || v.type === "as_expression" || v.type === "satisfies_expression" || v.type === "non_null_expression")) {
    v = v.namedChildren[0] ?? null;
  }
  return v;
}

function tsIsPrivate(node: Node): boolean {
  const name = node.childForFieldName("name");
  if (name?.type === "private_property_identifier") return true;
  for (const c of node.children) {
    if (!c) continue;
    if (c === name) break;
    if (c.type === "accessibility_modifier" && c.text === "private") return true;
  }
  return false;
}

function visitTs(ctx: Ctx, node: Node, exportedWrapper?: Node) {
  const t = node.type;
  const exported = exportedWrapper !== undefined;
  const head = exportedWrapper ?? node;

  switch (t) {
    case "export_statement": {
      const src = node.childForFieldName("source");
      if (src) {
        // re-export: `export { a } from './x'` / `export * from './x'`
        const names: string[] = [];
        for (const c of node.namedChildren) {
          if (c?.type !== "export_clause") continue;
          for (const spec of c.namedChildren) {
            const nm = spec?.childForFieldName("name")?.text;
            if (nm) names.push(nm);
          }
        }
        ctx.imports.push({ spec: stripQuotes(src.text), line: node.startPosition.row + 1, names: names.length ? names : ["*"] });
        return;
      }
      const decl = node.childForFieldName("declaration");
      if (decl) {
        visitTs(ctx, decl, node);
      } else {
        for (const c of node.namedChildren) if (c) visitTs(ctx, c);
      }
      return;
    }
    case "function_declaration":
    case "generator_function_declaration": {
      countFn(ctx, node);
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const entry = addSymbol(ctx, {
        name,
        kind: ctx.scope.length ? "method" : "function",
        node,
        headNode: head,
        bodyNode: node.childForFieldName("body"),
        exported,
        doc: leadingComment(head),
      });
      withScope(ctx, entry, () => visitChildren(ctx, node.childForFieldName("body")));
      return;
    }
    case "class_declaration":
    case "abstract_class_declaration":
    case "class": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const entry = addSymbol(ctx, {
        name,
        kind: "class",
        node,
        headNode: head,
        bodyNode: node.childForFieldName("body"),
        exported,
        doc: leadingComment(head),
      });
      for (const c of node.namedChildren) {
        if (!c || c.type !== "class_heritage") continue;
        for (const h of c.namedChildren) {
          if (!h) continue;
          if (h.type === "extends_clause") {
            for (const v of h.namedChildren) if (v && v.type !== "type_arguments") addRef(ctx, v.text, "extends", v);
          } else if (h.type === "implements_clause") {
            for (const v of h.namedChildren) if (v && v.type !== "type_arguments") addRef(ctx, v.text, "implements", v);
          } else {
            addRef(ctx, h.text, "extends", h);
          }
        }
      }
      withScope(ctx, entry, () => visitChildren(ctx, node.childForFieldName("body")));
      return;
    }
    case "interface_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const entry = addSymbol(ctx, {
        name,
        kind: "interface",
        node,
        headNode: head,
        bodyNode: node.childForFieldName("body"),
        exported,
        doc: leadingComment(head),
      });
      for (const c of node.namedChildren) {
        if (c && c.type === "extends_type_clause") {
          for (const v of c.namedChildren) if (v && v.type !== "type_arguments") addRef(ctx, v.text, "extends", v);
        }
      }
      void entry;
      return;
    }
    case "type_alias_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      addSymbol(ctx, { name, kind: "type", node, headNode: head, bodyNode: node.childForFieldName("value"), exported, doc: leadingComment(head) });
      return;
    }
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      addSymbol(ctx, { name, kind: "enum", node, headNode: head, bodyNode: node.childForFieldName("body"), exported, doc: leadingComment(head) });
      return;
    }
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature": {
      if (t === "method_definition") countFn(ctx, node);
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const entry = addSymbol(ctx, {
        name,
        kind: "method",
        node,
        bodyNode: node.childForFieldName("body"),
        exported: !tsIsPrivate(node),
        doc: leadingComment(node),
      });
      withScope(ctx, entry, () => visitChildren(ctx, node.childForFieldName("body")));
      return;
    }
    case "public_field_definition": {
      const value = node.childForFieldName("value");
      if (value && TS_FN_VALUE.has(value.type)) {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const entry = addSymbol(ctx, { name, kind: "method", node, bodyNode: value.childForFieldName("body"), exported: !tsIsPrivate(node), doc: leadingComment(node) });
        withScope(ctx, entry, () => visitChildren(ctx, value));
        return;
      }
      break;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // Only top-level (or exported) declarations become symbols.
      if (ctx.scope.length === 0) {
        for (const d of node.namedChildren) {
          if (!d || d.type !== "variable_declarator") continue;
          const nameNode = d.childForFieldName("name");
          if (!nameNode || nameNode.type !== "identifier") continue;
          const value = d.childForFieldName("value");
          const fnValue = unwrapValue(value);
          const isFn = fnValue !== null && TS_FN_VALUE.has(fnValue.type);
          const isConst = node.text.startsWith("const");
          const entry = addSymbol(ctx, {
            name: nameNode.text,
            kind: isFn ? "function" : isConst ? "constant" : "variable",
            node: d,
            headNode: head,
            bodyNode: isFn ? fnValue.childForFieldName("body") : undefined,
            exported,
            doc: leadingComment(head),
          });
          if (value) withScope(ctx, entry, () => visitTs(ctx, value));
        }
        return;
      }
      break;
    }
    case "call_expression": {
      const fn = unwrapCallee(node.childForFieldName("function"));
      if (fn) {
        if (fn.type === "identifier") {
          if (fn.text === "require") {
            const arg = node.childForFieldName("arguments")?.namedChildren[0];
            if (arg && arg.type === "string") ctx.imports.push({ spec: stripQuotes(arg.text), line: node.startPosition.row + 1, names: ["*"] });
          } else {
            addRef(ctx, fn.text, "call", fn);
          }
        } else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          addRef(ctx, prop?.text, "call", prop ?? fn);
          const obj = fn.childForFieldName("object");
          const base = obj?.type === "identifier" ? obj.text : obj?.type === "member_expression" ? obj.childForFieldName("object")?.text : undefined;
          if (base && LOGGER_NAMES.has(base)) bump(ctx.facts.loggers, base);
        } else if (fn.type === "import") {
          const arg = node.childForFieldName("arguments")?.namedChildren[0];
          if (arg && arg.type === "string") ctx.imports.push({ spec: stripQuotes(arg.text), line: node.startPosition.row + 1, names: ["*"] });
        }
      }
      break;
    }
    case "throw_statement": {
      const arg = node.namedChildren[0];
      if (arg?.type === "new_expression") {
        const c = arg.childForFieldName("constructor");
        bump(ctx.facts.throws, c ? lastSegment(c.text) : undefined);
      } else bump(ctx.facts.throws, "<non-constructor>");
      break;
    }
    case "arrow_function":
    case "function_expression":
    case "function":
    case "generator_function":
      countFn(ctx, node);
      break;
    case "new_expression": {
      const c = node.childForFieldName("constructor");
      if (c) {
        const prop = c.type === "member_expression" ? c.childForFieldName("property") : null;
        addRef(ctx, prop ? prop.text : c.text, "new", prop ?? c);
      }
      break;
    }
    case "import_statement": {
      const src = node.childForFieldName("source");
      if (src) ctx.imports.push({ spec: stripQuotes(src.text), line: node.startPosition.row + 1, names: tsImportNames(node) });
      return;
    }
    case "export_clause":
    case "string":
    case "template_string":
    case "comment":
    case "regex":
      return;
  }
  visitChildren(ctx, node);
}

function countFn(ctx: Ctx, node: Node): void {
  ctx.facts.totalFunctions++;
  if (node.children.some((c) => c?.type === "async")) ctx.facts.asyncFunctions++;
}

function tsImportNames(node: Node): string[] {
  const names: string[] = [];
  const clause = node.namedChildren.find((c) => c?.type === "import_clause");
  if (!clause) return names;
  for (const c of clause.namedChildren) {
    if (!c) continue;
    if (c.type === "identifier") names.push("default");
    else if (c.type === "namespace_import") names.push("*");
    else if (c.type === "named_imports") {
      for (const spec of c.namedChildren) {
        const nm = spec?.childForFieldName("name")?.text;
        if (nm) names.push(nm);
      }
    }
  }
  return names;
}

function visitChildren(ctx: Ctx, node: Node | null | undefined) {
  if (!node) return;
  for (const c of node.namedChildren) if (c) VISIT[ctx.lang](ctx, c);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pyDocstring(body: Node | null): string | undefined {
  const first = body?.namedChildren[0];
  if (!first || first.type !== "expression_statement") return undefined;
  const s = first.namedChildren[0];
  if (!s || s.type !== "string") return undefined;
  return firstDocLine(s.text.replace(/^[rRbBuUfF]*/, ""));
}

function visitPy(ctx: Ctx, node: Node, decorated?: Node) {
  const head = decorated ?? node;
  switch (node.type) {
    case "decorated_definition": {
      const def = node.childForFieldName("definition");
      if (def) visitPy(ctx, def, node);
      return;
    }
    case "function_definition": {
      countFn(ctx, node);
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const body = node.childForFieldName("body");
      const entry = addSymbol(ctx, {
        name,
        kind: ctx.scope.length ? "method" : "function",
        node,
        headNode: head,
        bodyNode: body,
        exported: !name.startsWith("_"),
        doc: pyDocstring(body),
      });
      withScope(ctx, entry, () => visitChildren(ctx, body));
      return;
    }
    case "class_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const body = node.childForFieldName("body");
      const entry = addSymbol(ctx, { name, kind: "class", node, headNode: head, bodyNode: body, exported: !name.startsWith("_"), doc: pyDocstring(body) });
      const supers = node.childForFieldName("superclasses");
      if (supers) for (const s of supers.namedChildren) if (s && s.type !== "keyword_argument") addRef(ctx, s.text, "extends", s);
      withScope(ctx, entry, () => visitChildren(ctx, body));
      return;
    }
    case "expression_statement": {
      if (ctx.scope.length === 0) {
        const a = node.namedChildren[0];
        if (a && a.type === "assignment") {
          const left = a.childForFieldName("left");
          if (left && left.type === "identifier") {
            addSymbol(ctx, {
              name: left.text,
              kind: /^[A-Z0-9_]+$/.test(left.text) ? "constant" : "variable",
              node: a,
              exported: !left.text.startsWith("_"),
            });
          }
        }
      }
      break;
    }
    case "call": {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "identifier") {
          addRef(ctx, fn.text, "call", fn);
          if (fn.text === "print") bump(ctx.facts.loggers, "print");
        } else if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          addRef(ctx, attr?.text, "call", attr ?? fn);
          const obj = fn.childForFieldName("object");
          const base = obj?.type === "identifier" ? obj.text : obj?.type === "attribute" ? obj.childForFieldName("object")?.text : undefined;
          if (base && LOGGER_NAMES.has(base)) bump(ctx.facts.loggers, base);
        }
      }
      break;
    }
    case "raise_statement": {
      const arg = node.namedChildren[0];
      if (!arg) bump(ctx.facts.throws, "<re-raise>");
      else if (arg.type === "call") bump(ctx.facts.throws, lastSegment(arg.childForFieldName("function")?.text ?? ""));
      else if (arg.type === "identifier") bump(ctx.facts.throws, arg.text);
      else bump(ctx.facts.throws, "<re-raise>");
      break;
    }
    case "import_statement": {
      for (const c of node.namedChildren) {
        if (!c) continue;
        const name = c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.text;
        if (name) ctx.imports.push({ spec: name, line: node.startPosition.row + 1, names: ["*"] });
      }
      return;
    }
    case "import_from_statement": {
      const modNode = node.childForFieldName("module_name");
      const mod = modNode?.text;
      if (mod) {
        const names: string[] = [];
        for (const c of node.namedChildren) {
          if (!c || c.id === modNode!.id) continue;
          if (c.type === "dotted_name") names.push(c.text);
          else if (c.type === "aliased_import") {
            const nm = c.childForFieldName("name")?.text;
            if (nm) names.push(nm);
          } else if (c.type === "wildcard_import") names.push("*");
        }
        ctx.imports.push({ spec: mod, line: node.startPosition.row + 1, names });
      }
      return;
    }
    case "string":
    case "comment":
      return;
  }
  visitChildren(ctx, node);
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

function phpName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "name" || node.type === "qualified_name" || node.type === "variable_name") return node.text;
  return node.childForFieldName("name")?.text ?? node.text;
}

function visitPhp(ctx: Ctx, node: Node) {
  switch (node.type) {
    case "namespace_definition": {
      const name = node.childForFieldName("name")?.text;
      const body = node.childForFieldName("body");
      if (body) {
        // Braced namespace: scoped.
        const saved = ctx.namespace;
        if (name) ctx.namespace = name.replace(/\\/g, ".");
        visitChildren(ctx, body);
        ctx.namespace = saved;
      } else if (name) {
        ctx.namespace = name.replace(/\\/g, ".");
        ctx.fileNamespace ??= name;
      }
      return;
    }
    case "function_definition": {
      countFn(ctx, node);
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const body = node.childForFieldName("body");
      const entry = addSymbol(ctx, { name, kind: ctx.scope.length ? "method" : "function", node, bodyNode: body, exported: true, doc: leadingComment(node) });
      withScope(ctx, entry, () => visitChildren(ctx, body));
      return;
    }
    case "method_declaration": {
      countFn(ctx, node);
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const body = node.childForFieldName("body");
      const entry = addSymbol(ctx, { name, kind: "method", node, bodyNode: body, exported: !/\bprivate\b/.test(node.text.slice(0, node.childForFieldName("name")!.startIndex - node.startIndex)), doc: leadingComment(node) });
      withScope(ctx, entry, () => visitChildren(ctx, body));
      return;
    }
    case "class_declaration":
    case "interface_declaration":
    case "trait_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const kind: SymbolKind =
        node.type === "class_declaration" ? "class" : node.type === "interface_declaration" ? "interface" : node.type === "trait_declaration" ? "trait" : "enum";
      const body = node.childForFieldName("body");
      const entry = addSymbol(ctx, { name, kind, node, bodyNode: body, exported: true, doc: leadingComment(node) });
      for (const c of node.namedChildren) {
        if (!c) continue;
        if (c.type === "base_clause") for (const v of c.namedChildren) if (v) addRef(ctx, v.text, "extends", v);
        if (c.type === "class_interface_clause") for (const v of c.namedChildren) if (v) addRef(ctx, v.text, "implements", v);
      }
      // `use SomeTrait;` inside the class body is a dependency too
      if (body) for (const m of body.namedChildren) {
        if (m?.type !== "use_declaration") continue;
        for (const tnode of m.namedChildren) {
          if (tnode && (tnode.type === "name" || tnode.type === "qualified_name")) ctx.imports.push({ spec: tnode.text, line: m.startPosition.row + 1, names: [lastSegment(tnode.text)] });
        }
      }
      withScope(ctx, entry, () => visitChildren(ctx, body));
      return;
    }
    case "const_declaration": {
      for (const el of node.namedChildren) {
        if (!el || el.type !== "const_element") continue;
        const nm = el.namedChildren[0];
        if (nm) addSymbol(ctx, { name: nm.text, kind: "constant", node: el, exported: true });
      }
      return;
    }
    case "function_call_expression": {
      const fn = node.childForFieldName("function");
      if (fn && fn.type !== "variable_name") {
        const nm = phpName(fn);
        addRef(ctx, nm, "call", node);
        if (nm && LOGGER_NAMES.has(lastSegment(nm))) bump(ctx.facts.loggers, lastSegment(nm));
      }
      break;
    }
    case "anonymous_function":
    case "arrow_function":
      countFn(ctx, node);
      break;
    case "throw_expression": {
      const arg = node.namedChildren[0];
      if (arg?.type === "object_creation_expression") {
        const cls = arg.namedChildren.find((c) => c && (c.type === "name" || c.type === "qualified_name"));
        bump(ctx.facts.throws, cls ? lastSegment(cls.text) : undefined);
      } else bump(ctx.facts.throws, "<re-throw>");
      break;
    }
    case "member_call_expression":
    case "nullsafe_member_call_expression":
    case "scoped_call_expression": {
      const nm = node.childForFieldName("name");
      addRef(ctx, nm?.text, "call", nm ?? node);
      const obj = node.childForFieldName("object") ?? node.childForFieldName("scope");
      if (obj) {
        const base = lastSegment(obj.text.replace(/^\$/, ""));
        if (LOGGER_NAMES.has(base)) bump(ctx.facts.loggers, base);
      }
      break;
    }
    case "object_creation_expression": {
      const cls = node.namedChildren.find((c) => c && (c.type === "name" || c.type === "qualified_name"));
      if (cls) addRef(ctx, cls.text, "new", cls);
      break;
    }
    case "namespace_use_declaration": {
      const prefix = node.namedChildren.find((c) => c?.type === "namespace_name" || c?.type === "qualified_name")?.text ?? "";
      for (const clause of node.namedChildren) {
        if (!clause) continue;
        if (clause.type === "namespace_use_clause") {
          const q = clause.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "name");
          if (q) ctx.imports.push({ spec: q.text, line: node.startPosition.row + 1, names: [lastSegment(q.text)] });
        } else if (clause.type === "namespace_use_group") {
          // use App\Models\{User, Post};
          for (const item of clause.namedChildren) {
            const q = item?.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "name")?.text;
            if (q) ctx.imports.push({ spec: prefix ? `${prefix}\\${q}` : q, line: node.startPosition.row + 1, names: [lastSegment(q)] });
          }
        }
      }
      return;
    }
    case "require_expression":
    case "require_once_expression":
    case "include_expression":
    case "include_once_expression": {
      const arg = node.namedChildren[0];
      const lit = arg ? phpLiteralPath(arg) : undefined;
      if (lit) ctx.imports.push({ spec: lit, line: node.startPosition.row + 1, names: ["*"] });
      return;
    }
    case "string":
    case "encapsed_string":
    case "comment":
      return;
  }
  visitChildren(ctx, node);
}

/** `__DIR__ . '/x.php'` → `__DIR__/x.php`; plain string literal → as written. */
function phpLiteralPath(n: Node): string | undefined {
  const text = n.text.trim();
  const m = text.match(/^__DIR__\s*\.\s*['"]([^'"]+)['"]$/);
  if (m) return "__DIR__" + m[1];
  const s = text.match(/^['"]([^'"]+)['"]$/);
  if (s) return s[1];
  return undefined;
}

const VISIT: Record<LangId, (ctx: Ctx, node: Node) => void> = {
  typescript: (c, n) => visitTs(c, n),
  tsx: (c, n) => visitTs(c, n),
  javascript: (c, n) => visitTs(c, n),
  python: (c, n) => visitPy(c, n),
  php: (c, n) => visitPhp(c, n),
};

/** Attach each ref to the innermost symbol containing its line. */
function attachRefs(symbols: SymbolEntry[], refs: RefEntry[]) {
  // Innermost = smallest range containing the line. Symbols are in source order,
  // nested ones follow their parents, so the last match is the innermost.
  for (const r of refs) {
    let best = -1;
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      if (s.startLine <= r.line && r.line <= s.endLine) {
        if (best < 0 || s.endLine - s.startLine <= symbols[best].endLine - symbols[best].startLine) best = i;
      }
    }
    if (best >= 0) r.in = best;
  }
}

export async function extractFile(lang: LangId, file: string, src: string): Promise<Extraction> {
  const parser = await getParser(lang);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(src);
    if (!tree) return { symbols: [], refs: [], imports: [], facts: emptyFacts() };
    const ctx: Ctx = {
      lang,
      file,
      src,
      symbols: [],
      refs: [],
      imports: [],
      scope: [],
      scopeIds: [],
      namespace: "",
      ids: new Set(),
      facts: emptyFacts(),
    };
    VISIT[lang](ctx, tree.rootNode);
    attachRefs(ctx.symbols, ctx.refs);
    textFacts(src, ctx.facts, lang);
    for (const imp of ctx.imports) {
      const fw = TEST_IMPORTS[imp.spec] ?? (lang === "python" ? TEST_IMPORTS[imp.spec.split(".")[0]] : undefined);
      if (fw) {
        ctx.facts.testFramework = fw;
        break;
      }
    }
    if (lang === "php" && !ctx.facts.testFramework) {
      if (ctx.refs.some((r) => r.kind === "extends" && r.name === "TestCase")) ctx.facts.testFramework = "phpunit";
      else if (/\b(it|test)\(\s*['"]/.test(src) && /\buses\(|\bexpect\(/.test(src)) ctx.facts.testFramework = "pest";
    }
    return { symbols: ctx.symbols, refs: ctx.refs, imports: ctx.imports, namespace: ctx.fileNamespace, facts: ctx.facts };
  } finally {
    tree?.delete();
  }
}
