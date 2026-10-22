import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, tempFixture } from "./helpers.js";

const CLI = join(REPO_ROOT, "dist/index.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

let fx: ReturnType<typeof tempFixture>;

function runHook(root: string, toolName: string, toolInput: Record<string, unknown>, env: Record<string, string> = {}) {
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: toolName, tool_input: toolInput, cwd: root });
  const r = spawnSync(process.execPath, [CLI, "hook", "post-edit"], {
    input,
    cwd: root,
    env: { ...process.env, JEC_INDEX_ROOT: root, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const ctx = (r: { stdout: string }) => (r.stdout.trim() ? JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext : "");
const bumpMtime = (p: string) => {
  const t = new Date(Date.now() + 5000);
  utimesSync(p, t, t);
};
const lastLog = (root: string) => {
  const lines = readFileSync(join(root, ".jec-index/usage.log"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
};

describeIfBuilt("post-edit hook (requires `npm run build`)", () => {
  beforeAll(() => {
    fx = tempFixture();
    writeFileSync(join(fx.root, "package.json"), JSON.stringify({ name: "sample", type: "module", devDependencies: { vitest: "*" } }));
    const link = spawnSync("ln", ["-s", join(REPO_ROOT, "node_modules"), join(fx.root, "node_modules")]);
    if (link.status !== 0) throw new Error("could not link node_modules");
    // Prime the index so the first real run only sees the edit under test.
    runHook(fx.root, "Bash", { command: "true" });
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
  });
  afterAll(() => fx.cleanup());

  it("does nothing for read-only tools or when no source file changed", () => {
    const r = runHook(fx.root, "Read", { file_path: "src/utils/money.ts" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const b = runHook(fx.root, "Bash", { command: "ls" });
    expect(b.code).toBe(0);
    expect(b.stdout).toBe("");
    const md = runHook(fx.root, "Write", { file_path: "README.md" });
    expect(md.code).toBe(0);
    expect(md.stdout).toBe("");
  });

  it("runs the impacted tests for an Edit and reports success as additionalContext", () => {
    const p = join(fx.root, "src/utils/money.ts");
    writeFileSync(p, readFileSync(p, "utf8") + "\n// touched\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Edit", { file_path: p });
    expect(r.code, r.stderr).toBe(0);
    expect(ctx(r)).toMatch(/2 vitest test files passed .* for src\/utils\/money\.ts/);
    expect(lastLog(fx.root)).toMatchObject({ outcome: "passed", args: { tool: "Edit", files: ["src/utils/money.ts"] } });
  });

  it("dedupes tests that just passed when the same file is edited again in a burst", () => {
    const p = join(fx.root, "src/utils/money.ts");
    writeFileSync(p, readFileSync(p, "utf8") + "// again\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Edit", { file_path: p });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastLog(fx.root)).toMatchObject({ outcome: "deduped" });
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
  });

  it("picks up files changed by a shell command (no file_path) via the index diff", () => {
    const p = join(fx.root, "src/lib/errors.ts");
    writeFileSync(p, readFileSync(p, "utf8") + "export class QuotaError extends Error {}\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Bash", { command: "sed -i ... src/lib/errors.ts" });
    expect(r.code, r.stderr).toBe(0);
    expect(ctx(r)).toMatch(/vitest test file.* passed .* for src\/lib\/errors\.ts/);
    expect(lastLog(fx.root)).toMatchObject({ outcome: "passed", args: { tool: "Bash", files: ["src/lib/errors.ts"] } });
  });

  it("handles a batch of generated files in one run and names them", () => {
    mkdirSync(join(fx.root, "src/gen"), { recursive: true });
    for (const n of ["a", "b", "c"]) {
      const p = join(fx.root, `src/gen/${n}.ts`);
      writeFileSync(p, `import { Money } from '@/utils/money';\nexport const ${n} = (m: Money) => m.amount;\n`);
      bumpMtime(p);
    }
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
    const r = runHook(fx.root, "Bash", { command: "node scaffold.js" });
    expect(r.code, r.stderr).toBe(0);
    // new files have no tests of their own, so the message is the no-tests nudge naming the batch
    expect(ctx(r)).toMatch(/no tests cover 3 changed files in src\/gen\//);
    expect(lastLog(fx.root).args.files).toEqual(["src/gen/a.ts", "src/gen/b.ts", "src/gen/c.ts"]);
  });

  it("does not run browser/e2e specs; runs the vitest ones and notes the spec", () => {
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
    // billing.ts is covered by tests/billing.test.ts (vitest) and tests/e2e/billing.e2e.spec.ts (playwright)
    const p = join(fx.root, "src/services/billing.ts");
    writeFileSync(p, readFileSync(p, "utf8") + "// e2e\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Edit", { file_path: p });
    expect(r.code, r.stderr).toBe(0);
    const msg = ctx(r);
    expect(msg).toMatch(/vitest test file.* passed .* for src\/services\/billing\.ts/);
    expect(msg).toMatch(/1 browser\/e2e spec not run by the hook/);
    const last = lastLog(fx.root);
    expect(last.args.tests).toEqual(["tests/billing.test.ts"]);
    expect(last.args.e2eSkipped).toEqual(["tests/e2e/billing.e2e.spec.ts"]);
  });

  it("reports e2e-only coverage instead of running it", () => {
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
    const p = join(fx.root, "tests/e2e/billing.e2e.spec.ts");
    writeFileSync(p, readFileSync(p, "utf8") + "// touched\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Edit", { file_path: p });
    expect(r.code, r.stderr).toBe(0);
    expect(ctx(r)).toMatch(/only browser\/e2e suites cover .*billing\.e2e\.spec\.ts/);
    expect(lastLog(fx.root)).toMatchObject({ outcome: "e2e-only" });
  });

  it("reports failures via exit code 2 with a concise summary and does not dedupe them", () => {
    rmSync(join(fx.root, ".jec-index/hook-runs.json"), { force: true });
    const p = join(fx.root, "src/utils/money.ts");
    writeFileSync(p, "export class Money { constructor(public amount: number, public currency: string) {} }\nexport function formatMoney(m: Money) { return 'broken'; }\n");
    bumpMtime(p);
    const r = runHook(fx.root, "Write", { file_path: "src/utils/money.ts" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/FAILED/);
    expect(r.stderr).toContain("src/utils/money.test.ts");
    expect(r.stderr.split("\n").length).toBeLessThan(90);
    // a second run right away must run again (failures are never deduped)
    writeFileSync(p, readFileSync(p, "utf8") + "// still broken\n");
    bumpMtime(p);
    const again = runHook(fx.root, "Edit", { file_path: p });
    expect(again.code).toBe(2);
  });

  it("can be disabled", () => {
    const r = runHook(fx.root, "Edit", { file_path: "src/utils/money.ts" }, { JEC_HOOK_DISABLE: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});
