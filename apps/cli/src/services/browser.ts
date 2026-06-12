import { spawn } from "node:child_process";

import { Context, Effect, Layer } from "effect";

class BrowserService extends Context.Service<
  BrowserService,
  {
    readonly open: (url: string) => Effect.Effect<void, unknown>;
  }
>()("BrowserService") {}

const BrowserLive = Layer.succeed(BrowserService)({
  open: (url) =>
    Effect.tryPromise({
      try: () => openUrl(url),
      catch: (cause) => cause,
    }),
});

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

export { BrowserLive, BrowserService };
