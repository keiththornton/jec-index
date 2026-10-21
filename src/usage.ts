import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 1_000_000;

export interface UsageEvent {
  kind: "tool" | "hook";
  name: string;
  args?: Record<string, unknown>;
  ms: number;
  /** Size of the result handed back, in characters. */
  chars?: number;
  /** Hook outcome: passed | failed | no-tests | skipped */
  outcome?: string;
  detail?: string;
}

export function usageLogPath(root: string): string {
  return path.join(root, ".jec-index", "usage.log");
}

/** Append one JSON line to .jec-index/usage.log; never throws. */
export function recordUsage(root: string, ev: UsageEvent): void {
  try {
    const dir = path.join(root, ".jec-index");
    mkdirSync(dir, { recursive: true });
    const p = usageLogPath(root);
    try {
      if (statSync(p).size > MAX_BYTES) {
        // keep the newest half
        const lines = readFileSync(p, "utf8").split("\n");
        writeFileSync(p, lines.slice(Math.floor(lines.length / 2)).join("\n"));
      }
    } catch {
      /* no file yet */
    }
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...ev }) + "\n");
  } catch {
    /* logging must never break a tool call */
  }
}
