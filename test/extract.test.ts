import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.js";
import { tempFixture } from "./helpers.js";

let fx: ReturnType<typeof tempFixture>;
let ix: Indexer;

beforeAll(async () => {
  fx = tempFixture();
  ix = await Indexer.open(fx.root);
  await ix.refresh({ force: true, minIntervalMs: 0 });
});
afterAll(() => fx.cleanup());

const entry = (p: string) => {
  const e = ix.index.files[p];
  if (!e) throw new Error(`missing ${p}: have ${Object.keys(ix.index.files).join(", ")}`);
  return e;
};
const sym = (p: string, qualified: string) => entry(p).symbols.find((s) => s.qualified === qualified);

describe("scanner + config", () => {
  it("indexes all three languages and honors .gitignore", () => {
    const files = Object.keys(ix.index.files);
    expect(files).toContain("src/utils/money.ts");
    expect(files).toContain("backend/app/services/users.py");
    expect(files).toContain("php/src/Service/UserService.php");
    expect(files.some((f) => f.startsWith("ignored_dir/"))).toBe(false);
  });

  it("detects tsconfig paths, python roots, PSR-4 and runners", () => {
    const c = ix.index.config;
    expect(c.tsPaths).toEqual({ "@/*": ["src/*"] });
    expect(c.pythonRoots).toContain("backend");
    expect(c.psr4).toEqual({ App: ["php/src"], Tests: ["php/tests"] });
    expect(c.runners).toEqual({ js: "vitest", py: "pytest", php: "phpunit" });
  });
});

describe("typescript", () => {
  it("keeps symbol extraction intact", () => {
    expect(sym("src/utils/money.ts", "Money")).toMatchObject({ kind: "class", exported: true, startLine: 7, endLine: 15 });
    expect(sym("src/utils/money.ts", "Money.add")).toMatchObject({ kind: "method" });
    expect(sym("src/utils/money.ts", "formatMoney")).toMatchObject({ kind: "function", exported: true });
    expect(sym("src/utils/money.ts", "internalHelper")).toMatchObject({ exported: false });
    expect(sym("src/utils/money.ts", "DEFAULT_CURRENCY")).toMatchObject({ kind: "constant" });
  });

  it("records import names and resolves relative, .js-suffixed and tsconfig-path imports", () => {
    const imps = entry("src/services/billing.ts").imports;
    expect(imps.find((i) => i.spec === "@/utils/money")).toMatchObject({ resolved: "src/utils/money.ts", names: ["Money", "formatMoney"] });
    expect(imps.find((i) => i.spec === "../lib/logger.js")).toMatchObject({ resolved: "src/lib/logger.ts", names: ["logger"] });
    expect(imps.find((i) => i.spec === "../lib/errors")).toMatchObject({ resolved: "src/lib/errors.ts" });
    expect(entry("src/api/routes.ts").imports.find((i) => i.spec === "../services/billing")).toMatchObject({ resolved: "src/services/billing.ts", names: ["default"] });
    expect(entry("src/utils/money.test.ts").imports.find((i) => i.spec === "vitest")?.resolved).toBeUndefined();
  });

  it("records throws, loggers, async and style facts", () => {
    const f = entry("src/services/billing.ts").facts;
    expect(f.throws).toEqual({ InsufficientFundsError: 1 });
    expect(f.loggers).toEqual({ logger: 1 });
    expect(f.exportStyle).toBe("mixed");
    expect(f.moduleStyle).toBe("esm");
    expect(f.asyncFunctions).toBe(1);
    expect(f.quotes).toBe("single");
    expect(entry("src/lib/logger.ts").facts.loggers).toEqual({ console: 2 });
  });

  it("marks tests and detects the framework", () => {
    expect(entry("src/utils/money.test.ts")).toMatchObject({ isTest: true, facts: { testFramework: "vitest" } });
    expect(entry("tests/billing.test.ts").isTest).toBe(true);
    expect(entry("src/utils/money.ts").isTest).toBe(false);
  });
});

describe("python", () => {
  it("resolves relative and absolute imports with names", () => {
    const imps = entry("backend/app/services/users.py").imports;
    expect(imps.find((i) => i.spec === "..models")).toMatchObject({ resolved: "backend/app/models.py", names: ["User", "MAX_NAME"] });
    expect(imps.find((i) => i.spec === "app.db")).toMatchObject({ resolved: "backend/app/db.py", names: ["get_session"] });
    expect(imps.find((i) => i.spec === "os.path")?.resolved).toBeUndefined();
    expect(entry("backend/tests/test_users.py").imports.find((i) => i.spec === "app.services.users")?.resolved).toBe("backend/app/services/users.py");
  });

  it("records raises, loggers and test framework", () => {
    expect(entry("backend/app/services/users.py").facts.throws).toEqual({ ValueError: 1 });
    expect(entry("backend/app/db.py").facts.loggers).toMatchObject({ logging: 1, logger: 1 });
    expect(entry("backend/tests/test_users.py")).toMatchObject({ isTest: true, facts: { testFramework: "pytest" } });
  });
});

describe("php", () => {
  it("records the namespace and resolves use statements via declared classes and PSR-4", () => {
    expect(entry("php/src/Repo/UserRepo.php").namespace).toBe("App\\Repo");
    const imps = entry("php/src/Service/UserService.php").imports;
    expect(imps.find((i) => i.spec === "App\\Repo\\UserRepo")).toMatchObject({ resolved: "php/src/Repo/UserRepo.php", names: ["UserRepo"] });
    expect(imps.find((i) => i.spec === "App\\Exceptions\\NotFound")).toMatchObject({ resolved: "php/src/Exceptions/NotFound.php" });
    const test = entry("php/tests/Service/UserServiceTest.php");
    expect(test.imports.find((i) => i.spec === "PHPUnit\\Framework\\TestCase")?.resolved).toBeUndefined();
    expect(test).toMatchObject({ isTest: true, facts: { testFramework: "phpunit" } });
  });

  it("records throws and visibility", () => {
    expect(entry("php/src/Service/UserService.php").facts.throws).toEqual({ NotFound: 1 });
    expect(sym("php/src/Repo/UserRepo.php", "App.Repo.UserRepo.cache")).toMatchObject({ exported: false });
    expect(sym("php/src/Service/UserService.php", "App.Service.UserService.__construct")).toMatchObject({ exported: true });
  });
});
