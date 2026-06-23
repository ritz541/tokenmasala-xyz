#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const targetBinary = path.join(__dirname, "bin", "tokenmaxxing.exe");
let packageJsonCache;

function detectPlatform(value = os.platform()) {
  return (
    {
      darwin: "darwin",
      linux: "linux",
      win32: "windows",
    }[value] ?? value
  );
}

function detectArch(value = os.arch()) {
  return (
    {
      arm64: "arm64",
      x64: "x64",
    }[value] ?? value
  );
}

function binaryName(platform = detectPlatform()) {
  return platform === "windows" ? "tokenmaxxing.exe" : "tokenmaxxing";
}

function supportsAvx2(options = {}) {
  const arch = options.arch ?? detectArch();
  const platform = options.platform ?? detectPlatform();
  if (arch !== "x64") return false;

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      });
      return result.status === 0 && (result.stdout || "").trim() === "1";
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(
          executable,
          ["-NoProfile", "-NonInteractive", "-Command", command],
          {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          },
        );
        if (result.status !== 0) continue;
        const output = (result.stdout || "").trim().toLowerCase();
        if (output === "true" || output === "1") return true;
        if (output === "false" || output === "0") return false;
      } catch {
        continue;
      }
    }
  }

  return false;
}

function isMusl(platform = detectPlatform()) {
  if (platform !== "linux") return false;

  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {
    return false;
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

function nativePackageNames(options = {}) {
  const platform = options.platform ?? detectPlatform();
  const arch = options.arch ?? detectArch();
  const musl = options.musl ?? isMusl(platform);
  const baseline = arch === "x64" && !(options.avx2 ?? supportsAvx2({ arch, platform }));
  const base = `@851-labs/tokenmaxxing-${platform}-${arch}`;

  if (platform === "linux") {
    if (arch === "arm64") {
      return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
    }

    if (arch === "x64" && musl) {
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
    }

    if (arch === "x64") {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }
  }

  if (arch === "x64") {
    return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  }

  if (arch === "arm64") {
    return [base];
  }

  return [];
}

function resolveBinary(packageName, sourceBinary = binaryName()) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath}`);
  }
  return binaryPath;
}

function copyBinary(source, target = targetBinary) {
  if (!fs.existsSync(source)) {
    throw new Error(`Binary not found at ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
  fs.chmodSync(target, 0o755);
}

function installPackage(packageName, sourceBinary = binaryName()) {
  const packageJson = readPackageJson();
  const version = packageJson.optionalDependencies?.[packageName];
  if (typeof version !== "string" || version.length === 0) {
    return false;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmaxxing-install-"));
  try {
    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--loglevel=error",
        "--prefix",
        temp,
        `${packageName}@${version}`,
      ],
      { stdio: "inherit", windowsHide: true },
    );
    if (result.status !== 0) {
      return false;
    }

    copyBinary(path.join(temp, "node_modules", packageName, "bin", sourceBinary));
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function readPackageJson() {
  if (packageJsonCache !== undefined) {
    return packageJsonCache;
  }

  for (const packageJsonPath of [
    path.join(__dirname, "package.json"),
    path.join(__dirname, "..", "package.json"),
  ]) {
    try {
      packageJsonCache = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return packageJsonCache;
    } catch {
      continue;
    }
  }

  throw new Error("Unable to read @851-labs/tokenmaxxing package.json");
}

function verifyBinary(target = targetBinary) {
  const result = childProcess.spawnSync(target, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0;
}

function installNativeBinary() {
  const packages = nativePackageNames();
  const sourceBinary = binaryName();

  for (const packageName of packages) {
    try {
      copyBinary(resolveBinary(packageName, sourceBinary));
      if (verifyBinary()) return;
    } catch {
      if (installPackage(packageName, sourceBinary) && verifyBinary()) return;
    }
  }

  throw new Error(
    `It seems your package manager failed to install the right tokenmaxxing native package. Try manually installing ${packages
      .map((packageName) => JSON.stringify(packageName))
      .join(" or ")}.`,
  );
}

function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  return argv1 !== undefined && path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1);
}

if (isMainModule()) {
  try {
    installNativeBinary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  binaryName,
  detectArch,
  detectPlatform,
  installNativeBinary,
  isMainModule,
  isMusl,
  nativePackageNames,
  readPackageJson,
  supportsAvx2,
};
