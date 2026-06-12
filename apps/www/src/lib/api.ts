import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TokenmaxxingApi } from "@tokenmaxxing/api-contract";

import { resolveApiUrl } from "./config";

/**
 * The typed client derived from the shared contract, cookie-authenticated
 * (credentials ride on every request). Library functions keep Promise
 * signatures — Effects stay inside this module; components never see them.
 */

type TokenmaxxingApiClient = HttpApiClient.ForApi<typeof TokenmaxxingApi>;

interface ApiClientHandle {
  client(): Promise<TokenmaxxingApiClient>;
  run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A>;
}

function createApiClient(apiUrl: string): ApiClientHandle {
  const layer = Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
  );
  const runtime = ManagedRuntime.make(layer);

  let cached: Promise<TokenmaxxingApiClient> | null = null;
  const build = HttpApiClient.make(TokenmaxxingApi, {
    baseUrl: apiUrl.replace(/\/$/, ""),
  });

  return {
    client: () => (cached ??= runtime.runPromise(build)),
    run: (effect) => runtime.runPromise(effect),
  };
}

let handle: ApiClientHandle | null = null;

function clientHandle(): ApiClientHandle {
  handle ??= createApiClient(resolveApiUrl());
  return handle;
}

async function runApi<A, E>(
  call: (client: TokenmaxxingApiClient) => Effect.Effect<A, E, never>,
): Promise<A> {
  const active = clientHandle();
  const client = await active.client();

  return active.run(call(client));
}

/** Best-effort message extraction from the contract's tagged errors. */
function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    const inner =
      typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Fail"
        ? ((cause as { error?: unknown }).error ?? cause)
        : cause;
    const message = (inner as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return fallback;
}

/** Raw routes (OAuth signout) sit outside the derived client. */
async function signOut(): Promise<void> {
  await fetch(`${resolveApiUrl()}/auth/signout`, {
    credentials: "include",
    method: "POST",
  });
}

export { errorMessage, runApi, signOut };

export type { TokenmaxxingApiClient };
