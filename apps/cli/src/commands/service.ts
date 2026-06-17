import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ClockService, ConfigService, ConsoleService } from "../services";
import { getConfigPath } from "../services/config";
import { resolveSyncAuth, syncEffect } from "./sync";

const execFilePromise = promisify(execFile);

const SERVICE_LABEL = "sh.tokenmaxxing.sync";
const SYSTEMD_NAME = "tokenmaxxing-sync";
const WINDOWS_TASK_NAME = "tokenmaxxing-sync";
const POSIX_WRAPPER_NAME = "tokenmaxxing.sh";
const LEGACY_POSIX_WRAPPER_NAME = "service-sync.sh";
const WINDOWS_WRAPPER_NAME = "service-sync.cmd";
const PACKAGE_NAME = "@851-labs/tokenmaxxing";
const SERVICE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const SERVICE_INTERVAL_SECONDS = 60 * 60;
const SERVICE_JITTER_MAX_MS = 10 * 60 * 1000;
const LEGACY_SCHEDULE_TIMES: readonly ScheduleTime[] = [
  { hour: 9, minute: 0 },
  { hour: 13, minute: 0 },
  { hour: 17, minute: 0 },
  { hour: 21, minute: 0 },
];

type ServiceBackend = "launchd" | "systemd" | "windows-task-scheduler";
type AutoUpdateManager = "bun" | "npm" | "pnpm" | "yarn";

interface CommandInstall {
  autoUpdateManager: AutoUpdateManager | null;
  commandPath: string;
  resolvedCommandPath: string;
}

interface ScheduleTime {
  hour: number;
  minute: number;
}

interface ServiceInstallOptions {
  autoUpdate: boolean;
  force: boolean;
  refresh: boolean;
}

interface ServicePaths {
  backend: ServiceBackend;
  configDir: string;
  definitionPath: string | null;
  lockPath: string;
  logPath: string;
  metadataPath: string;
  statePath: string;
  wrapperPath: string;
}

interface ServiceLock {
  acquiredAt: string;
  ownerId: string;
  pid: number;
  version: 1;
}

type ServiceRunLock =
  | {
      lock: ServiceLock;
      _tag: "acquired";
    }
  | {
      status: ServiceLockStatus;
      _tag: "locked";
    };

type ServiceLockStatus =
  | {
      locked: false;
      stale: false;
    }
  | {
      acquiredAt?: string;
      ageMs?: number;
      locked: true;
      pid?: number;
      stale: boolean;
    };

interface ServiceMetadata {
  autoUpdate: boolean;
  autoUpdateManager?: AutoUpdateManager | null;
  backend: ServiceBackend;
  commandPath: string;
  resolvedCommandPath?: string | undefined;
  installedAt: string;
  schedule: string;
  version: 1;
}

interface ServiceRunOptions {
  force: boolean;
  scheduled: boolean;
}

interface ServiceState {
  lastAttemptAt?: string;
  lastError?: string;
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  version: 1;
}

type DoctorAuthConfig =
  | {
      cause: unknown;
      _tag: "error";
    }
  | {
      value: {
        deviceId?: string;
        token?: string;
      };
      _tag: "success";
    };

type DoctorStatus = "info" | "ok" | "warn";

class ServiceUnsupportedPlatformError extends Data.TaggedError("ServiceUnsupportedPlatformError")<{
  readonly platform: NodeJS.Platform;
}> {
  override get message() {
    return `error: service install is not supported on ${this.platform}\nhint: supported platforms are macOS, Linux, and Windows`;
  }
}

class ServiceEnvTokenError extends Data.TaggedError("ServiceEnvTokenError")<{}> {
  override message =
    "error: service install needs a stored login, not TOKENMAXXING_API_TOKEN\nhint: unset TOKENMAXXING_API_TOKEN, run tokenmaxxing login, then run tokenmaxxing service install";
}

class ServiceCommandNotFoundError extends Data.TaggedError("ServiceCommandNotFoundError")<{}> {
  override message =
    "error: tokenmaxxing is not installed globally\nhint: install it with bun, npm, pnpm, or yarn, then run tokenmaxxing service install";
}

class ServiceEphemeralCommandError extends Data.TaggedError("ServiceEphemeralCommandError")<{
  readonly commandPath: string;
}> {
  override get message() {
    return `error: tokenmaxxing resolved to a temporary runner path\npath: ${this.commandPath}\nhint: install it globally with bun, npm, pnpm, or yarn, then run tokenmaxxing service install`;
  }
}

class ServiceAutoUpdateManagerError extends Data.TaggedError("ServiceAutoUpdateManagerError")<{
  readonly commandPath: string;
  readonly resolvedCommandPath: string;
}> {
  override get message() {
    return `error: could not detect how tokenmaxxing was globally installed\npath: ${this.commandPath}\nresolved path: ${this.resolvedCommandPath}\nhint: reinstall with bun, npm, pnpm, or yarn; or run tokenmaxxing service install --no-auto-update`;
  }
}

class ServiceInstallError extends Data.TaggedError("ServiceInstallError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to install tokenmaxxing service\nhint: rerun with --verbose or install manually from the generated files";
}

class ServiceUninstallError extends Data.TaggedError("ServiceUninstallError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to uninstall tokenmaxxing service\nhint: rerun with --verbose and remove the scheduler entry manually";
}

class ServiceRunError extends Data.TaggedError("ServiceRunError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: tokenmaxxing service run failed\nhint: inspect the service log for details";
}

class ServiceNotInstalledError extends Data.TaggedError("ServiceNotInstalledError")<{}> {
  override message =
    "error: tokenmaxxing service is not installed\nhint: run tokenmaxxing service install first";
}

const installCommand = Command.make(
  "install",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Install even if the tokenmaxxing binary path looks temporary"),
    ),
    noAutoUpdate: Flag.boolean("no-auto-update").pipe(
      Flag.withDescription("Disable automatic CLI updates before scheduled syncs"),
    ),
    refresh: Flag.boolean("refresh").pipe(Flag.withHidden),
  },
  ({ force, noAutoUpdate, refresh }) =>
    serviceInstallEffect({ autoUpdate: !noAutoUpdate, force, refresh }),
).pipe(Command.withDescription("Install daily automatic sync"));

const uninstallCommand = Command.make("uninstall", {}, () => serviceUninstallEffect()).pipe(
  Command.withDescription("Uninstall daily automatic sync"),
);

const statusCommand = Command.make("status", {}, () => serviceStatusEffect()).pipe(
  Command.withDescription("Show automatic sync service status"),
);

const doctorCommand = Command.make("doctor", {}, () => serviceDoctorEffect()).pipe(
  Command.withDescription("Check automatic sync service health"),
);

const runCommand = Command.make(
  "run",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Run even if the last scheduled sync recently succeeded"),
    ),
    scheduled: Flag.boolean("scheduled").pipe(Flag.withHidden),
  },
  ({ force, scheduled }) => serviceRunEffect({ force, scheduled }),
).pipe(Command.withDescription("Run the automatic sync job now"));

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage daily automatic sync"),
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    statusCommand,
    doctorCommand,
    runCommand,
  ]),
);

function serviceInstallEffect(options: ServiceInstallOptions) {
  return serviceInstallProgram(options);
}

function serviceInstallProgram(
  options: ServiceInstallOptions,
  runtime: {
    env?: Record<string, string | undefined>;
    findCommandInstall?: () => Effect.Effect<CommandInstall | null, unknown>;
    home?: string;
    installScheduler?: (paths: ServicePaths) => Effect.Effect<void, unknown>;
    now?: Date;
    platform?: NodeJS.Platform;
    writeFiles?: (
      paths: ServicePaths,
      wrapper: string,
      metadata: ServiceMetadata,
    ) => Effect.Effect<void, unknown>;
  } = {},
) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);

    if (!options.refresh && (yield* config.hasEnvToken())) {
      return yield* Effect.fail(new ServiceEnvTokenError());
    }

    if (!options.refresh) {
      yield* resolveSyncAuth({ json: false });
    }

    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const paths = yield* servicePathsEffect(env, runtime.home, platform);
    const commandInstall = yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((install) =>
        install === null ? Effect.fail(new ServiceCommandNotFoundError()) : Effect.succeed(install),
      ),
    );
    const commandPath = commandInstall.commandPath;
    if (!options.force && isEphemeralCommandPath(commandPath)) {
      return yield* Effect.fail(new ServiceEphemeralCommandError({ commandPath }));
    }
    if (options.autoUpdate && commandInstall.autoUpdateManager === null) {
      return yield* Effect.fail(
        new ServiceAutoUpdateManagerError({
          commandPath,
          resolvedCommandPath: commandInstall.resolvedCommandPath,
        }),
      );
    }

    const serviceEnv = capturedServiceEnv(env);
    const wrapper = renderServiceWrapper({
      commandPath,
      env: serviceEnv,
      logPath: paths.logPath,
      platform,
    });
    const metadata: ServiceMetadata = {
      autoUpdate: options.autoUpdate,
      autoUpdateManager: commandInstall.autoUpdateManager,
      backend: paths.backend,
      commandPath,
      resolvedCommandPath: commandInstall.resolvedCommandPath,
      installedAt: (runtime.now ?? new Date()).toISOString(),
      schedule: scheduleDescription(),
      version: 1,
    };

    yield* (runtime.writeFiles ?? writeServiceFiles)(paths, wrapper, metadata).pipe(
      Effect.mapError((cause) => new ServiceInstallError({ cause })),
    );
    yield* (runtime.installScheduler ?? installNativeScheduler)(paths).pipe(
      Effect.mapError((cause) => new ServiceInstallError({ cause })),
    );

    yield* Effect.sync(() => {
      console.log("Automatic sync installed.");
      console.log(`Schedule: ${scheduleDescription()}`);
      console.log(`Backend: ${paths.backend}`);
      console.log(`Log: ${paths.logPath}`);
      console.log(
        `Auto-update: ${options.autoUpdate ? `enabled via ${commandInstall.autoUpdateManager}` : "disabled"}${
          options.autoUpdate
            ? ` (${autoUpdateCommandDescription(commandInstall.autoUpdateManager!)})`
            : ""
        }`,
      );
    });
  });
}

function serviceUninstallEffect() {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();

    yield* uninstallNativeScheduler(paths).pipe(
      Effect.mapError((cause) => new ServiceUninstallError({ cause })),
    );
    yield* removeServiceFiles(paths).pipe(
      Effect.mapError((cause) => new ServiceUninstallError({ cause })),
    );

    yield* Effect.sync(() => {
      console.log("Automatic sync uninstalled.");
      console.log("Auth and synced usage were left untouched.");
    });
  });
}

function serviceStatusEffect() {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();
    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const state = yield* readServiceState(paths.statePath);
    const installed = yield* isServiceInstalled(paths);
    const now = new Date();
    const lockStatus = yield* readServiceLockStatus(paths.lockPath, now);

    yield* Effect.sync(() => {
      console.log(`Installed: ${installed ? "yes" : "no"}`);
      console.log(`Backend: ${paths.backend}`);
      console.log(`Schedule: ${metadata?.schedule ?? scheduleDescription()}`);
      console.log(`Auto-update: ${formatServiceStatusAutoUpdate(metadata)}`);
      console.log(`Last success: ${state?.lastSuccessAt ?? "never"}`);
      console.log(`Last success date: ${serviceLastSuccessDate(state) ?? "never"}`);
      console.log(`Today synced: ${shouldSkipServiceRun(state, now) ? "yes" : "no"}`);
      if (state?.lastError !== undefined) {
        console.log(`Last error: ${state.lastError}`);
      }
      console.log(`Lock: ${formatServiceLockStatus(lockStatus)}`);
      console.log(`Wrapper: ${paths.wrapperPath}`);
      console.log(`Log: ${paths.logPath}`);
    });
  });
}

function serviceRunEffect(options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();
    const lock = yield* acquireServiceRunLock(paths.lockPath, new Date()).pipe(
      Effect.mapError((cause) => new ServiceRunError({ cause })),
    );

    if (lock._tag === "locked") {
      yield* Effect.sync(() => {
        console.log(formatServiceLockSkip(lock.status));
      });
      return;
    }

    return yield* runServiceSyncOnce(paths, options).pipe(
      Effect.ensuring(releaseServiceRunLock(paths.lockPath, lock.lock.ownerId)),
    );
  });
}

function serviceDoctorEffect() {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();
    const now = new Date();

    const envToken = yield* config.hasEnvToken();
    const authConfig = yield* config.readConfig().pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "error" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    );
    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const state = yield* readServiceState(paths.statePath);
    const installed = yield* isServiceInstalled(paths);
    const wrapperExists = yield* fileExists(paths.wrapperPath);
    const definitionExists =
      paths.definitionPath === null ? installed : yield* fileExists(paths.definitionPath);
    const metadataCommandExists =
      metadata?.commandPath === undefined ? false : yield* fileExists(metadata.commandPath);
    const currentCommand = yield* findTokenmaxxingCommandInstall().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const autoUpdateManager =
      metadata === null
        ? undefined
        : (metadata.autoUpdateManager ?? currentCommand?.autoUpdateManager);
    const autoUpdateManagerExists =
      autoUpdateManager === undefined || autoUpdateManager === null
        ? false
        : yield* commandExists(autoUpdateManager);
    const lockStatus = yield* readServiceLockStatus(paths.lockPath, now);
    const logTail = yield* readLogTail(paths.logPath, 8);

    const lines = [
      doctorLine(
        installed ? "ok" : "warn",
        "scheduler",
        installed ? `installed (${paths.backend})` : `not installed (${paths.backend})`,
      ),
      doctorLine(
        definitionExists ? "ok" : "warn",
        "definition",
        paths.definitionPath ?? "tracked by Windows Task Scheduler metadata",
      ),
      doctorLine(wrapperExists ? "ok" : "warn", "wrapper", paths.wrapperPath),
      doctorLine(metadata === null ? "warn" : "ok", "metadata", paths.metadataPath),
      doctorLine(
        envToken ? "warn" : authConfig._tag === "success" && authConfig.value.token ? "ok" : "warn",
        "auth",
        doctorAuthDetail(envToken, authConfig),
      ),
      doctorLine(
        metadataCommandExists ? "ok" : currentCommand === null ? "warn" : "ok",
        "binary",
        doctorBinaryDetail(metadata, metadataCommandExists, currentCommand),
      ),
      doctorLine(
        doctorAutoUpdateStatus(metadata, autoUpdateManagerExists),
        "auto-update",
        doctorAutoUpdateDetail(metadata, autoUpdateManager, autoUpdateManagerExists),
      ),
      doctorLine(
        lockStatus.locked && !lockStatus.stale ? "warn" : "ok",
        "lock",
        formatServiceLockStatus(lockStatus),
      ),
      doctorLine(
        state?.lastSuccessAt === undefined ? "info" : "ok",
        "last success",
        state?.lastSuccessAt ?? "never",
      ),
      doctorLine(
        serviceLastSuccessDate(state) === undefined ? "info" : "ok",
        "success date",
        serviceLastSuccessDate(state) ?? "never",
      ),
      doctorLine(
        shouldSkipServiceRun(state, now) ? "ok" : "info",
        "today synced",
        shouldSkipServiceRun(state, now) ? "yes" : "no",
      ),
      doctorLine(
        state?.lastError === undefined ? "ok" : "warn",
        "last error",
        state?.lastError ?? "none",
      ),
    ];

    yield* Effect.sync(() => {
      console.log("Service doctor");
      for (const line of lines) {
        console.log(line);
      }

      if (logTail.length > 0) {
        console.log("");
        console.log("Recent log:");
        for (const line of logTail) {
          console.log(`  ${line}`);
        }
      }
    });
  });
}

function runServiceSyncOnce(paths: ServicePaths, options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);
    const state = yield* readServiceState(paths.statePath);
    const currentState = state ?? { version: 1 as const };
    const now = new Date();

    if (!options.force && shouldSkipServiceRun(state, now)) {
      yield* Effect.sync(() => {
        console.log("Sync skipped; today already synced.");
      });
      return;
    }

    if (options.scheduled) {
      const stored = yield* config.readConfig();
      const jitterMs =
        stored.deviceId === undefined ? 0 : deterministicServiceJitterMs(stored.deviceId);
      if (jitterMs > 0) {
        yield* clock.sleep(jitterMs).pipe(Effect.catch(() => Effect.void));
      }
    }

    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const autoUpdated = yield* runServiceAutoUpdate(metadata);

    yield* writeServiceState(paths.statePath, {
      ...currentState,
      lastAttemptAt: now.toISOString(),
      lastError: undefined,
      version: 1,
    }).pipe(Effect.mapError((cause) => new ServiceRunError({ cause })));

    const result = yield* syncEffect({ dryRun: false, json: true }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: () => ({ _tag: "success" as const }),
      }),
    );

    if (result._tag === "failure") {
      yield* writeServiceState(paths.statePath, {
        ...currentState,
        lastAttemptAt: now.toISOString(),
        lastError: String(result.cause),
        version: 1,
      }).pipe(Effect.ignore);
      return yield* Effect.fail(new ServiceRunError({ cause: result.cause }));
    }

    const successAt = new Date().toISOString();
    yield* writeServiceState(paths.statePath, {
      ...currentState,
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: successAt,
      lastSuccessDate: localDateKey(new Date(successAt)),
      version: 1,
    }).pipe(Effect.mapError((cause) => new ServiceRunError({ cause })));

    if (autoUpdated && metadata !== null) {
      yield* refreshServiceAfterUpdate({
        autoUpdate: metadata.autoUpdate,
        commandPath: metadata.commandPath,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            console.log("Service refresh failed after auto-update.");
          }),
        ),
      );
    }

    if (!options.scheduled) {
      yield* Effect.sync(() => {
        console.log("Service run complete.");
        console.log(`Log: ${paths.logPath}`);
      });
    }
  });
}

function shouldSkipServiceRun(state: ServiceState | null, now: Date): boolean {
  return serviceLastSuccessDate(state) === localDateKey(now);
}

function serviceLastSuccessDate(state: ServiceState | null): string | undefined {
  if (state?.lastSuccessDate !== undefined) {
    return state.lastSuccessDate;
  }

  if (state?.lastSuccessAt === undefined) {
    return undefined;
  }

  const lastSuccessAt = new Date(state.lastSuccessAt);

  return Number.isNaN(lastSuccessAt.getTime()) ? undefined : localDateKey(lastSuccessAt);
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function deterministicServiceJitterMs(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0) % (SERVICE_JITTER_MAX_MS + 1);
}

function acquireServiceRunLock(path: string, now: Date): Effect.Effect<ServiceRunLock, unknown> {
  return Effect.tryPromise({
    try: () => acquireServiceRunLockFile(path, now),
    catch: (cause) => cause,
  });
}

async function acquireServiceRunLockFile(path: string, now: Date): Promise<ServiceRunLock> {
  await mkdir(dirname(path), { recursive: true });
  const lock = serviceLockJson(now);
  const acquired = await tryWriteServiceLock(path, lock);
  if (acquired) {
    return { _tag: "acquired", lock };
  }

  const status = await readServiceLockStatusFile(path, now);
  if (status.locked && status.stale) {
    await rm(path, { force: true });
    const staleReplacementLock = serviceLockJson(now);
    if (await tryWriteServiceLock(path, staleReplacementLock)) {
      return { _tag: "acquired", lock: staleReplacementLock };
    }
  }

  return { _tag: "locked", status: await readServiceLockStatusFile(path, now) };
}

async function tryWriteServiceLock(path: string, lock: ServiceLock): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw cause;
  }
}

function releaseServiceRunLock(path: string, ownerId: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const status = await readServiceLockFile(path);
      if (status?.ownerId === ownerId) {
        await rm(path, { force: true });
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void));
}

function readServiceLockStatus(path: string, now: Date): Effect.Effect<ServiceLockStatus, never> {
  return Effect.tryPromise({
    try: () => readServiceLockStatusFile(path, now),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(noServiceLockStatus())));
}

async function readServiceLockStatusFile(path: string, now: Date): Promise<ServiceLockStatus> {
  const lock = await readServiceLockFile(path);
  if (lock === null) {
    return noServiceLockStatus();
  }

  return serviceLockStatus(lock, now);
}

async function readServiceLockFile(path: string): Promise<ServiceLock | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServiceLock;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return {
      acquiredAt: "",
      ownerId: "",
      pid: 0,
      version: 1,
    };
  }
}

function serviceLockJson(now: Date): ServiceLock {
  return {
    acquiredAt: now.toISOString(),
    ownerId: `${process.pid}:${now.toISOString()}:${crypto.randomUUID()}`,
    pid: process.pid,
    version: 1,
  };
}

function noServiceLockStatus(): ServiceLockStatus {
  return { locked: false, stale: false };
}

function serviceLockStatus(lock: ServiceLock, now: Date): ServiceLockStatus {
  const acquiredAt = Date.parse(lock.acquiredAt);
  if (Number.isNaN(acquiredAt)) {
    return {
      acquiredAt: lock.acquiredAt || undefined,
      locked: true,
      pid: lock.pid || undefined,
      stale: true,
    };
  }

  const ageMs = Math.max(0, now.getTime() - acquiredAt);

  return {
    acquiredAt: lock.acquiredAt,
    ageMs,
    locked: true,
    pid: lock.pid,
    stale: ageMs >= SERVICE_LOCK_STALE_MS,
  };
}

function formatServiceLockSkip(status: ServiceLockStatus): string {
  if (!status.locked) {
    return "Sync skipped; service run is already in progress.";
  }

  return `Sync skipped; service run is already in progress${formatServiceLockSince(status)}.`;
}

function formatServiceLockStatus(status: ServiceLockStatus): string {
  if (!status.locked) {
    return "none";
  }

  return `held${formatServiceLockSince(status)}${status.stale ? " (stale)" : ""}`;
}

function formatServiceLockSince(status: Extract<ServiceLockStatus, { locked: true }>): string {
  const parts: string[] = [];
  if (status.acquiredAt !== undefined && status.acquiredAt !== "") {
    parts.push(`since ${status.acquiredAt}`);
  }
  if (status.pid !== undefined && status.pid !== 0) {
    parts.push(`pid ${status.pid}`);
  }

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function readServiceState(path: string): Effect.Effect<ServiceState | null, never> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as ServiceState,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function writeServiceState(path: string, state: ServiceState): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(serviceStateJson(state), null, 2)}\n`);
    },
    catch: (cause) => cause,
  });
}

function serviceStateJson(state: ServiceState): Partial<ServiceState> {
  return {
    ...(state.lastAttemptAt === undefined ? {} : { lastAttemptAt: state.lastAttemptAt }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastSuccessDate === undefined ? {} : { lastSuccessDate: state.lastSuccessDate }),
    version: state.version,
  };
}

function commandExists(command: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => (await findCommandOnPath(command, process.env, process.platform)) !== null,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function runServiceAutoUpdate(
  metadata: ServiceMetadata | null,
): Effect.Effect<boolean, never, ConsoleService> {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);

    if (metadata === null || metadata.autoUpdate === false) {
      return false;
    }

    const manager = metadata.autoUpdateManager;
    if (manager === undefined || manager === null) {
      yield* Effect.sync(() => {
        console.log("Auto-update skipped; package manager was not detected.");
      });
      return false;
    }

    const managerExists = yield* commandExists(manager);
    if (!managerExists) {
      yield* Effect.sync(() => {
        console.log(`Auto-update skipped; ${manager} not found.`);
      });
      return false;
    }

    return yield* runPackageManagerUpdate(manager).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.sync(() => {
          console.log(`Auto-update failed; continuing with sync.`);
          return false;
        }),
      ),
    );
  });
}

function runPackageManagerUpdate(manager: AutoUpdateManager): Effect.Effect<void, unknown> {
  const command = autoUpdateCommand(manager);

  return runExecutable(command.command, command.args);
}

function refreshServiceAfterUpdate(options: {
  autoUpdate: boolean;
  commandPath: string;
}): Effect.Effect<void, unknown> {
  const args = ["service", "install", "--refresh"];
  if (!options.autoUpdate) {
    args.push("--no-auto-update");
  }

  return runExecutable(options.commandPath, args);
}

function readLogTail(path: string, maxLines: number): Effect.Effect<string[], never> {
  return Effect.tryPromise({
    try: async () => {
      const lines = (await readFile(path, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      return lines.slice(-maxLines);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed([])));
}

function doctorLine(status: DoctorStatus, label: string, detail: string): string {
  return `${status.toUpperCase().padEnd(4)} ${label.padEnd(12)} ${detail}`;
}

function formatServiceStatusAutoUpdate(metadata: ServiceMetadata | null): string {
  if (metadata === null) {
    return "unknown (service not installed)";
  }

  if (metadata.autoUpdate === false) {
    return "disabled";
  }

  if (metadata.autoUpdateManager !== undefined && metadata.autoUpdateManager !== null) {
    return `enabled via ${metadata.autoUpdateManager}`;
  }

  return "enabled";
}

function doctorAuthDetail(envToken: boolean, authConfig: DoctorAuthConfig): string {
  if (envToken) {
    return "TOKENMAXXING_API_TOKEN is set; service install needs stored login instead";
  }

  if (authConfig._tag === "error") {
    return `could not read config (${String(authConfig.cause)})`;
  }

  if (!authConfig.value.token) {
    return "stored token missing; run tokenmaxxing login";
  }

  return authConfig.value.deviceId === undefined
    ? "stored token present; device id will be created on next sync"
    : "stored token and device id present";
}

function doctorBinaryDetail(
  metadata: ServiceMetadata | null,
  metadataCommandExists: boolean,
  currentCommand: CommandInstall | null,
): string {
  if (metadata?.commandPath !== undefined) {
    return metadataCommandExists
      ? `${metadata.commandPath}${metadata.resolvedCommandPath === undefined ? "" : ` -> ${metadata.resolvedCommandPath}`}`
      : `missing at installed path: ${metadata.commandPath}`;
  }

  if (currentCommand !== null) {
    return `${currentCommand.commandPath} -> ${currentCommand.resolvedCommandPath}`;
  }

  return "tokenmaxxing not found on PATH";
}

function doctorAutoUpdateDetail(
  metadata: ServiceMetadata | null,
  autoUpdateManager: AutoUpdateManager | null | undefined,
  managerExists: boolean,
): string {
  if (metadata === null) {
    return "checked when service is installed";
  }

  if (metadata?.autoUpdate === false) {
    return "disabled";
  }

  if (autoUpdateManager === null || autoUpdateManager === undefined) {
    return "enabled but package manager was not detected";
  }

  return managerExists
    ? `enabled via ${autoUpdateManager} (${autoUpdateCommandDescription(autoUpdateManager)})`
    : `enabled via ${autoUpdateManager}, but ${autoUpdateManager} is not on PATH`;
}

function doctorAutoUpdateStatus(
  metadata: ServiceMetadata | null,
  managerExists: boolean,
): DoctorStatus {
  if (metadata === null || metadata.autoUpdate === false) {
    return "info";
  }

  return managerExists ? "ok" : "warn";
}

function serviceRunCommandArgs(): string {
  return "service run --scheduled";
}

function windowsTaskName(): string {
  return WINDOWS_TASK_NAME;
}

function legacyWindowsTaskName(time: ScheduleTime): string {
  return `${WINDOWS_TASK_NAME}-${formatScheduleTime(time).replace(":", "")}`;
}

function windowsTaskNames(): string[] {
  return [windowsTaskName(), ...LEGACY_SCHEDULE_TIMES.map((time) => legacyWindowsTaskName(time))];
}

function renderLaunchdStartInterval(): string {
  return String(SERVICE_INTERVAL_SECONDS);
}

function renderSystemdOnCalendar(): string {
  return "OnCalendar=hourly";
}

function formatScheduleTime(time: ScheduleTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function scheduleDescription(): string {
  return "checks hourly and syncs once per local day";
}

function servicePathsEffect(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  platform = process.platform,
): Effect.Effect<ServicePaths, ServiceUnsupportedPlatformError> {
  const paths = servicePaths({ env, home, platform });

  return paths === null
    ? Effect.fail(new ServiceUnsupportedPlatformError({ platform }))
    : Effect.succeed(paths);
}

function servicePaths({
  env = process.env,
  home = homedir(),
  platform = process.platform,
}: {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
} = {}): ServicePaths | null {
  const backend = backendForPlatform(platform);
  if (backend === null) {
    return null;
  }

  const configDir = dirname(getConfigPath(env));
  const wrapperPath = join(
    configDir,
    platform === "win32" ? WINDOWS_WRAPPER_NAME : POSIX_WRAPPER_NAME,
  );
  const logPath = join(configDir, "service.log");
  const lockPath = join(configDir, "service.lock");
  const metadataPath = join(configDir, "service.json");
  const statePath = join(configDir, "service-state.json");

  if (backend === "launchd") {
    return {
      backend,
      configDir,
      definitionPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      lockPath,
      logPath,
      metadataPath,
      statePath,
      wrapperPath,
    };
  }

  if (backend === "systemd") {
    const systemdDir = join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "systemd", "user");
    return {
      backend,
      configDir,
      definitionPath: join(systemdDir, `${SYSTEMD_NAME}.service`),
      lockPath,
      logPath,
      metadataPath,
      statePath,
      wrapperPath,
    };
  }

  return {
    backend,
    configDir,
    definitionPath: null,
    lockPath,
    logPath,
    metadataPath,
    statePath,
    wrapperPath,
  };
}

function backendForPlatform(platform: NodeJS.Platform): ServiceBackend | null {
  if (platform === "darwin") {
    return "launchd";
  }

  if (platform === "linux") {
    return "systemd";
  }

  if (platform === "win32") {
    return "windows-task-scheduler";
  }

  return null;
}

function renderServiceWrapper({
  commandPath,
  env,
  logPath,
  platform,
}: {
  commandPath: string;
  env: Record<string, string>;
  logPath: string;
  platform: NodeJS.Platform;
}): string {
  return platform === "win32"
    ? renderWindowsWrapper({ commandPath, env, logPath })
    : renderPosixWrapper({ commandPath, env, logPath });
}

function renderPosixWrapper({
  commandPath,
  env,
  logPath,
}: {
  commandPath: string;
  env: Record<string, string>;
  logPath: string;
}): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");

  return `#!/bin/sh
set -eu
${exports}

{
  printf '\\n[%s] tokenmaxxing service sync\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ${shellQuote(commandPath)} ${serviceRunCommandArgs()}
} >> ${shellQuote(logPath)} 2>&1
`;
}

function renderWindowsWrapper({
  commandPath,
  env,
  logPath,
}: {
  commandPath: string;
  env: Record<string, string>;
  logPath: string;
}): string {
  const sets = Object.entries(env)
    .map(([key, value]) => `set "${key}=${escapeCmdSetValue(value)}"`)
    .join("\r\n");

  return `@echo off\r
setlocal\r
${sets}\r
>> ${cmdQuote(logPath)} echo [%DATE% %TIME%] tokenmaxxing service sync\r
${cmdQuote(commandPath)} ${serviceRunCommandArgs()} >> ${cmdQuote(logPath)} 2>&1\r
exit /b %ERRORLEVEL%\r
`;
}

function renderLaunchdPlist(paths: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.wrapperPath)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${renderLaunchdStartInterval()}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.logPath)}</string>
</dict>
</plist>
`;
}

function renderSystemdService(paths: ServicePaths): string {
  return `[Unit]
Description=tokenmaxxing daily usage sync

[Service]
Type=oneshot
ExecStart=${systemdQuote(paths.wrapperPath)}
`;
}

function renderSystemdTimer(): string {
  return `[Unit]
Description=Run tokenmaxxing daily usage sync

[Timer]
${renderSystemdOnCalendar()}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function writeServiceFiles(
  paths: ServicePaths,
  wrapper: string,
  metadata: ServiceMetadata,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(paths.configDir, { recursive: true });
      if (paths.definitionPath !== null) {
        await mkdir(dirname(paths.definitionPath), { recursive: true });
      }

      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      await writeFile(paths.wrapperPath, wrapper);
      if (paths.backend !== "windows-task-scheduler") {
        await chmod(paths.wrapperPath, 0o755);
      }
      await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      if (paths.backend === "launchd" && paths.definitionPath !== null) {
        await writeFile(paths.definitionPath, renderLaunchdPlist(paths));
      }
      if (paths.backend === "systemd" && paths.definitionPath !== null) {
        await writeFile(paths.definitionPath, renderSystemdService(paths));
        await writeFile(systemdTimerPath(paths.definitionPath), renderSystemdTimer());
      }
    },
    catch: (cause) => cause,
  });
}

function removeServiceFiles(paths: ServicePaths): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await rm(paths.wrapperPath, { force: true });
      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      await rm(paths.metadataPath, { force: true });
      await rm(paths.statePath, { force: true });
      await rm(paths.lockPath, { force: true });
      if (paths.definitionPath !== null) {
        await rm(paths.definitionPath, { force: true });
      }
      if (paths.backend === "systemd" && paths.definitionPath !== null) {
        await rm(systemdTimerPath(paths.definitionPath), { force: true });
      }
    },
    catch: (cause) => cause,
  });
}

function legacyServiceWrapperPaths(paths: ServicePaths): string[] {
  if (paths.backend === "windows-task-scheduler") {
    return [];
  }

  const legacyWrapperPath = join(paths.configDir, LEGACY_POSIX_WRAPPER_NAME);

  return legacyWrapperPath === paths.wrapperPath ? [] : [legacyWrapperPath];
}

function installNativeScheduler(paths: ServicePaths): Effect.Effect<void, unknown> {
  if (paths.backend === "launchd") {
    const domain = launchdDomain();
    return Effect.gen(function* () {
      yield* runExecutable("launchctl", ["bootout", domain, paths.definitionPath!]).pipe(
        Effect.ignore,
      );
      yield* runExecutable("launchctl", ["bootstrap", domain, paths.definitionPath!]);
      yield* runExecutable("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`]);
    });
  }

  if (paths.backend === "systemd") {
    return Effect.gen(function* () {
      yield* runExecutable("systemctl", ["--user", "daemon-reload"]);
      yield* runExecutable("systemctl", ["--user", "enable", "--now", `${SYSTEMD_NAME}.timer`]);
    });
  }

  return Effect.gen(function* () {
    for (const taskName of windowsTaskNames()) {
      yield* runExecutable("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
    }
    yield* runExecutable("schtasks", [
      "/Create",
      "/TN",
      windowsTaskName(),
      "/SC",
      "HOURLY",
      "/MO",
      "1",
      "/TR",
      cmdQuote(paths.wrapperPath),
      "/F",
    ]);
  });
}

function uninstallNativeScheduler(paths: ServicePaths): Effect.Effect<void, unknown> {
  if (paths.backend === "launchd") {
    return runExecutable("launchctl", ["bootout", launchdDomain(), paths.definitionPath!]).pipe(
      Effect.ignore,
    );
  }

  if (paths.backend === "systemd") {
    return Effect.gen(function* () {
      yield* runExecutable("systemctl", [
        "--user",
        "disable",
        "--now",
        `${SYSTEMD_NAME}.timer`,
      ]).pipe(Effect.ignore);
      yield* runExecutable("systemctl", ["--user", "daemon-reload"]).pipe(Effect.ignore);
    });
  }

  return Effect.gen(function* () {
    for (const taskName of windowsTaskNames()) {
      yield* runExecutable("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
    }
  });
}

function runExecutable(command: string, args: readonly string[]): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(command, [...args], { windowsHide: true });
    },
    catch: (cause) => cause,
  });
}

function findTokenmaxxingCommandPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<string | null, unknown> {
  return findTokenmaxxingCommandInstall(env, platform).pipe(
    Effect.map((install) => install?.commandPath ?? null),
  );
}

function findTokenmaxxingCommandInstall(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<CommandInstall | null, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const commandPath = await findCommandOnPath("tokenmaxxing", env, platform);
      if (commandPath === null) {
        return null;
      }

      const resolvedCommandPath = await resolveCommandPath(commandPath);

      return {
        autoUpdateManager: detectAutoUpdateManager({
          commandPath,
          env,
          platform,
          resolvedCommandPath,
        }),
        commandPath,
        resolvedCommandPath,
      };
    },
    catch: (cause) => cause,
  });
}

async function resolveCommandPath(commandPath: string): Promise<string> {
  try {
    return await realpath(commandPath);
  } catch {
    return commandPath;
  }
}

async function findCommandOnPath(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathValue = env["PATH"];
  if (!pathValue) {
    return null;
  }

  const extensions =
    platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") {
      continue;
    }

    for (const extension of extensions) {
      const candidate = join(entry, platform === "win32" ? `${command}${extension}` : command);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }

  return null;
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function capturedServiceEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const captured: Record<string, string> = {
    PATH: env["PATH"] ?? defaultPath(),
  };

  for (const key of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "TOKENMAXXING_CONFIG_DIR",
    "TOKENMAXXING_ENV",
    "TOKENMAXXING_API_URL",
    "TOKENMAXXING_WWW_URL",
  ]) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      captured[key] = value;
    }
  }

  return captured;
}

function defaultPath(): string {
  return process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows"
    : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function isEphemeralCommandPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");

  return (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/.bun/install/cache/") ||
    normalized.includes("/node_modules/.bin/")
  );
}

function detectAutoUpdateManager({
  commandPath,
  env = process.env,
  resolvedCommandPath,
}: {
  commandPath: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  resolvedCommandPath: string;
}): AutoUpdateManager | null {
  const paths = [commandPath, resolvedCommandPath].map(normalizePathForDetection);
  const bunInstall = env["BUN_INSTALL"];
  const bunInstallBin =
    bunInstall === undefined ? undefined : normalizePathForDetection(join(bunInstall, "bin"));

  if (
    paths.some(
      (path) =>
        path.includes("/.pnpm/") ||
        path.includes("/pnpm/") ||
        path.includes("/pnpm-global/") ||
        path.includes("/library/pnpm/") ||
        path.includes("/.local/share/pnpm/"),
    )
  ) {
    return "pnpm";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/.bun/bin/") ||
        path.includes("/.bun/install/") ||
        path.includes("/.bun/pm/") ||
        (bunInstallBin !== undefined && isSameOrChildPath(path, bunInstallBin)),
    )
  ) {
    return "bun";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/.yarn/") ||
        path.includes("/yarn/global/") ||
        path.includes("/.config/yarn/") ||
        path.includes("/local/yarn/"),
    )
  ) {
    return "yarn";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/lib/node_modules/") ||
        path.includes("/node_modules/@851-labs/tokenmaxxing/") ||
        path.includes("/node_modules/.bin/tokenmaxxing"),
    )
  ) {
    return "npm";
  }

  return null;
}

function normalizePathForDetection(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function isSameOrChildPath(path: string, parent: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;

  return path === parent || path.startsWith(normalizedParent);
}

function autoUpdateCommand(manager: AutoUpdateManager): {
  args: string[];
  command: AutoUpdateManager;
} {
  switch (manager) {
    case "bun":
      return {
        args: ["update", "-g", PACKAGE_NAME, "--latest", "--silent"],
        command: "bun",
      };
    case "npm":
      return {
        args: ["install", "-g", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "npm",
      };
    case "pnpm":
      return {
        args: ["add", "-g", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "pnpm",
      };
    case "yarn":
      return {
        args: ["global", "add", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "yarn",
      };
  }
}

function autoUpdateCommandDescription(manager: AutoUpdateManager): string {
  const { command, args } = autoUpdateCommand(manager);

  return [command, ...args].join(" ");
}

function readServiceMetadata(path: string): Effect.Effect<ServiceMetadata | null, never> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as ServiceMetadata,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function isServiceInstalled(paths: ServicePaths): Effect.Effect<boolean, never> {
  if (paths.backend === "windows-task-scheduler") {
    return fileExists(paths.metadataPath);
  }

  return paths.definitionPath === null ? Effect.succeed(false) : fileExists(paths.definitionPath);
}

function fileExists(path: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
      await access(path, constants.F_OK);
      return true;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function systemdTimerPath(servicePath: string): string {
  return servicePath.replace(/\.service$/, ".timer");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function escapeCmdSetValue(value: string): string {
  return value.replaceAll('"', '\\"');
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export {
  autoUpdateCommand,
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  detectAutoUpdateManager,
  findCommandOnPath,
  findTokenmaxxingCommandInstall,
  findTokenmaxxingCommandPath,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  isEphemeralCommandPath,
  isServiceInstalled,
  legacyServiceWrapperPaths,
  deterministicServiceJitterMs,
  localDateKey,
  readServiceMetadata,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdService,
  renderSystemdTimer,
  refreshServiceAfterUpdate,
  scheduleDescription,
  serviceCommand,
  serviceDoctorEffect,
  serviceInstallEffect,
  serviceInstallProgram,
  serviceLockStatus,
  serviceStateJson,
  servicePathsEffect,
  servicePaths,
  serviceRunEffect,
  serviceStatusEffect,
  serviceUninstallEffect,
  shouldSkipServiceRun,
  runPackageManagerUpdate,
  runExecutable,
  windowsTaskNames,
  ServiceAutoUpdateManagerError,
  ServiceCommandNotFoundError,
  ServiceEnvTokenError,
  ServiceEphemeralCommandError,
  ServiceInstallError,
  ServiceNotInstalledError,
  ServiceRunError,
  ServiceUninstallError,
  ServiceUnsupportedPlatformError,
};

export type {
  AutoUpdateManager,
  CommandInstall,
  ServiceBackend,
  ServiceInstallOptions,
  ServiceMetadata,
  ServicePaths,
};
