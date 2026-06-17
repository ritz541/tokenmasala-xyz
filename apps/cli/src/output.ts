import * as prompts from "@clack/prompts";
import { Effect } from "effect";

import { ConsoleService } from "./services";

interface HumanOutputOptions {
  json?: boolean;
  silent?: boolean;
}

interface FormatUrlOptions {
  env?: Record<string, string | undefined>;
}

type HumanLogLevel = "error" | "info" | "step" | "success" | "warn";

interface HumanFailureContent {
  context?: readonly string[];
  hint?: string | undefined;
  message: string;
}

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

function formatUrl(url: string, options: FormatUrlOptions = {}): string {
  const env = options.env ?? process.env;
  return Object.prototype.hasOwnProperty.call(env, "NO_COLOR") ? url : `\x1b[36;4m${url}\x1b[0m`;
}

function humanIntro(title: string, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        prompts.intro(formatClackRow(title));
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
        prompts.outro(formatClackRow(message));
      } else {
        output.log(message);
      }
    });
  });
}

function humanFailure(failure: string | HumanFailureContent, options: HumanOutputOptions = {}) {
  return Effect.gen(function* () {
    if (!shouldWriteHumanOutput(options)) {
      return;
    }

    const output = yield* Effect.service(ConsoleService);
    yield* Effect.sync(() => {
      if (shouldUseClack()) {
        if (typeof failure === "string") {
          prompts.log.error(formatClackRow(failure));
        } else {
          prompts.log.error(formatClackRow(failure.message));
          for (const line of failure.context ?? []) {
            prompts.log.info(formatClackRow(line));
          }
          if (failure.hint !== undefined) {
            prompts.log.info(formatClackRow(`Hint: ${failure.hint}`));
          }
        }
        prompts.outro("Failed");
      } else {
        output.error(typeof failure === "string" ? failure : plainFailureMessage(failure));
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
        prompts.log[level](formatClackRow(message));
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
        prompts.note(formatClackRow(message), formatClackRow(title));
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
      spinner.start(formatClackRow(message));

      return {
        error: (nextMessage?: string) =>
          spinner.error(nextMessage === undefined ? nextMessage : formatClackRow(nextMessage)),
        stop: (nextMessage?: string) =>
          spinner.stop(nextMessage === undefined ? nextMessage : formatClackRow(nextMessage)),
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

function plainFailureMessage(failure: HumanFailureContent): string {
  const lines = [failure.message, ...(failure.context ?? [])];
  if (failure.hint !== undefined) {
    lines.push(`hint: ${failure.hint}`);
  }

  return lines.join("\n");
}

function formatClackRow(message: string): string {
  return message
    .split("\n")
    .map((line) => capitalizeClackLine(line))
    .join("\n");
}

function capitalizeClackLine(line: string): string {
  const visibleStart = firstVisibleCharacterIndex(line);
  const rest = line.slice(visibleStart);
  if (shouldPreserveInitialToken(rest)) {
    return line;
  }

  const letterIndex = firstAlphabeticalCharacterIndex(line, visibleStart);
  if (letterIndex === -1) {
    return line;
  }

  const letter = line[letterIndex] ?? "";
  return `${line.slice(0, letterIndex)}${letter.toLocaleUpperCase("en-US")}${line.slice(
    letterIndex + 1,
  )}`;
}

function firstVisibleCharacterIndex(line: string): number {
  let index = 0;

  while (index < line.length) {
    const char = line[index];
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }

    const ansiLength = ansiSequenceLengthAt(line, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }

    break;
  }

  return index;
}

function ansiSequenceLengthAt(line: string, index: number): number {
  if (line.charCodeAt(index) !== 0x1b || line[index + 1] !== "[") {
    return 0;
  }

  let cursor = index + 2;
  while (cursor < line.length) {
    const code = line.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor - index + 1;
    }
    cursor += 1;
  }

  return 0;
}

function shouldPreserveInitialToken(rest: string): boolean {
  return (
    rest.startsWith("http://") ||
    rest.startsWith("https://") ||
    rest.startsWith("/") ||
    rest.startsWith("./") ||
    rest.startsWith("../") ||
    rest.startsWith("~/") ||
    rest.startsWith("@") ||
    rest.startsWith("-")
  );
}

function firstAlphabeticalCharacterIndex(line: string, start: number): number {
  let index = start;

  while (index < line.length) {
    const ansiLength = ansiSequenceLengthAt(line, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }

    if (/[a-z]/.test(line[index] ?? "")) {
      return index;
    }

    if (/[A-Z]/.test(line[index] ?? "")) {
      return -1;
    }

    index += 1;
  }

  return -1;
}

export {
  formatClackRow,
  formatUrl,
  humanFailure,
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

export type { FormatUrlOptions, HumanFailureContent, HumanOutputOptions, HumanSpinner };
