import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.js";
import { REPO_ROOT, tempFixture } from "./helpers.js";

const CLI = join(REPO_ROOT, "dist/index.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

let fx: ReturnType<typeof tempFixture>;
beforeAll(() => {
  fx = tempFixture({ git: true });
});
afterAll(() => fx.cleanup());

describeIfBuilt("session-start hook (requires `npm run build`)", () => {
  it("prints project-aware guidance on stdout", () => {
    const r = spawnSync(process.execPath, [CLI, "hook", "session-start"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: fx.root }),
      cwd: fx.root,
      env: { ...process.env, JEC_INDEX_ROOT: fx.root },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\[jec-index\] This repository is indexed: 22 source files \(11 TypeScript, 7 Python, 4 PHP\)/);
    expect(r.stdout).toContain("test runners: vitest, pytest, phpunit");
    expect(r.stdout).toContain("BEFORE editing anything imported elsewhere → impact");
    expect(r.stdout.length).toBeLessThan(2500);
  });

  it("stays silent when disabled or when nothing is indexable", () => {
    const off = spawnSync(process.execPath, [CLI, "hook", "session-start"], { input: "{}", cwd: fx.root, env: { ...process.env, JEC_INDEX_ROOT: fx.root, JEC_SESSION_DISABLE: "1" }, encoding: "utf8" });
    expect(off.stdout).toBe("");
    // a separate temp dir (outside the fixture's git repo, so the root is not widened) with nothing indexable
    const empty = mkdtempSync(join(tmpdir(), "jec-empty-"));
    writeFileSync(join(empty, "notes.md"), "# nothing\n");
    const r = spawnSync(process.execPath, [CLI, "hook", "session-start"], { input: "{}", cwd: empty, env: { ...process.env, JEC_INDEX_ROOT: empty }, encoding: "utf8" });
    rmSync(empty, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("index hygiene on asset-heavy repos", () => {
  it("skips public/, storage/, minified and vendored bundles unless declared as source", async () => {
    mkdirSync(join(fx.root, "public/js/tinymce/themes"), { recursive: true });
    mkdirSync(join(fx.root, "public/css/fontawesome/js"), { recursive: true });
    mkdirSync(join(fx.root, "storage/framework/views"), { recursive: true });
    mkdirSync(join(fx.root, "src/lib/vendor"), { recursive: true });
    writeFileSync(join(fx.root, "public/js/tinymce/themes/theme.js"), "export const t = 1;\n");
    writeFileSync(join(fx.root, "public/css/fontawesome/js/all.min.js"), "export const a=1;\n");
    writeFileSync(join(fx.root, "public/app.js"), "export const app = 1;\n");
    writeFileSync(join(fx.root, "storage/framework/views/x.php"), "<?php echo 1;\n");
    writeFileSync(join(fx.root, "src/lib/vendor/thing.js"), "export const v = 1;\n");
    writeFileSync(join(fx.root, "src/lib/widget.min.js"), "export const w=1;\n");
    writeFileSync(join(fx.root, "src/lib/widget.js"), "export const w = 1;\n");
    const ix = await Indexer.open(fx.root);
    await ix.refresh({ force: true, minIntervalMs: 0 });
    const files = Object.keys(ix.index.files);
    expect(files.some((f) => f.startsWith("public/"))).toBe(false);
    expect(files.some((f) => f.startsWith("storage/"))).toBe(false);
    expect(files).not.toContain("src/lib/vendor/thing.js");
    expect(files).not.toContain("src/lib/widget.min.js");
    expect(files).toContain("src/lib/widget.js");
    expect(files).toContain("src/utils/money.ts");
  });

  it("keeps a root asset dir that the project declares as source", async () => {
    const root = join(fx.root, "declared");
    mkdirSync(join(root, "public/components"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "public" }, include: ["public/**/*.ts"] }));
    writeFileSync(join(root, "public/components/button.ts"), "export const b = 1;\n");
    const ix = await Indexer.open(root);
    await ix.refresh({ force: true, minIntervalMs: 0 });
    expect(Object.keys(ix.index.files)).toContain("public/components/button.ts");
  });

  it("does not invent a JS test runner that is not installed", async () => {
    const root = join(fx.root, "phponly");
    mkdirSync(join(root, "resources/js/lib"), { recursive: true });
    mkdirSync(join(root, "tests/Feature"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "vite", build: "vite build" } }));
    writeFileSync(join(root, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } }, "require-dev": { "phpunit/phpunit": "^11" } }));
    writeFileSync(join(root, "resources/js/lib/util.test.ts"), "export const t = 1;\n"); // a stray *.test.ts without any runner
    writeFileSync(join(root, "tests/Feature/XTest.php"), "<?php\nnamespace Tests\\Feature;\nuse PHPUnit\\Framework\\TestCase;\nclass XTest extends TestCase {}\n");
    const ix = await Indexer.open(root);
    await ix.refresh({ force: true, minIntervalMs: 0 });
    expect(ix.index.config.runners.js).toBeUndefined();
    expect(ix.index.config.runners.php).toBe("phpunit");
  });
});
