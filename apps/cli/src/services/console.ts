import { Context, Layer } from "effect";

class ConsoleService extends Context.Service<
  ConsoleService,
  Pick<typeof console, "error" | "log">
>()("ConsoleService") {}

const ConsoleLive = Layer.succeed(ConsoleService)(console);

export { ConsoleLive, ConsoleService };
