import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.js";
import { callersOf, findSymbols, fmtOutline, importersOf } from "../src/queries.js";
import { conventions } from "../src/tools/conventions.js";
import { fmtImpact, impact, resolveTarget } from "../src/tools/impact.js";
import { fmtLocate, locate } from "../src/tools/locate.js";
import { recent } from "../src/tools/recent.js";
import { tempFixture } from "./helpers.js";

let fx: ReturnType<typeof tempFixture>;
let ix: Indexer;

const refresh = () => ix.refresh({ minIntervalMs: 0 });
const touch = (p: string) => {
  const t = new Date(Date.now() + 5000);
  utimesSync(p, t, t);
};

beforeAll(async () => {
  fx = tempFixture({ git: true });
  ix = await Indexer.open(fx.root);
  await refresh();
});
afterAll(() => fx.cleanup());

describe("existing tools still work on the merged index", () => {
  it("find_symbol, callers, file_outline", async () => {
    expect(findSymbols(ix.index, "Money.add")[0].symbol.qualified).toBe("Money.add");
    const { hits } = await callersOf(ix, "formatMoney");
    expect(hits.map((h) => h.file).sort()).toEqual(["src/services/billing.ts", "src/utils/money.test.ts"]);
    expect(fmtOutline(ix.index.files["src/utils/money.ts"])).toContain("7-15 class: export class Money");
  });

  it("importers uses structural resolution and reports imported names", () => {
    const hits = importersOf(ix, "src/utils/money.ts");
    expect(hits.map((h) => h.file).sort()).toEqual(["src/api/routes.ts", "src/services/billing.ts", "src/utils/money.test.ts"]);
    expect(hits.find((h) => h.file === "src/services/billing.ts")?.names).toEqual(["Money", "formatMoney"]);
    expect(hits.every((h) => !h.heuristic)).toBe(true);
    expect(importersOf(ix, "php/src/Repo/UserRepo.php").map((h) => h.file).sort()).toEqual(["php/src/Service/UserService.php", "php/tests/Service/UserServiceTest.php"]);
    expect(importersOf(ix, "backend/app/models.py").map((h) => h.file)).toEqual(["backend/app/services/users.py"]);
  });
});

describe("locate", () => {
  it("ranks the defining file first for an exact symbol", () => {
    const r = locate(ix, { query: "Money" });
    expect(r.hits[0].file).toBe("src/utils/money.ts");
    expect(r.definitions[0]).toMatchObject({ name: "Money", kind: "class", file: "src/utils/money.ts" });
    expect(fmtLocate(r)).toContain("src/utils/money.ts:7-15");
  });

  it("finds code from descriptive words, demoting tests", () => {
    const r = locate(ix, { query: "billing charge" });
    expect(r.hits[0].file).toBe("src/services/billing.ts");
    expect(r.hits.find((h) => h.file === "tests/billing.test.ts")?.score ?? 0).toBeLessThan(r.hits[0].score);
    expect(locate(ix, { query: "user service" }).hits[0].file).toBe("php/src/Service/UserService.php");
    expect(locate(ix, { query: "createUser" }).hits[0].file).toBe("backend/app/services/users.py");
  });

  it("respects area and kind filters", () => {
    expect(locate(ix, { query: "user", area: "backend" }).hits.every((h) => h.file.startsWith("backend/"))).toBe(true);
    const k = locate(ix, { query: "zero", kind: "method" });
    expect(k.hits[0].file).toBe("src/utils/money.ts");
    expect(k.hits[0].symbols.every((s) => s.kind === "method")).toBe(true);
    expect(fmtLocate(locate(ix, { query: "zzqqxx" }))).toMatch(/No matches/);
  });
});

describe("impact", () => {
  it("resolves targets flexibly", () => {
    expect(resolveTarget(ix, "src/utils/money.ts")).toEqual({ file: "src/utils/money.ts" });
    expect(resolveTarget(ix, "money.ts")).toEqual({ file: "src/utils/money.ts" });
    expect(resolveTarget(ix, join(fx.root, "src/utils/money.ts"))).toEqual({ file: "src/utils/money.ts" });
    expect(resolveTarget(ix, "Money.add")).toMatchObject({ file: "src/utils/money.ts", symbol: { qualified: "Money.add" } });
    expect(resolveTarget(ix, "src/utils/money.ts:formatMoney")).toMatchObject({ symbol: { name: "formatMoney" } });
    expect(resolveTarget(ix, "src/utils/money.ts#Money.zero")).toMatchObject({ symbol: { qualified: "Money.zero" } });
    expect(resolveTarget(ix, "nothing_here")).toBeUndefined();
  });

  it("reports direct and transitive dependents plus covering tests and commands", async () => {
    const r = await impact(ix, { target: "Money" });
    const t = r.targets[0];
    expect(t.symbol?.name).toBe("Money");
    expect(t.direct.map((d) => d.file).sort()).toEqual(["src/api/routes.ts", "src/services/billing.ts", "src/utils/money.test.ts"]);
    expect(t.transitive.map((x) => x.file)).toContain("src/index.ts");
    expect(r.tests).toEqual(["src/utils/money.test.ts", "tests/billing.test.ts", "tests/e2e/billing.e2e.spec.ts"]);
    expect(r.commands.find((c) => c.runner === "vitest")?.command).toBe("npx vitest run src/utils/money.test.ts tests/billing.test.ts");
    expect(fmtImpact(r)).toContain("Run impacted tests:");
  });

  it("only counts dependents that use the symbol", async () => {
    const r = await impact(ix, { target: "formatMoney" });
    expect(r.targets[0].direct.map((d) => d.file).sort()).toEqual(["src/services/billing.ts", "src/utils/money.test.ts"]);
  });

  it("handles python and php targets with per-language commands", async () => {
    const r = await impact(ix, { target: "users.py, UserRepo" });
    expect(r.targets).toHaveLength(2);
    expect(r.targets[1].symbol?.qualified).toBe("App.Repo.UserRepo");
    expect(r.commands.map((c) => c.command)).toEqual(["python -m pytest -q backend/tests/test_users.py", "vendor/bin/phpunit php/tests/Service/UserServiceTest.php"]);
  });

  it("flags ambiguity instead of guessing", async () => {
    writeFileSync(join(fx.root, "php/src/Repo/PostRepo.php"), "<?php\nnamespace App\\Repo;\nclass PostRepo { public function find(int $id) { return null; } }\n");
    await refresh();
    const r = await impact(ix, { target: "find" });
    expect(r.ambiguous?.length).toBeGreaterThanOrEqual(2);
    expect(fmtImpact(r)).toMatch(/Ambiguous/);
    expect((await impact(ix, { target: "UserRepo.find" })).targets[0].symbol?.qualified).toBe("App.Repo.UserRepo.find");
    rmSync(join(fx.root, "php/src/Repo/PostRepo.php"));
    await refresh();
  });

  it("analyzes uncommitted changes by default and `since` a ref", async () => {
    const p = join(fx.root, "src/lib/errors.ts");
    writeFileSync(p, "export class InsufficientFundsError extends Error {}\nexport class NotFoundError extends Error {}\nexport class RateLimitError extends Error {}\n");
    touch(p);
    await refresh();
    const r = await impact(ix, {});
    expect(r.targets.map((t) => t.file)).toEqual(["src/lib/errors.ts"]);
    expect(r.tests).toContain("tests/billing.test.ts");
    fx.commit("add RateLimitError");
    expect((await impact(ix, { since: "HEAD~1" })).targets.map((t) => t.file)).toEqual(["src/lib/errors.ts"]);
    expect((await impact(ix, {})).targets).toHaveLength(0);
  });

  it("surfaces git co-change hints", async () => {
    for (let i = 0; i < 3; i++) {
      for (const f of ["src/api/routes.ts", "src/index.ts"]) {
        const p = join(fx.root, f);
        writeFileSync(p, `// rev ${i}\n` + readFileSync(p, "utf8"));
        touch(p);
      }
      fx.commit(`touch routes+index ${i}`);
    }
    await refresh();
    const r = await impact(ix, { target: "src/api/routes.ts" });
    expect(r.targets[0].coChanges?.[0].file).toBe("src/index.ts");
    expect(r.targets[0].coChanges?.[0].count).toBe(4); // 3 touches + the initial commit
  });
});

describe("conventions", () => {
  it("reports frameworks, style and evidence, scoped by area", () => {
    const all = conventions(ix);
    expect(all).toContain("Framework: vitest");
    expect(all).toContain("Framework: pytest");
    expect(all).toContain("Framework: phpunit");
    expect(all).toContain("InsufficientFundsError");
    expect(all).toMatch(/Most-imported modules: .*src\/utils\/money\.ts \(3\)/);
    const be = conventions(ix, { area: "backend" });
    expect(be).toContain("## Python style");
    expect(be).not.toContain("## TypeScript style");
    expect(be).toContain("snake_case functions");
    expect(conventions(ix, { area: "nope" })).toMatch(/No indexed files/);
  });
});

describe("recent", () => {
  it("shows commits, co-changes and uncommitted work", async () => {
    mkdirSync(join(fx.root, "src/new"), { recursive: true });
    writeFileSync(join(fx.root, "src/new/thing.ts"), "export const thing = 1;\n");
    const repo = await recent(ix, {});
    expect(repo).toMatch(/branch: main/);
    expect(repo).toContain("touch routes+index 2");
    expect(repo).toContain("src/new/thing.ts");
    expect(repo).toMatch(/Hot files/);
    const file = await recent(ix, { path: "routes.ts", limit: 5 });
    expect(file).toContain("Recent activity for src/api/routes.ts");
    expect(file).toMatch(/Usually changed alongside/);
    expect(file).toContain("src/index.ts");
  });
});

describe("incremental refresh relinks the graph", () => {
  it("picks up new files, edits and deletions", async () => {
    mkdirSync(join(fx.root, "src/reports"), { recursive: true });
    writeFileSync(join(fx.root, "src/reports/summary.ts"), "import { Money } from '@/utils/money';\nexport function summarize(m: Money) { return m.amount; }\n");
    await refresh();
    expect(ix.graph.importers.get("src/utils/money.ts")).toContain("src/reports/summary.ts");
    expect(ix.graph.symbolsByName.get("summarize")?.[0].file).toBe("src/reports/summary.ts");
    rmSync(join(fx.root, "src/reports/summary.ts"));
    await refresh();
    expect(ix.graph.importers.get("src/utils/money.ts")?.has("src/reports/summary.ts")).toBe(false);
    expect(ix.graph.symbolsByName.has("summarize")).toBe(false);
    // survives reload from disk
    const again = await Indexer.open(fx.root);
    expect(again.graph.importers.get("src/utils/money.ts")?.size).toBe(3);
  });
});

describe("per-file test runners", () => {
  it("routes Playwright specs to playwright and keeps them out of the vitest command", async () => {
    const r = await impact(ix, { target: "BillingService" });
    expect(r.tests).toContain("tests/e2e/billing.e2e.spec.ts");
    const vitest = r.commands.find((c) => c.runner === "vitest")!;
    const pw = r.commands.find((c) => c.runner === "playwright")!;
    expect(vitest.command).not.toContain("e2e");
    expect(pw).toMatchObject({ e2e: true, files: ["tests/e2e/billing.e2e.spec.ts"] });
    expect(pw.command).toBe("npx playwright test tests/e2e/billing.e2e.spec.ts");
    expect(ix.index.files["tests/e2e/billing.e2e.spec.ts"].facts.testFramework).toBe("playwright");
  });
});
