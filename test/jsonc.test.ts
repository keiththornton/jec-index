import { describe, expect, it } from "vitest";
import { stripJsonComments } from "../src/resolve.js";

describe("stripJsonComments", () => {
  it("handles tsc --init style files with globs containing /* and */", () => {
    const text = `{
  "compilerOptions": {
    /* Visit https://aka.ms/tsconfig */
    // "incremental": true,                              /* Save .tsbuildinfo */
    "skipLibCheck": true /* Skip */,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./resources/js/*"],
      "ziggy-js": ["./vendor/tightenco/ziggy"],
    },
    "x": "a // not a comment",
    "y": "esc \\" quote // still string",
  },
  "include": ["resources/js/**/*.ts", "resources/js/**/*.tsx"],
}`;
    const parsed = JSON.parse(stripJsonComments(text));
    expect(parsed.compilerOptions.paths).toEqual({ "@/*": ["./resources/js/*"], "ziggy-js": ["./vendor/tightenco/ziggy"] });
    expect(parsed.compilerOptions.x).toBe("a // not a comment");
    expect(parsed.compilerOptions.y).toBe('esc " quote // still string');
    expect(parsed.include).toEqual(["resources/js/**/*.ts", "resources/js/**/*.tsx"]);
  });
});
