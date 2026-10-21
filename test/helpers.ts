import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE = fileURLToPath(new URL("./fixtures/sample", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  })
    .toString()
    .trim();
}

/**
 * Copy the fixture into a temp dir (the index is written inside the project at
 * .jec-index/, so tests never touch the checked-in fixture), optionally as a git repo.
 */
export function tempFixture(opts: { git?: boolean } = {}): { root: string; cleanup: () => void; commit: (msg: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "jec-fx-"));
  cpSync(FIXTURE, root, { recursive: true });
  if (opts.git) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    commit: (msg: string) => {
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", msg);
      return git(root, "rev-parse", "--short", "HEAD");
    },
  };
}
