import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  detectAutoUpdateManager,
  findCommandOnPath,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  isEphemeralCommandPath,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdTimer,
  scheduleDescription,
  serviceLockStatus,
  servicePaths,
  shouldSkipServiceRun,
} from "./service";

describe("backendForPlatform", () => {
  it("selects the native scheduler for supported platforms", () => {
    expect(backendForPlatform("darwin")).toBe("launchd");
    expect(backendForPlatform("linux")).toBe("systemd");
    expect(backendForPlatform("win32")).toBe("windows-task-scheduler");
    expect(backendForPlatform("freebsd")).toBeNull();
  });
});

describe("servicePaths", () => {
  it("places generated files beside the stored CLI config", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).toEqual({
      backend: "launchd",
      configDir: "/tmp/tokenmaxxing",
      definitionPath: "/Users/alex/Library/LaunchAgents/sh.tokenmaxxing.sync.plist",
      lockPath: "/tmp/tokenmaxxing/service.lock",
      logPath: "/tmp/tokenmaxxing/service.log",
      metadataPath: "/tmp/tokenmaxxing/service.json",
      statePath: "/tmp/tokenmaxxing/service-state.json",
      wrapperPath: "/tmp/tokenmaxxing/service-sync.sh",
    });
  });

  it("uses XDG config paths for systemd user units", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing", XDG_CONFIG_HOME: "/home/alex/.xdg" },
      home: "/home/alex",
      platform: "linux",
    });

    expect(paths?.backend).toBe("systemd");
    expect(paths?.definitionPath).toBe("/home/alex/.xdg/systemd/user/tokenmaxxing-sync.service");
  });
});

describe("renderServiceWrapper", () => {
  it("runs sync with a durable command without embedding package-manager updates", () => {
    const env = capturedServiceEnv({
      HOME: "/home/alex",
      PATH: "/usr/local/bin:/usr/bin",
      TOKENMAXXING_API_TOKEN: "tmx_secret",
      TOKENMAXXING_ENV: "development",
    });
    const wrapper = renderServiceWrapper({
      commandPath: "/usr/local/bin/tokenmaxxing",
      env,
      logPath: "/home/alex/.config/tokenmaxxing/service.log",
      platform: "linux",
    });

    expect(wrapper).toContain("'/usr/local/bin/tokenmaxxing' service run --scheduled");
    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).not.toContain("TOKENMAXXING_API_TOKEN");
    expect(wrapper).not.toContain("tmx_secret");
  });

  it("renders the matching auto-update command for each package manager", () => {
    expect(autoUpdateCommandDescription("bun")).toBe(
      "bun update -g @851-labs/tokenmaxxing --latest --silent",
    );
    expect(autoUpdateCommandDescription("npm")).toBe(
      "npm install -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("pnpm")).toBe(
      "pnpm add -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("yarn")).toBe(
      "yarn global add @851-labs/tokenmaxxing@latest --silent",
    );
  });

  it("renders Windows wrappers without package-manager updates", () => {
    const wrapper = renderServiceWrapper({
      commandPath: "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
      env: { PATH: "/usr/bin" },
      logPath: "/tmp/tokenmaxxing.log",
      platform: "win32",
    });

    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).toContain("service run --scheduled");
  });
});

describe("native scheduler templates", () => {
  it("renders launchd and systemd schedules for four daily local times", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).not.toBeNull();
    expect(renderLaunchdPlist(paths!)).toContain("<integer>9</integer>");
    expect(renderLaunchdPlist(paths!)).toContain("<integer>13</integer>");
    expect(renderLaunchdPlist(paths!)).toContain("<integer>17</integer>");
    expect(renderLaunchdPlist(paths!)).toContain("<integer>21</integer>");
    expect(renderSystemdTimer()).toContain("OnCalendar=*-*-* 09:00:00");
    expect(renderSystemdTimer()).toContain("OnCalendar=*-*-* 13:00:00");
    expect(renderSystemdTimer()).toContain("OnCalendar=*-*-* 17:00:00");
    expect(renderSystemdTimer()).toContain("OnCalendar=*-*-* 21:00:00");
    expect(scheduleDescription()).toBe("daily at 09:00, 13:00, 17:00, and 21:00 local time");
  });
});

describe("shouldSkipServiceRun", () => {
  it("skips only when a successful run happened within the last three hours", () => {
    expect(
      shouldSkipServiceRun(
        { lastSuccessAt: "2026-06-16T10:00:00.000Z", version: 1 },
        new Date("2026-06-16T12:59:59.000Z"),
      ),
    ).toBe(true);
    expect(
      shouldSkipServiceRun(
        { lastSuccessAt: "2026-06-16T10:00:00.000Z", version: 1 },
        new Date("2026-06-16T13:00:00.000Z"),
      ),
    ).toBe(false);
    expect(shouldSkipServiceRun(null, new Date("2026-06-16T13:00:00.000Z"))).toBe(false);
  });
});

describe("service lock status", () => {
  it("marks recent locks as active and old locks as stale", () => {
    const recent = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T11:59:59.000Z"),
    );
    const stale = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T12:00:00.000Z"),
    );

    expect(recent.locked).toBe(true);
    expect(recent.stale).toBe(false);
    expect(stale.locked).toBe(true);
    expect(stale.stale).toBe(true);
    expect(formatServiceLockStatus(stale)).toContain("(stale)");
  });
});

describe("formatServiceStatusAutoUpdate", () => {
  it("does not imply auto-update is enabled before service metadata exists", () => {
    expect(formatServiceStatusAutoUpdate(null)).toBe("unknown (service not installed)");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdate: false,
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      }),
    ).toBe("disabled");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdate: true,
        autoUpdateManager: "npm",
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      }),
    ).toBe("enabled via npm");
  });
});

describe("command lookup", () => {
  it("finds an executable tokenmaxxing binary on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-service-"));

    try {
      const binary = join(dir, "tokenmaxxing");
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);

      await expect(
        findCommandOnPath("tokenmaxxing", { PATH: ["/missing", dir].join(delimiter) }, "linux"),
      ).resolves.toBe(binary);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("detects temporary package-runner paths", () => {
    expect(isEphemeralCommandPath("/home/alex/.npm/_npx/123/node_modules/.bin/tokenmaxxing")).toBe(
      true,
    );
    expect(isEphemeralCommandPath("/Users/alex/.bun/install/cache/@851-labs/tokenmaxxing")).toBe(
      true,
    );
    expect(isEphemeralCommandPath("/usr/local/bin/tokenmaxxing")).toBe(false);
  });

  it("detects the package manager for common global install paths", () => {
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.bun/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.bun/install/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("bun");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/homebrew/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/homebrew/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("npm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
        resolvedCommandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
      }),
    ).toBe("pnpm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.yarn/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.config/yarn/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("yarn");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/custom/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/custom/bin/tokenmaxxing",
      }),
    ).toBeNull();
  });
});
