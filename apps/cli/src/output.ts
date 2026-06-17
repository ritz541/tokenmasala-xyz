import * as prompts from "@clack/prompts";
import { Effect } from "effect";

import { ConsoleService } from "./services";

interface HumanOutputOptions {
  json?: boolean;
  silent?: boolean;
}

type HumanLogLevel = "error" | "info" | "step" | "success" | "warn";

interface HumanSpinner {
  error: (message?: string) => void;
  stop: (message?: string) => void;
}

function writeJson(value: unknown) {
  return Effect.gen(function* () {
    const output = yield* Effect.service(ConsoleService);

    yield* Effect.sync(() => output.log(JSON.stringify(value)));
  });
}

function humanIntro(title: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        prompts.intro(title);
      } else {
        output.log(title);
      }
    });
  });
}

function humanOutro(message: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        prompts.outro(message);
      } else {
        output.log(message);
      }
    });
  });
}

function humanFrame<A, E, R>(
  title: string,
  options: HumanOutputOptions,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options) || !shouldUseClack()) {
      return yield* effect;
    }

    yield* humanIntro(title, options);
    const result = yield* effect;
    yield* humanOutro("Done", options);

    return result;
  });
}

function humanLog(level: HumanLogLevel, message: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        prompts.log[level](message);
      } else if (level === "error") {
        output.error(message);
      } else {
        output.log(message);
      }
    });
  });
}

function humanNote(title: string, message: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        prompts.note(message, title);
      } else {
        output.log(title);
        output.log(message);
      }
    });
  });
}

function humanSpinner(message: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    const output = yield* Effect.service(ConsoleService);
    if (!shouldWriteHumanOutput(options)) {
      return {
        error: () => {},
        stop: () => {},
      } satisfies HumanSpinner;
    }

    if (shouldUseClack()) {
      const spinner = prompts.spinner();
      spinner.start(message);

      return {
        error: (nextMessage?: string) => spinner.error(nextMessage),
        stop: (nextMessage?: string) => spinner.stop(nextMessage),
      } satisfies HumanSpinner;
    }

    output.log(message);

    return {
      error: (nextMessage?: string) => {
        if (nextMessage !== undefined) {
          output.error(nextMessage);
        }
      },
      stop: () => {},
    } satisfies HumanSpinner;
  });
}

function shouldWriteHumanOutput(options: HumanOutputOptions = {}): boolean {
  return options.json !== true && options.silent !== true;
}

function shouldUseClack(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.stderr.isTTY === true &&
    process.env.CI !== "true" &&
    process.env.TERM !== "dumb" &&
    !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR")
  );
}

export {
  humanFrame,
  humanIntro,
  humanLog,
  humanNote,
  humanOutro,
  humanSpinner,
  shouldUseClack,
  shouldWriteHumanOutput,
  writeJson,
};

export type { HumanOutputOptions, HumanSpinner };
