import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ServiceCheckInStatusValue } from "@tokenmaxxing/api-contract";

import { ClockService, ConfigService, ConsoleService } from "../services";
import { getConfigPath } from "../services/config";
import { humanFrame, humanLog, humanSpinner, writeJson } from "../output";
import packageJson from "../../package.json";
import {
  resolveSyncAuth,
  syncProgram,
  type SyncAuth,
  type SyncResult,
  type UploadRetryPolicy,
} from "./sync";

const execFilePromise = promisify(execFile);

const SERVICE_LABEL = "sh.tokenmaxxing.sync";
const SERVICE_TEMPLATE_VERSION = 2;
const SYSTEMD_NAME = "tokenmaxxing-sync";
const WINDOWS_TASK_NAME = "tokenmaxxing-sync";
const POSIX_WRAPPER_NAME = "tokenmaxxing.sh";
const LEGACY_POSIX_WRAPPER_NAME = "service-sync.sh";
const WINDOWS_WRAPPER_NAME = "service-sync.cmd";
const PACKAGE_NAME = "@851-labs/tokenmaxxing";
const SERVICE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const SERVICE_INTERVAL_MINUTES = 5;
const SERVICE_INTERVAL_SECONDS = SERVICE_INTERVAL_MINUTES * 60;
const SERVICE_JITTER_MAX_MS = 60 * 1000;
const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const SERVICE_LOG_ROTATIONS = 3;
const SERVICE_UPLOAD_RETRY_POLICY: UploadRetryPolicy = {
  attempts: 3,
  backoffMs: [1_000, 4_000, 16_000],
  jitterRatio: 0.2,
  timeoutMs: 60_000,
};
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
  json?: boolean | undefined;
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
  templateVersion?: number | undefined;
  version: 1;
}

interface ServiceRunOptions {
  force: boolean;
  json?: boolean | undefined;
  scheduled: boolean;
}

interface ServiceState {
  lastArch?: string;
  lastAttemptAt?: string;
  lastAutoUpdated?: boolean;
  lastCliVersion?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastRows?: number;
  lastSchedulerActive?: boolean;
  lastSince?: string;
  lastSources?: ServiceSourceState[];
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  lastUpserted?: number;
  reloadRequired?: boolean;
  version: 1;
}

interface ServiceSourceState {
  days?: number;
  models?: number;
  rows?: number;
  sessions?: number | null;
  source: string;
  spendUsd?: number;
  status: "skipped" | "synced";
}

interface ServiceLogWriter {
  log: (message?: unknown) => void;
}

interface ServiceNativeSchedulerStatus {
  active: boolean;
  command: string;
  detail: string;
}

interface ServiceCheckIn {
  backend: ServiceBackend;
  error?: string | undefined;
  reloadRequired: boolean;
  schedulerActive: boolean;
  status: ServiceCheckInStatusValue;
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

interface DoctorCheck {
  detail: string;
  label: string;
  status: DoctorStatus;
}

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

class ServiceRepairError extends Data.TaggedError("ServiceRepairError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to repair tokenmaxxing service\nhint: rerun tokenmaxxing service doctor --verbose";
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
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    refresh: Flag.boolean("refresh").pipe(Flag.withHidden),
  },
  ({ force, json, noAutoUpdate, refresh }) =>
    serviceInstallEffect({ autoUpdate: !noAutoUpdate, force, json, refresh }),
).pipe(Command.withDescription("Install automatic sync"));

const uninstallCommand = Command.make(
  "uninstall",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceUninstallEffect({ json }),
).pipe(Command.withDescription("Uninstall automatic sync"));

const statusCommand = Command.make(
  "status",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceStatusEffect({ json }),
).pipe(Command.withDescription("Show automatic sync service status"));

const doctorCommand = Command.make(
  "doctor",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceDoctorEffect({ json }),
).pipe(Command.withDescription("Check automatic sync service health"));

const repairCommand = Command.make(
  "repair",
  {
    deferred: Flag.boolean("deferred").pipe(Flag.withHidden),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ deferred, json }) => serviceRepairEffect({ deferred, json }),
).pipe(Command.withDescription("Repair automatic sync scheduling"));

const runCommand = Command.make(
  "run",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Deprecated; service runs sync every time"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    scheduled: Flag.boolean("scheduled").pipe(Flag.withHidden),
  },
  ({ force, json, scheduled }) => serviceRunEffect({ force, json, scheduled }),
).pipe(Command.withDescription("Run the automatic sync job now"));

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage automatic sync"),
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    statusCommand,
    doctorCommand,
    repairCommand,
    runCommand,
  ]),
);

function serviceInstallEffect(options: ServiceInstallOptions) {
  return humanFrame("Install automatic sync", options, serviceInstallProgram(options));
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

    if (!options.refresh && (yield* config.hasEnvToken())) {
      return yield* Effect.fail(new ServiceEnvTokenError());
    }

    if (!options.refresh) {
      yield* resolveSyncAuth({ json: options.json === true });
    }

    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const paths = yield* servicePathsEffect(env, runtime.home, platform);
    const installSpinner = yield* humanSpinner("Detecting tokenmaxxing install", options);
    const commandInstall = yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((install) =>
        install === null ? Effect.fail(new ServiceCommandNotFoundError()) : Effect.succeed(install),
      ),
      Effect.tapError(() =>
        Effect.sync(() => installSpinner.error("Could not find tokenmaxxing install")),
      ),
    );
    const commandPath = commandInstall.commandPath;
    if (!options.force && isEphemeralCommandPath(commandPath)) {
      yield* Effect.sync(() => installSpinner.error("Could not use tokenmaxxing install"));
      return yield* Effect.fail(new ServiceEphemeralCommandError({ commandPath }));
    }
    if (options.autoUpdate && commandInstall.autoUpdateManager === null) {
      yield* Effect.sync(() => installSpinner.error("Could not detect install method"));
      return yield* Effect.fail(
        new ServiceAutoUpdateManagerError({
          commandPath,
          resolvedCommandPath: commandInstall.resolvedCommandPath,
        }),
      );
    }
    yield* Effect.sync(() => installSpinner.stop("Found tokenmaxxing install"));

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
      templateVersion: SERVICE_TEMPLATE_VERSION,
      version: 1,
    };

    const filesSpinner = yield* humanSpinner("Writing service files", options);
    yield* (runtime.writeFiles ?? writeServiceFiles)(paths, wrapper, metadata).pipe(
      Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
      Effect.tapError(() => Effect.sync(() => filesSpinner.error("Failed writing service files"))),
      Effect.mapError((cause) => new ServiceInstallError({ cause })),
    );
    const schedulerSpinner = yield* humanSpinner("Installing scheduler", options);
    yield* (runtime.installScheduler ?? installNativeScheduler)(paths).pipe(
      Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler installed"))),
      Effect.tapError(() =>
        Effect.sync(() => schedulerSpinner.error("Failed installing scheduler")),
      ),
      Effect.mapError((cause) => new ServiceInstallError({ cause })),
    );

    const autoUpdate = {
      enabled: options.autoUpdate,
      manager: commandInstall.autoUpdateManager,
      ...(options.autoUpdate
        ? { command: autoUpdateCommandDescription(commandInstall.autoUpdateManager!) }
        : {}),
    };

    if (options.json) {
      yield* writeJson({
        autoUpdate,
        backend: paths.backend,
        logPath: paths.logPath,
        schedule: scheduleDescription(),
        status: "ok",
        wrapperPath: paths.wrapperPath,
      });
      return;
    }

    yield* humanLog("success", "Automatic sync installed", options);
    yield* humanLog("info", `Schedule: ${scheduleDescription()}`, options);
    yield* humanLog("info", `Backend: ${paths.backend}`, options);
    yield* humanLog("info", `Log: ${paths.logPath}`, options);
    yield* humanLog(
      "info",
      `Auto-update: ${options.autoUpdate ? `enabled via ${commandInstall.autoUpdateManager}` : "disabled"}${
        options.autoUpdate
          ? ` (${autoUpdateCommandDescription(commandInstall.autoUpdateManager!)})`
          : ""
      }`,
      options,
    );
  });
}

function serviceUninstallEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Uninstall automatic sync",
    options,
    Effect.gen(function* () {
      const paths = yield* servicePathsEffect();

      const schedulerSpinner = yield* humanSpinner("Unregistering scheduler", options);
      yield* uninstallNativeScheduler(paths).pipe(
        Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler unregistered"))),
        Effect.tapError(() =>
          Effect.sync(() => schedulerSpinner.error("Failed unregistering scheduler")),
        ),
        Effect.mapError((cause) => new ServiceUninstallError({ cause })),
      );
      const filesSpinner = yield* humanSpinner("Removing service files", options);
      yield* removeServiceFiles(paths).pipe(
        Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files removed"))),
        Effect.tapError(() =>
          Effect.sync(() => filesSpinner.error("Failed removing service files")),
        ),
        Effect.mapError((cause) => new ServiceUninstallError({ cause })),
      );

      if (options.json) {
        yield* writeJson({ removed: true, status: "ok" });
        return;
      }

      yield* humanLog("success", "Automatic sync uninstalled", options);
      yield* humanLog("info", "Auth and synced usage were left untouched", options);
    }),
  );
}

function serviceRepairEffect(
  options: {
    deferred?: boolean | undefined;
    json?: boolean | undefined;
  } = {},
) {
  const program = repairServiceProgram(options);

  return options.deferred ? program : humanFrame("Repair automatic sync", options, program);
}

function repairServiceProgram(options: { json?: boolean | undefined } = {}) {
  return Effect.gen(function* () {
    const env = process.env;
    const platform = process.platform;
    const paths = yield* servicePathsEffect(env, undefined, platform);
    const existingMetadata = yield* readServiceMetadata(paths.metadataPath);
    const autoUpdate = existingMetadata?.autoUpdate ?? true;

    const installSpinner = yield* humanSpinner("Detecting tokenmaxxing install", options);
    const commandInstall = yield* findTokenmaxxingCommandInstall(env, platform).pipe(
      Effect.flatMap((install) =>
        install === null ? Effect.fail(new ServiceCommandNotFoundError()) : Effect.succeed(install),
      ),
      Effect.tapError(() =>
        Effect.sync(() => installSpinner.error("Could not find tokenmaxxing install")),
      ),
    );
    if (isEphemeralCommandPath(commandInstall.commandPath)) {
      yield* Effect.sync(() => installSpinner.error("Could not use tokenmaxxing install"));
      return yield* Effect.fail(
        new ServiceEphemeralCommandError({ commandPath: commandInstall.commandPath }),
      );
    }
    if (autoUpdate && commandInstall.autoUpdateManager === null) {
      yield* Effect.sync(() => installSpinner.error("Could not detect install method"));
      return yield* Effect.fail(
        new ServiceAutoUpdateManagerError({
          commandPath: commandInstall.commandPath,
          resolvedCommandPath: commandInstall.resolvedCommandPath,
        }),
      );
    }
    yield* Effect.sync(() => installSpinner.stop("Found tokenmaxxing install"));

    const wrapper = renderServiceWrapper({
      commandPath: commandInstall.commandPath,
      env: capturedServiceEnv(env),
      logPath: paths.logPath,
      platform,
    });
    const metadata: ServiceMetadata = {
      autoUpdate,
      autoUpdateManager: commandInstall.autoUpdateManager,
      backend: paths.backend,
      commandPath: commandInstall.commandPath,
      resolvedCommandPath: commandInstall.resolvedCommandPath,
      installedAt: new Date().toISOString(),
      schedule: scheduleDescription(),
      templateVersion: SERVICE_TEMPLATE_VERSION,
      version: 1,
    };

    const filesSpinner = yield* humanSpinner("Writing service files", options);
    yield* writeServiceFiles(paths, wrapper, metadata).pipe(
      Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
      Effect.tapError(() => Effect.sync(() => filesSpinner.error("Failed writing service files"))),
      Effect.mapError((cause) => new ServiceRepairError({ cause })),
    );
    const schedulerSpinner = yield* humanSpinner("Repairing scheduler", options);
    yield* installNativeScheduler(paths).pipe(
      Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler repaired"))),
      Effect.tapError(() =>
        Effect.sync(() => schedulerSpinner.error("Failed repairing scheduler")),
      ),
      Effect.mapError((cause) => new ServiceRepairError({ cause })),
    );

    const nativeStatus = yield* readNativeSchedulerStatus(paths);
    if (!nativeStatus.active) {
      return yield* Effect.fail(new ServiceRepairError({ cause: nativeStatus.detail }));
    }

    if (options.json) {
      yield* writeJson({
        active: nativeStatus.active,
        backend: paths.backend,
        detail: nativeStatus.detail,
        status: "ok",
      });
      return;
    }

    yield* humanLog("success", "Automatic sync repaired", options);
    yield* humanLog("info", `Scheduler: ${nativeStatus.detail}`, options);
  });
}

function serviceStatusEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Service status",
    options,
    Effect.gen(function* () {
      const console = yield* Effect.service(ConsoleService);
      const paths = yield* servicePathsEffect();
      const metadata = yield* readServiceMetadata(paths.metadataPath);
      const state = yield* readServiceState(paths.statePath);
      const installed = yield* isServiceInstalled(paths);
      const now = new Date();
      const lockStatus = yield* readServiceLockStatus(paths.lockPath, now);
      const nativeStatus = yield* readNativeSchedulerStatus(paths);
      const reloadRequired = serviceReloadRequired(metadata, state);
      const status = {
        arch: state?.lastArch ?? null,
        autoUpdate: formatServiceStatusAutoUpdate(metadata),
        backend: paths.backend,
        installed,
        lastAutoUpdated: state?.lastAutoUpdated ?? null,
        lastDurationMs: state?.lastDurationMs ?? null,
        lastError: state?.lastError,
        lastRows: state?.lastRows ?? null,
        lastSchedulerActive: state?.lastSchedulerActive ?? null,
        lastSince: state?.lastSince ?? null,
        lastSources: state?.lastSources ?? [],
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastSuccessDate: serviceLastSuccessDate(state) ?? null,
        lastUpserted: state?.lastUpserted ?? null,
        lastVersion: state?.lastCliVersion ?? null,
        lock: formatServiceLockStatus(lockStatus),
        logPath: paths.logPath,
        reloadRequired,
        schedule: metadata?.schedule ?? scheduleDescription(),
        scheduler: nativeStatus,
        status: "ok",
        templateVersion: metadata?.templateVersion ?? null,
        wrapperPath: paths.wrapperPath,
      };

      if (options.json) {
        yield* writeJson(status);
        return;
      }

      yield* Effect.sync(() => {
        console.log(`Installed: ${status.installed ? "yes" : "no"}`);
        console.log(`Backend: ${status.backend}`);
        console.log(`Schedule: ${status.schedule}`);
        console.log(`Auto-update: ${status.autoUpdate}`);
        console.log(`Scheduler active: ${status.scheduler.active ? "yes" : "no"}`);
        console.log(`Scheduler detail: ${status.scheduler.detail}`);
        console.log(`Service template: ${status.templateVersion ?? "unknown"}`);
        console.log(`Reload required: ${status.reloadRequired ? "yes" : "no"}`);
        console.log(`Last success: ${status.lastSuccessAt ?? "never"}`);
        console.log(`Last success date: ${status.lastSuccessDate ?? "never"}`);
        if (status.lastDurationMs !== null) {
          console.log(`Last duration: ${status.lastDurationMs}ms`);
        }
        if (status.lastRows !== null) {
          console.log(`Last rows: ${status.lastRows}`);
        }
        if (status.lastSince !== null) {
          console.log(`Last since: ${status.lastSince}`);
        }
        if (status.lastUpserted !== null) {
          console.log(`Last upserted: ${status.lastUpserted}`);
        }
        if (status.lastVersion !== null) {
          console.log(
            `Last CLI: ${status.lastVersion}${status.arch === null ? "" : ` (${status.arch})`}`,
          );
        }
        if (status.lastError !== undefined) {
          console.log(`Last error: ${status.lastError}`);
        }
        console.log(`Lock: ${status.lock}`);
        console.log(`Wrapper: ${status.wrapperPath}`);
        console.log(`Log: ${status.logPath}`);
      });
    }),
  );
}

function serviceRunEffect(options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();
    const lock = yield* acquireServiceRunLock(paths.lockPath, new Date()).pipe(
      Effect.mapError((cause) => new ServiceRunError({ cause })),
    );

    if (lock._tag === "locked") {
      const message = formatServiceLockSkip(lock.status);
      if (options.json) {
        yield* writeJson({
          lock: formatServiceLockStatus(lock.status),
          reason: "locked",
          status: "skipped",
        });
      } else if (!options.scheduled) {
        yield* Effect.sync(() => {
          console.log(message);
        });
      }
      return;
    }

    const result = yield* runServiceSyncOnce(paths, options).pipe(
      Effect.ensuring(releaseServiceRunLock(paths.lockPath, lock.lock.ownerId)),
    );

    if (options.json && !options.scheduled) {
      yield* writeJson(result);
    }
  });
}

function serviceDoctorEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Service doctor",
    options,
    Effect.gen(function* () {
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
      const nativeStatus = yield* readNativeSchedulerStatus(paths);
      const reloadRequired = serviceReloadRequired(metadata, state);
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

      const checks = [
        doctorCheck(
          installed ? "ok" : "warn",
          "scheduler",
          installed ? `installed (${paths.backend})` : `not installed (${paths.backend})`,
        ),
        doctorCheck(
          nativeStatus.active ? "ok" : "warn",
          "active",
          `${nativeStatus.detail}; repair with ${serviceRepairCommand()}`,
        ),
        doctorCheck(
          reloadRequired ? "warn" : "ok",
          "template",
          reloadRequired
            ? `reload required; repair with ${serviceRepairCommand()}`
            : `current (${metadata?.templateVersion ?? "unknown"})`,
        ),
        doctorCheck(
          definitionExists ? "ok" : "warn",
          "definition",
          paths.definitionPath ?? "tracked by Windows Task Scheduler metadata",
        ),
        doctorCheck(wrapperExists ? "ok" : "warn", "wrapper", paths.wrapperPath),
        doctorCheck(metadata === null ? "warn" : "ok", "metadata", paths.metadataPath),
        doctorCheck(
          envToken
            ? "warn"
            : authConfig._tag === "success" && authConfig.value.token
              ? "ok"
              : "warn",
          "auth",
          doctorAuthDetail(envToken, authConfig),
        ),
        doctorCheck(
          metadataCommandExists ? "ok" : currentCommand === null ? "warn" : "ok",
          "binary",
          doctorBinaryDetail(metadata, metadataCommandExists, currentCommand),
        ),
        doctorCheck(
          doctorAutoUpdateStatus(metadata, autoUpdateManagerExists),
          "auto-update",
          doctorAutoUpdateDetail(metadata, autoUpdateManager, autoUpdateManagerExists),
        ),
        doctorCheck(
          lockStatus.locked && !lockStatus.stale ? "warn" : "ok",
          "lock",
          formatServiceLockStatus(lockStatus),
        ),
        doctorCheck(
          state?.lastSuccessAt === undefined ? "info" : "ok",
          "last success",
          state?.lastSuccessAt ?? "never",
        ),
        doctorCheck(
          state?.lastError === undefined ? "ok" : "warn",
          "last error",
          state?.lastError ?? "none",
        ),
      ];

      if (options.json) {
        yield* writeJson({
          checks,
          recentLog: logTail,
          reloadRequired,
          scheduler: nativeStatus,
          state: state === null ? null : serviceStateJson(state),
          status: "ok",
        });
        return;
      }

      yield* Effect.sync(() => {
        console.log("Service doctor");
        for (const check of checks) {
          console.log(doctorLine(check));
        }

        if (logTail.length > 0) {
          console.log("");
          console.log("Recent log:");
          for (const line of logTail) {
            console.log(`  ${line}`);
          }
        }
      });
    }),
  );
}

function runServiceSyncOnce(paths: ServicePaths, options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);
    const state = yield* readServiceState(paths.statePath);
    const currentState = state ?? { version: 1 as const };
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const startedAtMs = startedAt.getTime();
    const cliVersion = packageJson.version;
    const cliArch = arch();
    const scheduledSince = serviceScheduledSyncSince(currentState, startedAt, options.scheduled);
    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const nativeStatus = yield* readNativeSchedulerStatus(paths);
    const reloadRequired = serviceReloadRequired(metadata, currentState);
    const baseCheckIn = {
      backend: paths.backend,
      reloadRequired,
      schedulerActive: nativeStatus.active,
    };

    if (options.scheduled) {
      const stored = yield* config.readConfig();
      const jitterMs =
        stored.deviceId === undefined ? 0 : deterministicServiceJitterMs(stored.deviceId);
      if (jitterMs > 0) {
        yield* clock.sleep(jitterMs).pipe(Effect.catch(() => Effect.void));
      }
    }

    const authResult = yield* resolveSyncAuth({ json: true }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    );
    if (authResult._tag === "failure") {
      const failedState = serviceRunFailureState(currentState, {
        arch: cliArch,
        attemptAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        error: String(authResult.cause),
        reloadRequired,
        schedulerActive: nativeStatus.active,
        since: scheduledSince,
        version: cliVersion,
      });
      yield* writeServiceState(paths.statePath, failedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(console, options, serviceRunLogLine(failedState, "failure"));
      return yield* Effect.fail(new ServiceRunError({ cause: authResult.cause }));
    }

    const auth = authResult.value;
    yield* writeServiceCheckIn(auth, {
      ...baseCheckIn,
      status: "started",
    }).pipe(Effect.ignore);

    const autoUpdated = yield* runServiceAutoUpdate(metadata, { json: options.json });

    yield* writeServiceState(paths.statePath, {
      ...currentState,
      lastArch: cliArch,
      lastAttemptAt: startedAtIso,
      lastCliVersion: cliVersion,
      lastError: undefined,
      lastSchedulerActive: nativeStatus.active,
      lastSince: scheduledSince,
      reloadRequired,
      version: 1,
    }).pipe(Effect.mapError((cause) => new ServiceRunError({ cause })));

    const result = yield* syncProgram({
      auth,
      dryRun: false,
      json: true,
      silent: true,
      ...(scheduledSince === undefined ? {} : { since: scheduledSince }),
      ...(options.scheduled ? { uploadPolicy: SERVICE_UPLOAD_RETRY_POLICY } : {}),
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    );

    if (result._tag === "failure") {
      const failedState = serviceRunFailureState(currentState, {
        arch: cliArch,
        attemptAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        error: String(result.cause),
        reloadRequired,
        schedulerActive: nativeStatus.active,
        since: scheduledSince,
        version: cliVersion,
      });
      yield* writeServiceState(paths.statePath, failedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(console, options, serviceRunLogLine(failedState, "failure"));
      yield* writeServiceCheckIn(auth, {
        ...baseCheckIn,
        error: failedState.lastError,
        status: "failure",
      }).pipe(Effect.ignore);
      return yield* Effect.fail(new ServiceRunError({ cause: result.cause }));
    }

    const successAt = new Date().toISOString();
    const successState = serviceRunSuccessState(currentState, {
      arch: cliArch,
      attemptAt: startedAtIso,
      autoUpdated,
      durationMs: Date.now() - startedAtMs,
      reloadRequired,
      result: result.value,
      schedulerActive: nativeStatus.active,
      since: scheduledSince,
      successAt,
      version: cliVersion,
    });
    yield* writeServiceState(paths.statePath, successState).pipe(
      Effect.mapError((cause) => new ServiceRunError({ cause })),
    );
    yield* writeScheduledServiceLog(console, options, serviceRunLogLine(successState, "success"));
    yield* writeServiceCheckIn(auth, {
      ...baseCheckIn,
      status: "success",
    }).pipe(Effect.ignore);

    if (autoUpdated && metadata !== null) {
      if (options.scheduled) {
        yield* scheduleDeferredServiceRepair(metadata.commandPath).pipe(Effect.ignore);
      } else {
        yield* refreshServiceAfterUpdate({
          autoUpdate: metadata.autoUpdate,
          commandPath: metadata.commandPath,
        }).pipe(
          Effect.catch(() =>
            options.json
              ? Effect.void
              : Effect.sync(() => {
                  console.log("Service refresh failed after auto-update");
                }),
          ),
        );
      }
    } else if (options.scheduled && reloadRequired && metadata !== null) {
      yield* scheduleDeferredServiceRepair(metadata.commandPath).pipe(Effect.ignore);
    }

    if (!options.json && !options.scheduled) {
      yield* Effect.sync(() => {
        console.log("Service run complete");
        console.log(`Log: ${paths.logPath}`);
      });
    }

    return {
      autoUpdated,
      logPath: paths.logPath,
      rows: result.value.rows,
      status: "ok" as const,
      upserted: result.value.upserted ?? 0,
    };
  });
}

function writeServiceCheckIn(auth: SyncAuth, checkIn: ServiceCheckIn) {
  return auth.client.usage.checkIn({
    payload: {
      device: {
        arch: arch(),
        name: hostname(),
        platform: process.platform,
        version: packageJson.version,
      },
      service: {
        backend: checkIn.backend,
        error: checkIn.error,
        reloadRequired: checkIn.reloadRequired,
        schedulerActive: checkIn.schedulerActive,
        status: checkIn.status,
        templateVersion: SERVICE_TEMPLATE_VERSION,
      },
    },
  });
}

function serviceReloadRequired(metadata: ServiceMetadata | null, _state?: ServiceState | null) {
  return metadata !== null && metadata.templateVersion !== SERVICE_TEMPLATE_VERSION;
}

function serviceRepairCommand(): string {
  return "tokenmaxxing service repair";
}

function scheduleDeferredServiceRepair(commandPath: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const child = spawnDeferredServiceRepair(commandPath);
      child.unref();
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void));
}

function spawnDeferredServiceRepair(commandPath: string) {
  if (process.platform === "win32") {
    return spawn(
      "cmd",
      [
        "/d",
        "/s",
        "/c",
        `timeout /t 2 /nobreak >nul & ${cmdQuote(commandPath)} service repair --deferred`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
  }

  return spawn("sh", ["-c", `sleep 2; exec ${shellQuote(commandPath)} service repair --deferred`], {
    detached: true,
    stdio: "ignore",
  });
}

function readNativeSchedulerStatus(
  paths: ServicePaths,
): Effect.Effect<ServiceNativeSchedulerStatus, never> {
  const invocation = nativeSchedulerStatusInvocation(paths);

  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(invocation.command, invocation.args, { windowsHide: true });

      return {
        active: true,
        command: invocation.description,
        detail: "active",
      };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        active: false,
        command: invocation.description,
        detail: formatNativeSchedulerError(cause),
      }),
    ),
  );
}

function nativeSchedulerStatusInvocation(paths: ServicePaths): {
  args: string[];
  command: string;
  description: string;
} {
  if (paths.backend === "launchd") {
    const target = `${launchdDomain()}/${SERVICE_LABEL}`;

    return {
      args: ["print", target],
      command: "launchctl",
      description: `launchctl print ${target}`,
    };
  }

  if (paths.backend === "systemd") {
    return {
      args: ["--user", "is-active", `${SYSTEMD_NAME}.timer`],
      command: "systemctl",
      description: `systemctl --user is-active ${SYSTEMD_NAME}.timer`,
    };
  }

  return {
    args: ["/Query", "/TN", windowsTaskName()],
    command: "schtasks",
    description: `schtasks /Query /TN ${windowsTaskName()}`,
  };
}

function formatNativeSchedulerError(cause: unknown): string {
  const error = cause as { code?: unknown; stderr?: unknown; stdout?: unknown };
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const output = stderr || stdout;
  if (output !== "") {
    return output.split(/\r?\n/)[0]!;
  }

  return `inactive${formatNativeSchedulerExitCode(error.code)}`;
}

function formatNativeSchedulerExitCode(code: unknown): string {
  return typeof code === "number" || typeof code === "string" ? ` (exit ${code})` : "";
}

function serviceRunSuccessState(
  currentState: ServiceState,
  input: {
    arch: string;
    attemptAt: string;
    autoUpdated: boolean;
    durationMs: number;
    reloadRequired?: boolean | undefined;
    result: SyncResult;
    schedulerActive?: boolean | undefined;
    since?: string | undefined;
    successAt: string;
    version: string;
  },
): ServiceState {
  return {
    ...currentState,
    lastArch: input.arch,
    lastAttemptAt: input.attemptAt,
    lastAutoUpdated: input.autoUpdated,
    lastCliVersion: input.version,
    lastDurationMs: input.durationMs,
    lastError: undefined,
    lastRows: input.result.rows,
    lastSchedulerActive: input.schedulerActive,
    lastSince: input.since,
    lastSources: serviceSourcesForState(input.result),
    lastSuccessAt: input.successAt,
    lastUpserted: input.result.upserted ?? 0,
    reloadRequired: input.reloadRequired,
    version: 1,
  };
}

function serviceRunFailureState(
  currentState: ServiceState,
  input: {
    arch: string;
    attemptAt: string;
    durationMs: number;
    error: string;
    reloadRequired?: boolean | undefined;
    schedulerActive?: boolean | undefined;
    since?: string | undefined;
    version: string;
  },
): ServiceState {
  return {
    ...currentState,
    lastArch: input.arch,
    lastAttemptAt: input.attemptAt,
    lastCliVersion: input.version,
    lastDurationMs: input.durationMs,
    lastError: input.error,
    lastSchedulerActive: input.schedulerActive,
    lastSince: input.since,
    reloadRequired: input.reloadRequired,
    version: 1,
  };
}

function serviceSourcesForState(result: SyncResult): ServiceSourceState[] {
  return result.sourceResults.map((sourceResult) => {
    const summary = sourceResult.summary;
    if (summary === null) {
      return {
        source: sourceResult.source,
        status: "skipped" as const,
      };
    }

    return {
      days: summary.days,
      models: summary.models,
      rows: summary.rows,
      sessions: summary.sessions,
      source: sourceResult.source,
      spendUsd: summary.spendUsd,
      status: "synced" as const,
    };
  });
}

function serviceRunLogLine(state: ServiceState, status: "failure" | "success") {
  return {
    arch: state.lastArch,
    autoUpdated: state.lastAutoUpdated,
    durationMs: state.lastDurationMs,
    error: status === "failure" ? state.lastError : undefined,
    event: "service_run",
    reloadRequired: state.reloadRequired,
    rows: state.lastRows,
    schedulerActive: state.lastSchedulerActive,
    since: state.lastSince,
    sources: state.lastSources,
    status,
    timestamp: new Date().toISOString(),
    upserted: state.lastUpserted,
    version: state.lastCliVersion,
  };
}

function writeScheduledServiceLog(
  console: ServiceLogWriter,
  options: ServiceRunOptions,
  line: ReturnType<typeof serviceRunLogLine>,
): Effect.Effect<void> {
  if (!options.scheduled) {
    return Effect.void;
  }

  return Effect.sync(() => {
    console.log(JSON.stringify(removeUndefined(line)));
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  ) as Partial<T>;
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

function serviceScheduledSyncSince(
  state: ServiceState,
  now: Date,
  scheduled: boolean,
): string | undefined {
  if (!scheduled) {
    return undefined;
  }

  if (state.lastSuccessAt !== undefined) {
    const lastSuccessAt = new Date(state.lastSuccessAt);
    if (!Number.isNaN(lastSuccessAt.getTime()) && lastSuccessAt.getTime() <= now.getTime()) {
      return localDateKey(lastSuccessAt);
    }
  }

  const today = localDateKey(now);
  if (
    state.lastSuccessDate !== undefined &&
    isLocalDateKey(state.lastSuccessDate) &&
    state.lastSuccessDate <= today
  ) {
    return state.lastSuccessDate;
  }

  return previousLocalDateKey(now);
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function previousLocalDateKey(date: Date): string {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
}

function isLocalDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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
    return "Sync skipped; service run is already in progress";
  }

  return `Sync skipped; service run is already in progress${formatServiceLockSince(status)}`;
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
    ...(state.lastArch === undefined ? {} : { lastArch: state.lastArch }),
    ...(state.lastAttemptAt === undefined ? {} : { lastAttemptAt: state.lastAttemptAt }),
    ...(state.lastAutoUpdated === undefined ? {} : { lastAutoUpdated: state.lastAutoUpdated }),
    ...(state.lastCliVersion === undefined ? {} : { lastCliVersion: state.lastCliVersion }),
    ...(state.lastDurationMs === undefined ? {} : { lastDurationMs: state.lastDurationMs }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.lastRows === undefined ? {} : { lastRows: state.lastRows }),
    ...(state.lastSchedulerActive === undefined
      ? {}
      : { lastSchedulerActive: state.lastSchedulerActive }),
    ...(state.lastSince === undefined ? {} : { lastSince: state.lastSince }),
    ...(state.lastSources === undefined ? {} : { lastSources: state.lastSources }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastUpserted === undefined ? {} : { lastUpserted: state.lastUpserted }),
    ...(state.reloadRequired === undefined ? {} : { reloadRequired: state.reloadRequired }),
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
  options: { json?: boolean | undefined } = {},
): Effect.Effect<boolean, never, ConsoleService> {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);

    if (metadata === null || metadata.autoUpdate === false) {
      return false;
    }

    const manager = metadata.autoUpdateManager;
    if (manager === undefined || manager === null) {
      if (!options.json) {
        yield* Effect.sync(() => {
          console.log("Auto-update skipped; package manager was not detected");
        });
      }
      return false;
    }

    const managerExists = yield* commandExists(manager);
    if (!managerExists) {
      if (!options.json) {
        yield* Effect.sync(() => {
          console.log(`Auto-update skipped; ${manager} not found`);
        });
      }
      return false;
    }

    return yield* runPackageManagerUpdate(manager).pipe(
      Effect.as(true),
      Effect.catch(() =>
        options.json
          ? Effect.succeed(false)
          : Effect.sync(() => {
              console.log(`Auto-update failed; continuing with sync`);
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

function doctorCheck(status: DoctorStatus, label: string, detail: string): DoctorCheck {
  return { detail, label, status };
}

function doctorLine(check: DoctorCheck): string {
  return `${check.status.toUpperCase().padEnd(4)} ${check.label.padEnd(12)} ${check.detail}`;
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

function renderSystemdTimerSchedule(): string {
  return [
    `OnBootSec=${SERVICE_INTERVAL_MINUTES}min`,
    `OnUnitActiveSec=${SERVICE_INTERVAL_MINUTES}min`,
  ].join("\n");
}

function formatScheduleTime(time: ScheduleTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function scheduleDescription(): string {
  return `syncs every ${SERVICE_INTERVAL_MINUTES} minutes`;
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

${renderPosixLogRotation(logPath)}

{
  printf '\\n[%s] tokenmaxxing service sync\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ${shellQuote(commandPath)} ${serviceRunCommandArgs()}
} >> ${shellQuote(logPath)} 2>&1
`;
}

function renderPosixLogRotation(logPath: string): string {
  const quotedLogPath = shellQuote(logPath);

  return `rotate_tokenmaxxing_log() {
  log=$1
  [ -f "$log" ] || return 0
  size=$(wc -c < "$log" 2>/dev/null | tr -d ' ' || printf '0')
  case "$size" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$size" -lt ${SERVICE_LOG_MAX_BYTES} ] && return 0

  rm -f "$log.${SERVICE_LOG_ROTATIONS}" 2>/dev/null || true
  i=${SERVICE_LOG_ROTATIONS}
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    if [ -f "$log.$prev" ]; then
      mv "$log.$prev" "$log.$i" 2>/dev/null || true
    fi
    i=$prev
  done
  mv "$log" "$log.1" 2>/dev/null || true
}

rotate_tokenmaxxing_log ${quotedLogPath} || true`;
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
${renderWindowsLogRotation(logPath)}\r
>> ${cmdQuote(logPath)} echo [%DATE% %TIME%] tokenmaxxing service sync\r
${cmdQuote(commandPath)} ${serviceRunCommandArgs()} >> ${cmdQuote(logPath)} 2>&1\r
exit /b %ERRORLEVEL%\r
`;
}

function renderWindowsLogRotation(logPath: string): string {
  const quotedLogPath = cmdQuote(logPath);
  const moves = Array.from({ length: SERVICE_LOG_ROTATIONS - 1 }, (_, index) => {
    const rotation = SERVICE_LOG_ROTATIONS - index;
    const previousRotation = rotation - 1;

    return `  if exist "%TOKENMAXXING_LOG%.${previousRotation}" move /y "%TOKENMAXXING_LOG%.${previousRotation}" "%TOKENMAXXING_LOG%.${rotation}" >nul 2>nul`;
  }).join("\r\n");

  return `set "TOKENMAXXING_LOG=${escapeCmdSetValue(logPath)}"\r
if exist ${quotedLogPath} for %%A in (${quotedLogPath}) do if %%~zA GEQ ${SERVICE_LOG_MAX_BYTES} (\r
  if exist "%TOKENMAXXING_LOG%.${SERVICE_LOG_ROTATIONS}" del /f /q "%TOKENMAXXING_LOG%.${SERVICE_LOG_ROTATIONS}" >nul 2>nul\r
${moves}\r
  move /y "%TOKENMAXXING_LOG%" "%TOKENMAXXING_LOG%.1" >nul 2>nul\r
)`;
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
Description=tokenmaxxing automatic usage sync

[Service]
Type=oneshot
ExecStart=${systemdQuote(paths.wrapperPath)}
`;
}

function renderSystemdTimer(): string {
  return `[Unit]
Description=Run tokenmaxxing automatic usage sync

[Timer]
${renderSystemdTimerSchedule()}
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
    yield* runExecutable("schtasks", windowsTaskCreateArgs(paths));
  });
}

function windowsTaskCreateArgs(paths: ServicePaths): string[] {
  return [
    "/Create",
    "/TN",
    windowsTaskName(),
    "/SC",
    "MINUTE",
    "/MO",
    String(SERVICE_INTERVAL_MINUTES),
    "/TR",
    cmdQuote(paths.wrapperPath),
    "/F",
  ];
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
      const durableCommandPath = durableTokenmaxxingCommandPath(commandPath, resolvedCommandPath);

      return {
        autoUpdateManager: detectAutoUpdateManager({
          commandPath,
          env,
          platform,
          resolvedCommandPath,
        }),
        commandPath: durableCommandPath,
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
  const normalized = normalizePathForDetection(path);

  return (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/.bun/install/cache/") ||
    isTransientCommandShimPath(normalized) ||
    normalized.includes("/node_modules/.bin/")
  );
}

function durableTokenmaxxingCommandPath(commandPath: string, resolvedCommandPath: string): string {
  return isTransientCommandShimPath(commandPath) &&
    isDurableTokenmaxxingPackagePath(resolvedCommandPath)
    ? resolvedCommandPath
    : commandPath;
}

function isTransientCommandShimPath(path: string): boolean {
  const normalized = normalizePathForDetection(path);

  // fnm multishell bins live under a shell-session directory. Stable shims from nvm,
  // Volta, asdf, Homebrew, npm, pnpm, yarn, and Bun should stay untouched.
  return normalized.includes("/.local/state/fnm_multishells/");
}

function isDurableTokenmaxxingPackagePath(path: string): boolean {
  const normalized = normalizePathForDetection(path);

  return (
    normalized.includes("/node_modules/@851-labs/tokenmaxxing/") && !isEphemeralCommandPath(path)
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
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  durableTokenmaxxingCommandPath,
  detectAutoUpdateManager,
  findCommandOnPath,
  findTokenmaxxingCommandInstall,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  isServiceInstalled,
  legacyServiceWrapperPaths,
  deterministicServiceJitterMs,
  readServiceMetadata,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdTimer,
  refreshServiceAfterUpdate,
  scheduleDeferredServiceRepair,
  scheduleDescription,
  serviceScheduledSyncSince,
  serviceCommand,
  serviceInstallProgram,
  serviceLockStatus,
  serviceStateJson,
  servicePathsEffect,
  servicePaths,
  serviceRunFailureState,
  serviceRunLogLine,
  serviceRunSuccessState,
  runPackageManagerUpdate,
  windowsTaskNames,
  windowsTaskCreateArgs,
  ServiceAutoUpdateManagerError,
  ServiceCommandNotFoundError,
  ServiceEnvTokenError,
  ServiceEphemeralCommandError,
  ServiceInstallError,
  ServiceRepairError,
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
  ServiceState,
};
