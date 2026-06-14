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
  ConsoleService,
  TerminalService,
} from "../services";

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
  override message = "error: failed to open browser\nhint: open the login URL printed above";
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
      return "error: already logged in to tokenmaxxing\nhint: run tokenmaxxing logout first, or unset TOKENMAXXING_API_TOKEN before logging in again";
    }

    return "error: already logged in to tokenmaxxing\nhint: run tokenmaxxing logout first before logging in again";
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
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);

    const stored = yield* config.readConfig();
    const envTokenActive = yield* config.hasEnvToken();
    if (stored.token !== undefined || envTokenActive) {
      return yield* Effect.fail(new AlreadyLoggedInError({ envTokenActive }));
    }

    const login = yield* browserLoginEffect(options);
    yield* Effect.sync(() => {
      if (options.json) {
        console.log(JSON.stringify({ login: login.user.login, status: "ok" }));
      }
    });
  });
}

function browserLoginEffect(options: BrowserLoginOptions) {
  return Effect.gen(function* () {
    const browser = yield* Effect.service(BrowserService);
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);
    const console = yield* Effect.service(ConsoleService);
    const terminal = yield* Effect.service(TerminalService);

    const output = options.json ? { error: console.error, log: () => {} } : console;

    const stored = yield* config.readConfig();
    if (!(yield* terminal.isInteractive)) {
      return yield* Effect.fail(new NonInteractiveLoginError());
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

    yield* Effect.sync(() => {
      output.log(`Opening ${start.verificationUri}`);
      output.log(`Code: ${start.code}`);
    });
    yield* browser
      .open(start.verificationUri)
      .pipe(Effect.mapError((cause) => new OpenBrowserError({ cause })));

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

        yield* Effect.sync(() => {
          if (!options.json) {
            output.log(`Logged in as ${poll.user.login}.`);
          }
        });
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
