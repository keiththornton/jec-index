# jec-index

An MCP server + Claude Code hook that gives Claude a **persistent, incremental symbol and dependency index** of your repository — so it reads the one function it needs instead of the file, knows who depends on what before it edits, runs only the tests that matter, and writes new code the way the surrounding code is written.

Supports **TypeScript / JavaScript / TSX**, **Python** and **PHP** via tree-sitter WASM grammars plus git. No native build step, no database, no daemon: the index is a JSON file in `.jec-index/` that refreshes itself whenever a tool is called. Nothing is an LLM summary, so nothing drifts.

## Why

Two things eat most of an agentic coding session. **Orientation**: grep, open five files, find the one that matters — and do it again next session. **Blast radius**: edit a shared function and break three callers nobody looked at. They're the same gap from two sides, and both are answered by real program structure:

| Need | Tool | What you get |
|---|---|---|
| Read less | `get_symbol` | One definition's numbered source + callers (with enclosing function and line) + callees resolved to signatures. Usually 1–3% of the file's tokens. |
| | `file_outline` | Imports and every symbol's line range and signature, nested by class. ~20% of reading the file. |
| | `find_symbol` | Exact/fuzzy name lookup → kind, `file:start-end`, signature. |
| | `locate` | Concept search ("billing charge", "belongsTo relation") → ranked files with reasons and exact definitions. |
| Change safely | `impact` | Direct and transitive dependents (with *why*), what it depends on, files that historically change with it, and the **exact test files + commands** to run. |
| | `callers` / `importers` | Every call/new/extends/implements site of a name; every file importing a file (structurally resolved). |
| | `conventions` | What the code actually does in an area: test framework and location, indent/quotes/semicolons, module and export style, naming, error classes thrown, logging — each with example files. |
| Re-orient | `changed_since` | Symbol-level diff vs a git ref: which functions were touched. |
| | `recent` | Uncommitted work, recent commits for a file/dir, co-change affinity, hot files. |
| | `list_files`, `index_status` | Shape of the repo; counts, runners, forced rebuild. |

And the hook: after every `Edit`/`Write` of a source file, it asks the index which tests cover that file, runs only those, and feeds failures straight back to Claude.

Measured cold builds (one core): laravel/framework 3,159 files in 8.4 s, no-op refresh 0.2 s, 34 MB index; psf/requests 0.5 s; expressjs/express 0.6 s. The build runs in the background at startup; tool calls wait for it only if they arrive first.

## Install

Requires Node 20+ and git. The plugin installs its own npm dependencies and builds itself the first time it starts (one-time, ~30 s), so there is no manual build step.

### As a Claude Code plugin (MCP server + hook in one step)

Through the `keith-tools` marketplace, which also carries [node-runtime](https://github.com/keiththornton/node-runtime-mcp) and [deliberate](https://github.com/keiththornton/deliberate):

```bash
claude plugin marketplace add keiththornton/claude-plugins
claude plugin install jec-index@keith-tools --scope user     # or --scope project
```

Or straight from this repository, which is its own single-plugin marketplace:

```bash
claude plugin marketplace add keiththornton/jec-index
claude plugin install jec-index@jec-index --scope user
```

Inside Claude Code the same thing is `/plugin marketplace add keiththornton/claude-plugins` then `/plugin install jec-index@keith-tools`. To try it from a local checkout without installing: `claude --plugin-dir ~/Code/jec-index-server`.

Update later with `claude plugin update jec-index@keith-tools`.

### Manual setup (MCP server only, or server + hook per project)

```bash
git clone https://github.com/keiththornton/jec-index.git ~/Code/jec-index-server
claude mcp add --transport stdio --scope user jec-index -- bash ~/Code/jec-index-server/bin/launch.sh
```

or `.mcp.json` in the project root (see `.mcp.json.example`). For the hook, add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "bash ~/Code/jec-index-server/hooks/post-edit.sh", "timeout": 300 }
        ]
      }
    ]
  }
}
```

The server indexes the git toplevel of its working directory (Claude Code sets cwd to the project root; a monorepo sub-package still gets the whole repo). Pass `--root <dir>` or set `JEC_INDEX_ROOT` to override. Add `.jec-index/` to your `.gitignore` (the server writes a `.gitignore` inside that folder too).

### Nudging Claude to use it

Claude discovers the tools on its own, but a line in `CLAUDE.md` makes the habit stick:

```markdown
Before reading a source file, call jec-index file_outline or get_symbol and only Read the line range you need.
Before editing anything imported elsewhere, call impact and run the tests it lists. Before writing new code in an
unfamiliar directory, call conventions on it. Use locate before grepping.
```

## Examples

`impact Str.slug` on laravel/framework — method-level, so only files that actually call `slug` on `Str` count, not the 241 that import `Str`:

```text
## method Illuminate.Support.Str.slug  [src/Illuminate/Support/Str.php:1661-1684]
   public static function slug($title, $separator = '-', $language = 'en', $dictionary = ['@' => 'at'])
Direct dependents (5):
  src/Illuminate/Foundation/Console/DocsCommand.php  — calls Str.slug
  config/cache.php  — calls Str.slug
  config/database.php  — calls Str.slug
  tests/Console/Scheduling/EventTest.php [test]  — calls Str.slug
  tests/Support/SupportStrTest.php [test]  — calls Str.slug
Transitive dependents (1 more non-test files, 1 tests):
  2 hops: src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php
Tests:
  tests/Console/Scheduling/EventTest.php  — directly calls Str.slug
  tests/Support/SupportStrTest.php  — directly calls Str.slug
Run impacted tests:
  vendor/bin/phpunit tests/Console/Scheduling/EventTest.php tests/Support/SupportStrTest.php
```

`impact` targets: a path, a bare file name (`billing.ts`), a symbol (`BillingService`, `Money.add`), an id from `find_symbol`, or `path:Symbol`; comma-separate several. No target = uncommitted changes; `since: "main"` = the whole branch.

### The hook

The hook runs after **every** tool call, not just `Edit`/`Write`. It refreshes the index and takes the set of source files whose content actually changed — so a shell command that scaffolds ten files, a formatter, or a code generator is covered the same as a hand edit. It then unions the tests covering those files, runs up to `JEC_HOOK_MAX_TESTS` of them (default 12, nearest first), and:

- on success, attaches a one-line note to the tool result (`2 vitest test files passed in 1.1s for src/utils/money.ts`, or `… for 3 changed files (a.ts, b.ts, c.ts)`);
- on failure, exits 2 with a trimmed failure report so Claude fixes it before moving on;
- when nothing covers the changed files, says so — a nudge to add tests.

Tests that passed within the last `JEC_HOOK_DEDUPE_SECONDS` (default 45) are not re-run for a burst of edits to the same area; failures are never deduped. Read-only tools (`Read`, `Grep`, `Glob`, …) and the plugin's own MCP calls are skipped without touching the index. The first run in a repo with no index builds it silently rather than treating every file as changed.

Env: `JEC_HOOK_TIMEOUT` (seconds per command, default 120), `JEC_HOOK_MAX_TESTS`, `JEC_HOOK_DEDUPE_SECONDS`, `JEC_HOOK_DISABLE=1` to turn it off. Runners detected: vitest, jest, mocha, bun test, `node --test`, pytest or unittest, phpunit or pest; package manager from the lockfile.

Every tool call and hook run is appended to `.jec-index/usage.log` (one JSON line each: name, args, duration, result size, outcome), so adoption and value can be measured after the fact.

### CLI

Everything is also available from the shell — handy for checking what Claude will see:

```bash
jec-index index [--rebuild]
jec-index locate "belongsTo relation"
jec-index impact Money.add
jec-index impact --since main
jec-index conventions src/api
jec-index recent lib/router.ts
jec-index tests tests/billing.test.ts      # prints the runner command
```

(`node dist/index.js` with no subcommand serves MCP over stdio, as before.)

## How it works

- **Parsing**: `web-tree-sitter` with the official grammar WASM builds shipped in the `tree-sitter-*` npm packages. Each file is parsed once and the tree is freed immediately. Per file: symbols (with signatures, doc lines, parent), references (call/new/extends/implements with line and enclosing symbol), imports (with imported names), and style facts.
- **Resolution**: TS/JS relative imports (`.js`→`.ts`, index files), `tsconfig`/`jsconfig` `baseUrl` + `paths`, `@/`→`src/`, `require()`, dynamic `import()`, re-exports. Python relative imports and absolute imports against detected source roots. PHP `use` resolved against declared `namespace` + class names first, then composer PSR-4; `require`/`include` with `__DIR__`; trait `use`. `importers` falls back to the older suffix heuristic only when nothing resolves, and says so.
- **Tests**: recognized by convention (`*.test.*`, `*.spec.*`, `__tests__/`, `test_*.py`, `*_test.py`, `conftest.py`, `*Test.php`, `tests/` minus fixtures/helpers) and by framework imports. Coverage is inferred from resolved imports (direct and transitive) and name mapping (`money.test.ts` ↔ `money.ts`, `test_users.py` ↔ `users.py`, `UserServiceTest.php` ↔ `UserService.php`).
- **Freshness**: every tool call does one `stat` per file (coalesced to once per 1.5 s), re-parses only changed files (content-hashed), then re-resolves imports and rebuilds the graph. Index version bumps force a rebuild.

## Limits worth knowing

- Dynamic dispatch, string-based registries, DI containers and reflection are invisible to import analysis. The git co-change signal partly compensates, which is why `impact` shows it alongside.
- Python wildcard imports and unqualified PHP class references in the same namespace resolve coarsely (module-level).
- Only `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.php/.phtml` are indexed.
- The hook runs the test command it builds; if your project needs a wrapper (Docker, `poetry run`), add a shell shim on `PATH` or disable the hook and call `impact` manually.

## Development

```bash
npm install
npm test            # vitest: extraction, resolution, all tools, incremental refresh, MCP over stdio, hook end-to-end
npm run typecheck
npm run smoke       # every tool against test/fixtures/sample over stdio
```

`test/fixtures/sample/` is a small TS + Python + PHP repo; tests copy it to a temp dir so the checked-in fixture is never indexed in place.
