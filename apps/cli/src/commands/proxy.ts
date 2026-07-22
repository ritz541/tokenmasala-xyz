/**
 * `tokenmaxxing proxy` — the P2 local forwarder.
 *
 * Starts an HTTP server on `--port` (default 8787). Every request it receives
 * is forwarded to the real upstream API (resolved per-request by
 * `proxy/router.ts`), and any chat-completion/completion usage in the response
 * becomes an append-only `UsageEventInput` that is buffered and flushed to
 * `POST /usage/events`.
 *
 * Friends point their harness at `http://localhost:8787` (optionally with an
 * `/openai` or `/anthropic` path prefix) and every provider call — including
 * VS Code extensions and obscure SDK harnesses the log scraper misses — is
 * captured automatically. Harness attribution can be pinned with `--label`.
 *
 * Foreground human usage wraps the long-running loop in `humanFrame`/`humanLog`
 * so the user sees the listening URL; `--json`/`--silent` paths stay quiet and
 * just run the server (suitable for the background service).
 */

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { UsageEventInput } from "../proxy/server";
import { createProxyServer } from "../proxy/server";

import { ApiClientService, ConfigService, type TokenmaxxingApiClient } from "../services";
import { humanFrame, humanLog, writeJson } from "../output";
import { validateCurrentLogin } from "../auth-validation";

const DEFAULT_PROXY_PORT = 8787;

class ProxyAuthError extends Error {
  override message = "error: proxy needs a stored login to flush usage\nhint: run tokenmaxxing login, then tokenmaxxing proxy";
}

class ProxyStartError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ProxyStartError";
  }

  override get message() {
    return `error: failed to start proxy\nhint: ${super.message}`;
  }
}

const proxyCommand = Command.make(
  "proxy",
  {
    flush: Flag.boolean("flush").pipe(
      Flag.withDescription("Flush buffered events to the API (default on; pass --no-flush to disable)"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable status")),
    label: Flag.string("label").pipe(
      Flag.optional,
      Flag.withDescription(
        "Force a single harness label for every event (e.g. claude, codex, my-vscode-ext)",
      ),
    ),
    port: Flag.integer("port").pipe(
      Flag.optional,
      Flag.withDescription(`Local port to listen on (default: ${DEFAULT_PROXY_PORT})`),
    ),
  },
  ({ flush, json, label, port }) =>
    proxyEffect({
      flush: flush !== false,
      json,
      label: Option.getOrUndefined(label),
      port: Option.getOrUndefined(port),
    }),
).pipe(
  Command.withDescription("Run a local proxy that captures token usage from any API call"),
);

interface ProxyOptions {
  readonly flush: boolean;
  readonly json: boolean | undefined;
  readonly label?: string | undefined;
  readonly port?: number | undefined;
}

interface ProxyResult {
  readonly flush: boolean;
  readonly label?: string | undefined;
  readonly port: number;
  readonly status: "running" | "started";
}

function proxyEffect(options: ProxyOptions) {
  return humanFrame(
    "Proxy",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const clients = yield* Effect.service(ApiClientService);

      const port = options.port ?? DEFAULT_PROXY_PORT;
      const stored = yield* config.readConfig();

      // Build the upload function. When --no-flush is set we never hit the
      // network; otherwise we need a valid login so the bearer token is sent.
      let flush: (events: readonly UsageEventInput[]) => Promise<void>;
      if (options.flush === false) {
        flush = async () => {};
      } else {
        if (stored.token === undefined) {
          return yield* Effect.fail(new ProxyAuthError());
        }
        const client: TokenmaxxingApiClient = yield* clients.make({
          baseUrl: stored.apiUrl,
          token: stored.token,
        });
        yield* validateCurrentLogin(client, { json: options.json === true }).pipe(
          Effect.flatMap((validation) =>
            validation._tag !== "valid"
              ? Effect.fail(new ProxyAuthError())
              : Effect.void,
          ),
        );
        const device = {
          arch: undefined,
          name: "",
          platform: process.platform,
          version: undefined,
        };
        flush = async (events: readonly UsageEventInput[]) => {
          if (events.length === 0) {
            return;
          }
          await client.usage.events({
            payload: {
              device,
              events,
            },
          });
        };
      }

      const handle = yield* Effect.promise(() => createProxyServer(port, {
        label: options.label,
        maxBuffer: 25,
        upload: (events) => flush(events),
      })).pipe(Effect.catch((cause) => Effect.fail(new ProxyStartError(cause))));

      const result: ProxyResult = {
        flush: options.flush,
        label: options.label,
        port: handle.port,
        status: "running",
      };

      if (options.json === true) {
        yield* writeJson(result);
      } else {
        const upstreamHint = options.flush
          ? " (usage will be flushed to tokenmasala.xyz)"
          : " (events buffered, not flushed — pass --flush to enable upload)";
        const labelHint =
          options.label !== undefined && options.label.trim() !== ""
            ? ` with label "${options.label.trim()}"`
            : "";
        yield* humanLog(
          "success",
          `Proxy listening on http://localhost:${handle.port}${labelHint}${upstreamHint}`,
          options,
        );
        yield* humanLog("info", "Point your harness base URL here, then press Ctrl-C to stop", options);
      }

      // Keep the process alive until interrupted. The server's flush timer runs
      // on its own interval; we just await an abort signal.
      yield* Effect.promise<void>(() =>
        new Promise<void>((resolve, reject) => {
          const onInterrupt = () => {
            void handle.stop().then(
              () => resolve(),
              (cause) => reject(new ProxyStartError(cause)),
            );
          };
          process.on("SIGINT", onInterrupt);
          process.on("SIGTERM", onInterrupt);
        }),
      );

      return result;
    }),
  );
}

export { proxyCommand };
