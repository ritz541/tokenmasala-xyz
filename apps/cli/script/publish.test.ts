import { describe, expect, it } from "vitest";

import { createMainPackageJson } from "./publish-manifest";
import { npmDistTagForVersion, parsePublishCliArgs } from "./publish-options";

describe("publish script dist tags", () => {
  it("uses latest for stable versions and the prerelease identifier otherwise", () => {
    expect(npmDistTagForVersion("0.4.18")).toBe("latest");
    expect(npmDistTagForVersion("0.4.18-alpha.0")).toBe("alpha");
    expect(npmDistTagForVersion("0.4.18-beta.2")).toBe("beta");
    expect(npmDistTagForVersion("0.4.18-rc.1")).toBe("rc");
  });

  it("parses an explicit npm dist-tag override", () => {
    expect(
      parsePublishCliArgs(["--dry-run", "--tag", "alpha", "--out-dir", ".tmp/publish"]),
    ).toEqual({
      dryRun: true,
      outDir: ".tmp/publish",
      tag: "alpha",
    });
  });
});

describe("publish script generated main package", () => {
  it("publishes a native CLI installer package with new target optional dependencies", () => {
    const manifest = createMainPackageJson();

    expect(manifest.bin).toEqual({ tokenmaxxing: "./bin/tokenmaxxing.exe" });
    expect(manifest.scripts).toEqual({ postinstall: "node ./postinstall.mjs" });
    expect(manifest.files).toEqual(["bin", "postinstall.mjs", "README.md", "LICENSE"]);
    expect(manifest.optionalDependencies).toHaveProperty("@851-labs/tokenmaxxing-darwin-arm64");
    expect(Object.keys(manifest.optionalDependencies)).not.toContain(
      "@851-labs/tokenmaxxing-service-darwin-arm64",
    );
  });
});
