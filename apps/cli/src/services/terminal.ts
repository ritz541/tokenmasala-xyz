import { Context, Effect, Layer } from "effect";

class TerminalService extends Context.Service<
  TerminalService,
  {
    readonly isInteractive: Effect.Effect<boolean>;
  }
>()("TerminalService") {}

const TerminalLive = Layer.succeed(TerminalService)({
  isInteractive: Effect.sync(() => Boolean(process.stdin.isTTY && process.stderr.isTTY)),
});

export { TerminalLive, TerminalService };
