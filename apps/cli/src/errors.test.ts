import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleService } from "./services";
import { clackFailureForCliFailure, renderCliFailure } from "./errors";
import { NotLoggedInError } from "./commands/whoami";

const promptCalls = vi.hoisted((): string[] => []);

vi.mock("@clack/prompts", () => ({
  intro: (title: string) => {
    promptCalls.push(`intro:${title}`);
  },
  log: {
    error: (message: string) => {
      promptCalls.push(`error:${message}`);
    },
    info: (message: string) => {
      promptCalls.push(`info:${message}`);
    },
  },
  outro: (message: string) => {
    promptCalls.push(`outro:${message}`);
  },
}));

const originalStdoutIsTty = process.stdout.isTTY;
const originalStderrIsTty = process.stderr.isTTY;
const originalCi = process.env.CI;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

function testConsole() {
  const errors: string[] = [];
  const logs: string[] = [];
  const layer = Layer.succeed(ConsoleService)({
    error: (message?: unknown) => {
      errors.push(String(message));
    },
    log: (message?: unknown) => {
      logs.push(String(message));
    },
  });

  return { errors, layer, logs };
}

function setTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });
}

function restoreEnvironment() {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTty,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: originalStderrIsTty,
  });

  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
  if (originalTerm === undefined) {
    delete process.env.TERM;
  } else {
    process.env.TERM = originalTerm;
  }
}

describe("renderCliFailure", () => {
  afterEach(() => {
    promptCalls.length = 0;
    restoreEnvironment();
  });

  it("renders expected failures as strict JSON when --json is active", async () => {
    const { errors, layer, logs } = testConsole();

    const exit = await Effect.runPromiseExit(
      Effect.fail(new NotLoggedInError()).pipe(
        Effect.tapCause((cause) => renderCliFailure(cause, { json: true, verbose: false })),
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toEqual({
      error: {
        code: "not_logged_in",
        hint: "run tokenmaxxing login",
        message: "not logged in",
      },
      status: "error",
    });
  });

  it("renders expected failures as plain text without Clack", async () => {
    const { errors, layer, logs } = testConsole();
    setTty(false);

    const exit = await Effect.runPromiseExit(
      Effect.fail(new NotLoggedInError()).pipe(
        Effect.tapCause((cause) => renderCliFailure(cause, { json: false, verbose: false })),
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(logs).toEqual([]);
    expect(promptCalls).toEqual([]);
    expect(errors).toEqual(["error: not logged in\nhint: run tokenmaxxing login"]);
  });

  it("renders expected failures through Clack when interactive", async () => {
    const { errors, layer, logs } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    const exit = await Effect.runPromiseExit(
      Effect.fail(new NotLoggedInError()).pipe(
        Effect.tapCause((cause) => renderCliFailure(cause, { json: false, verbose: false })),
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(promptCalls).toEqual([
      "error:Not logged in",
      "info:Hint: run tokenmaxxing login",
      "outro:Failed",
    ]);
  });

  it("includes debug output in verbose mode", async () => {
    const { errors, layer } = testConsole();
    setTty(false);

    const exit = await Effect.runPromiseExit(
      Effect.fail(new NotLoggedInError()).pipe(
        Effect.tapCause((cause) => renderCliFailure(cause, { json: false, verbose: true })),
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(errors[0]).toBe("error: not logged in\nhint: run tokenmaxxing login");
    expect(errors[1]).toContain("debug:\n");
  });
});

describe("clackFailureForCliFailure", () => {
  it("splits the redundant error prefix, context, and hint", () => {
    expect(
      clackFailureForCliFailure(
        "error: could not detect install\npath: /usr/local/bin/tokenmaxxing\nhint: reinstall with npm",
      ),
    ).toEqual({
      context: ["path: /usr/local/bin/tokenmaxxing"],
      hint: "reinstall with npm",
      message: "could not detect install",
    });
  });
});

export {};
