import { Context, Effect, Layer } from "effect";

class ClockService extends Context.Service<
  ClockService,
  {
    readonly sleep: (ms: number) => Effect.Effect<void, unknown>;
  }
>()("ClockService") {}

const ClockLive = Layer.succeed(ClockService)({
  sleep: (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms))),
});

export { ClockLive, ClockService };
