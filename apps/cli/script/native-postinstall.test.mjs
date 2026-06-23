import { describe, expect, it } from "vitest";

import { binaryName, nativePackageNames } from "./native-postinstall.mjs";

describe("native postinstall package selection", () => {
  it("orders linux glibc and musl x64 candidates with baseline fallback", () => {
    expect(nativePackageNames({ arch: "x64", avx2: true, musl: false, platform: "linux" })).toEqual(
      [
        "@851-labs/tokenmaxxing-linux-x64",
        "@851-labs/tokenmaxxing-linux-x64-baseline",
        "@851-labs/tokenmaxxing-linux-x64-musl",
        "@851-labs/tokenmaxxing-linux-x64-baseline-musl",
      ],
    );
    expect(nativePackageNames({ arch: "x64", avx2: false, musl: true, platform: "linux" })).toEqual(
      [
        "@851-labs/tokenmaxxing-linux-x64-baseline-musl",
        "@851-labs/tokenmaxxing-linux-x64-musl",
        "@851-labs/tokenmaxxing-linux-x64-baseline",
        "@851-labs/tokenmaxxing-linux-x64",
      ],
    );
  });

  it("orders darwin and windows native packages with arm64 exact matches", () => {
    expect(nativePackageNames({ arch: "x64", avx2: false, platform: "darwin" })).toEqual([
      "@851-labs/tokenmaxxing-darwin-x64-baseline",
      "@851-labs/tokenmaxxing-darwin-x64",
    ]);
    expect(nativePackageNames({ arch: "arm64", platform: "windows" })).toEqual([
      "@851-labs/tokenmaxxing-windows-arm64",
    ]);
  });

  it("uses native executable names inside target packages", () => {
    expect(binaryName("darwin")).toBe("tokenmaxxing");
    expect(binaryName("linux")).toBe("tokenmaxxing");
    expect(binaryName("windows")).toBe("tokenmaxxing.exe");
  });
});
