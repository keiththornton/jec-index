// End-to-end smoke test: spawns the built server over stdio and calls every tool.
//   node dist/smoke.js [project-root]     (default: test/fixtures/sample)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, "..", "test", "fixtures", "sample"));
const serverPath = path.join(here, "index.js");

const client = new Client({ name: "jec-index-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--root", root], stderr: "inherit" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown> = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}  [${Date.now() - t0} ms${res.isError ? ", ERROR" : ""}]\n${content}`);
  return content;
}

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

await call("index_status", { rebuild: true });
await call("list_files", {});
await call("find_symbol", { query: "Money" });
await call("get_symbol", { query: "Money.add" });
await call("callers", { name: "formatMoney" });
await call("file_outline", { path: "src/services/billing.ts" });
await call("importers", { path: "src/utils/money.ts" });
await call("locate", { query: "billing charge" });
await call("impact", { target: "Money" });
await call("impact", { target: "users.py, UserRepo" });
await call("conventions", {});
await call("recent", {});
await call("changed_since", {});

await client.close();
