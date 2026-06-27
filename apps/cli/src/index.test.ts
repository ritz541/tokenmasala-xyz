import { describe, expect, it } from "vitest";

import { isMainModule, normalizeRootVersionArgv } from "./index";

describe("isMainModule", () => {
  it("uses Bun's import.meta.main signal for compiled native executables", () => {
    expect(isMainModule("bun:main", undefined, true)).toBe(true);
  });

  it("falls back to comparing module and argv paths for the Node bundle", () => {
    expect(isMainModule("file:///tmp/tokenmaxxing.js", "/tmp/tokenmaxxing.js", undefined)).toBe(
      true,
    );
  });

  it("does not treat imported modules as the entrypoint", () => {
    expect(isMainModule("file:///tmp/tokenmaxxing.js", "/tmp/other.js", undefined)).toBe(false);
  });
});

describe("normalizeRootVersionArgv", () => {
  it("maps root -v to --version", () => {
    expect(normalizeRootVersionArgv(["-v"])).toEqual(["--version"]);
  });
});
