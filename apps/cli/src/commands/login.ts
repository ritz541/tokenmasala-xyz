import { hostname } from "node:os";

import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { AuthUser } from "@tokenmaxxing/api-contract";

import {
  ApiClientService,
  BrowserService,
  ClockService,
  type CliConfig,
  ConfigService,
  TerminalService,
} from "../services";
import { formatUrl, humanFrame, humanLog, writeJson } from "../output";

class StartCliLoginError extends Data.TaggedError("StartCliLoginError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed to start CLI login\nhint: check your network and try again";
}

class PollCliLoginError extends Data.TaggedError("PollCliLoginError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed to poll CLI login\nhint: run tokenmaxxing login again";
}

class OpenBrowserError extends Data.TaggedError("OpenBrowserError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to open browser\nhint: run tokenmaxxing login without --json to approve manually, or set TOKENMAXXING_API_TOKEN";
}

class WriteCliTokenError extends Data.TaggedError("WriteCliTokenError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to write CLI token\nhint: check TOKENMAXXING_CONFIG_DIR permissions";
}

class LoginSleepError extends Data.TaggedError("LoginSleepError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed while waiting for CLI login";
}

class LoginTimeoutError extends Data.TaggedError("LoginTimeoutError")<{}> {
  override message = "error: timed out waiting for CLI login\nhint: run tokenmaxxing login again";
}

class AlreadyLoggedInError extends Data.TaggedError("AlreadyLoggedInError")<{
  readonly envTokenActive: boolean;
}> {
  override get message() {
    if (this.envTokenActive) {
      return "error: already logged in\nhint: run tokenmaxxing logout first, or unset TOKENMAXXING_API_TOKEN before logging in again";
    }

    return "error: already logged in\nhint: run tokenmaxxing logout first before logging in again";
  }
}

class NonInteractiveLoginError extends Data.TaggedError("NonInteractiveLoginError")<{}> {
  override message =
    "error: cannot run browser login without an interactive terminal\nhint: set TOKENMAXXING_API_TOKEN for non-interactive environments";
}

const MAX_POLL_ATTEMPTS = 150;

interface BrowserLoginOptions {
  json: boolean;
}

interface BrowserLoginResult {
  config: CliConfig;
  user: AuthUser;
}

const loginCommand = Command.make(
  "login",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => loginEffect({ json }),
).pipe(Command.withDescription("Log in to tokenmaxxing via your browser"));

function loginEffect(options: { json: boolean }) {
  return humanFrame(
    "Login",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);

      const stored = yield* config.readConfig();
      const envTokenActive = yield* config.hasEnvToken();
      if (stored.token !== undefined || envTokenActive) {
        return yield* Effect.fail(new AlreadyLoggedInError({ envTokenActive }));
      }

      const login = yield* browserLoginEffect(options);
      if (options.json) {
        yield* writeJson({ login: login.user.login, status: "ok" });
      }
    }),
  );
}

function browserLoginEffect(options: BrowserLoginOptions) {
  return Effect.gen(function* () {
    const browser = yield* Effect.service(BrowserService);
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);
    const terminal = yield* Effect.service(TerminalService);

    const stored = yield* config.readConfig();
    if (!(yield* terminal.isInteractive)) {
      return yield* Effect.fail(new NonInteractiveLoginError());
    }
    const canOpenBrowser = yield* terminal.canOpenExternalBrowser;
    if (options.json && !canOpenBrowser) {
      return yield* Effect.fail(
        new OpenBrowserError({ cause: "External browser launch is unavailable." }),
      );
    }

    const deviceId = yield* config.ensureDeviceId();
    const client = yield* clients.make({ baseUrl: stored.apiUrl });

    const start = yield* client.cliLogin
      .start({
        payload: {
          deviceId,
          deviceName: hostname(),
          devicePlatform: process.platform,
        },
      })
      .pipe(Effect.mapError((cause) => new StartCliLoginError({ cause })));

    yield* humanLog("info", `Opening ${formatUrl(start.verificationUri)}`, options);
    yield* humanLog("info", `Code: ${start.code}`, options);
    if (canOpenBrowser) {
      const openResult = yield* browser.open(start.verificationUri).pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: () => ({ _tag: "success" as const }),
        }),
      );
      if (openResult._tag === "failure") {
        if (options.json) {
          return yield* Effect.fail(new OpenBrowserError({ cause: openResult.cause }));
        }

        yield* humanLog(
          "error",
          "Could not open a browser automatically; open the URL above manually.",
          options,
        );
      }
    } else {
      yield* humanLog("error", "Open the URL above in your browser to continue.", options);
    }

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const poll = yield* client.cliLogin
        .poll({ payload: { code: start.code } })
        .pipe(Effect.mapError((cause) => new PollCliLoginError({ cause })));

      if (poll.status === "complete") {
        const written = yield* config
          .writeToken(poll.token)
          .pipe(Effect.mapError((cause) => new WriteCliTokenError({ cause })));
        const nextConfig = {
          ...written,
          apiUrl: stored.apiUrl,
          token: poll.token,
          wwwUrl: stored.wwwUrl,
        };

        yield* humanLog("success", `Logged in as ${poll.user.login}.`, options);
        return { config: nextConfig, user: poll.user };
      }

      yield* clock
        .sleep(start.intervalSeconds * 1000)
        .pipe(Effect.mapError((cause) => new LoginSleepError({ cause })));
    }

    return yield* Effect.fail(new LoginTimeoutError());
  });
}

export {
  AlreadyLoggedInError,
  browserLoginEffect,
  loginCommand,
  loginEffect,
  LoginSleepError,
  LoginTimeoutError,
  NonInteractiveLoginError,
  OpenBrowserError,
  PollCliLoginError,
  StartCliLoginError,
  WriteCliTokenError,
};

export type { BrowserLoginOptions, BrowserLoginResult };
