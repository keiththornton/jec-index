import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, tempFixture } from "./helpers.js";

const CLI = join(REPO_ROOT, "dist/index.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

let fx: ReturnType<typeof tempFixture>;
let client: Client;

describeIfBuilt("MCP server (requires `npm run build`)", () => {
  beforeAll(async () => {
    fx = tempFixture({ git: true });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "--root", fx.root], stderr: "pipe" });
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close();
    fx.cleanup();
  });

  const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

  it("exposes the old and new tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["callers", "changed_since", "conventions", "file_outline", "find_symbol", "get_symbol", "impact", "importers", "index_status", "list_files", "locate", "recent"].sort(),
    );
  });

  it("legacy tools still answer", async () => {
    expect(text(await client.callTool({ name: "find_symbol", arguments: { query: "BillingService" } }))).toContain("src/services/billing.ts:5-16");
    expect(text(await client.callTool({ name: "get_symbol", arguments: { query: "Money.add" } }))).toContain("callers of add");
    expect(text(await client.callTool({ name: "importers", arguments: { path: "money.ts" } }))).toContain("src/services/billing.ts");
    expect(text(await client.callTool({ name: "changed_since", arguments: {} }))).toMatch(/No changes vs HEAD/);
  });

  it("new tools answer over stdio", async () => {
    expect(text(await client.callTool({ name: "locate", arguments: { query: "billing charge" } }))).toContain("src/services/billing.ts");
    expect(text(await client.callTool({ name: "impact", arguments: { target: "Money" } }))).toContain("npx vitest run src/utils/money.test.ts tests/billing.test.ts");
    expect(text(await client.callTool({ name: "conventions", arguments: { area: "php" } }))).toContain("## PHP style");
    expect(text(await client.callTool({ name: "recent", arguments: {} }))).toMatch(/branch: main/);
    expect(text(await client.callTool({ name: "index_status", arguments: {} }))).toContain("runners: js=vitest");
  });
});
