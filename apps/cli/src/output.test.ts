import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleService } from "./services";
import { humanFrame, humanLog } from "./output";

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
    step: (message: string) => {
      promptCalls.push(`step:${message}`);
    },
    success: (message: string) => {
      promptCalls.push(`success:${message}`);
    },
    warn: (message: string) => {
      promptCalls.push(`warn:${message}`);
    },
  },
  note: (message: string, title: string) => {
    promptCalls.push(`note:${title}:${message}`);
  },
  outro: (message: string) => {
    promptCalls.push(`outro:${message}`);
  },
  spinner: () => ({
    error: (message?: string) => {
      promptCalls.push(`spinner-error:${message ?? ""}`);
    },
    start: (message: string) => {
      promptCalls.push(`spinner-start:${message}`);
    },
    stop: (message?: string) => {
      promptCalls.push(`spinner-stop:${message ?? ""}`);
    },
  }),
}));

const originalStdoutIsTty = process.stdout.isTTY;
const originalStderrIsTty = process.stderr.isTTY;
const originalCi = process.env.CI;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

function testConsole() {
  const logs: string[] = [];
  const layer = Layer.succeed(ConsoleService)({
    error: (message?: unknown) => {
      logs.push(`error:${String(message)}`);
    },
    log: (message?: unknown) => {
      logs.push(`log:${String(message)}`);
    },
  });

  return { layer, logs };
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

describe("humanFrame", () => {
  afterEach(() => {
    promptCalls.length = 0;
    restoreEnvironment();
  });

  it("wraps interactive Clack output with intro and outro", async () => {
    const { layer } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(
      humanFrame("Upgrade", {}, humanLog("info", "Running upgrade", {})).pipe(
        Effect.provide(layer),
      ),
    );

    expect(promptCalls).toEqual(["intro:Upgrade", "info:Running upgrade", "outro:Done"]);
  });

  it("does not print an outro when the wrapped effect fails", async () => {
    const { layer } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    const exit = await Effect.runPromiseExit(
      humanFrame("Upgrade", {}, Effect.fail("boom")).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(promptCalls).toEqual(["intro:Upgrade"]);
  });

  it("leaves non-Clack output unframed", async () => {
    const { layer, logs } = testConsole();
    setTty(false);

    await Effect.runPromise(
      humanFrame("Upgrade", {}, humanLog("info", "Running upgrade", {})).pipe(
        Effect.provide(layer),
      ),
    );

    expect(promptCalls).toEqual([]);
    expect(logs).toEqual(["log:Running upgrade"]);
  });

  it("does not frame JSON output", async () => {
    const { layer, logs } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(
      humanFrame(
        "Upgrade",
        { json: true },
        humanLog("info", "Running upgrade", { json: true }),
      ).pipe(Effect.provide(layer)),
    );

    expect(promptCalls).toEqual([]);
    expect(logs).toEqual([]);
  });
});

export {};
