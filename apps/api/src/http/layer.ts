import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { TokenmaxxingApi } from "@tokenmaxxing/api-contract";
import type { Authorization, CliAuth } from "@tokenmaxxing/api-contract";

import { AppConfig } from "../config";
import type { Drizzle } from "../database";

/**
 * Handler layers, one per contract group — pure pass-throughs over the
 * domain services. Groups whose milestone has not landed yet die with
 * "not implemented"; the contract still serves and typechecks end-to-end.
 */

const healthHandlers = HttpApiBuilder.group(TokenmaxxingApi, "health", (handlers) =>
  handlers.handle("status", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return {
        ok: true,
        product: config.productName,
        service: config.apiWorkerName,
      };
    }),
  ),
);

const meHandlers = HttpApiBuilder.group(TokenmaxxingApi, "me", (handlers) =>
  handlers
    .handle("me", () => Effect.die("not implemented"))
    .handle("approveCliLogin", () => Effect.die("not implemented"))
    .handle("listDevices", () => Effect.die("not implemented"))
    .handle("listTokens", () => Effect.die("not implemented"))
    .handle("revokeToken", () => Effect.die("not implemented")),
);

const cliLoginHandlers = HttpApiBuilder.group(TokenmaxxingApi, "cliLogin", (handlers) =>
  handlers
    .handle("start", () => Effect.die("not implemented"))
    .handle("poll", () => Effect.die("not implemented")),
);

const usageHandlers = HttpApiBuilder.group(TokenmaxxingApi, "usage", (handlers) =>
  handlers
    .handle("sync", () => Effect.die("not implemented"))
    .handle("logout", () => Effect.die("not implemented")),
);

const leaderboardHandlers = HttpApiBuilder.group(TokenmaxxingApi, "leaderboard", (handlers) =>
  handlers.handle("list", () => Effect.die("not implemented")),
);

const profilesHandlers = HttpApiBuilder.group(TokenmaxxingApi, "profiles", (handlers) =>
  handlers
    .handle("get", () => Effect.die("not implemented"))
    .handle("daily", () => Effect.die("not implemented")),
);

const handlersLayer = Layer.mergeAll(
  healthHandlers,
  meHandlers,
  cliLoginHandlers,
  usageHandlers,
  leaderboardHandlers,
  profilesHandlers,
);

interface ApiLayerOptions {
  appConfigLayer: Layer.Layer<AppConfig>;
  drizzleLayer: Layer.Layer<Drizzle>;
  middlewareLayer: Layer.Layer<Authorization | CliAuth, never, never>;
}

function makeApiLayer(options: ApiLayerOptions) {
  const apiLayer = HttpApiBuilder.layer(TokenmaxxingApi, { openapiPath: "/openapi.json" });

  return apiLayer.pipe(
    Layer.provide(handlersLayer),
    Layer.provide(options.middlewareLayer),
    Layer.provide(requestIdLayer),
    Layer.provide(corsLayer),
    Layer.provide(options.drizzleLayer),
    Layer.provide(options.appConfigLayer),
  );
}

function makeApiHttpEffect(options: ApiLayerOptions) {
  return makeApiLayer(options).pipe(
    Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
    HttpRouter.toHttpEffect,
    Effect.map(recoverDefects),
  );
}

/**
 * Schema decode failures respond with their own 400; every other defect
 * (store/decode faults died at the service boundary, bugs) is logged and
 * answered with an opaque 500 — internals never reach the wire.
 */
function recoverDefects<E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return Effect.catchDefect(httpEffect, (defect) =>
    HttpApiError.HttpApiSchemaError.is(defect)
      ? HttpServerRespondable.toResponse(defect)
      : Effect.logError("request died", defect).pipe(
          Effect.as(HttpServerResponse.empty({ status: 500 })),
        ),
  );
}

const corsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return HttpRouter.middleware(
      HttpMiddleware.cors({
        allowedOrigins: config.corsOrigins,
        // The Effect-derived client propagates trace context as BOTH W3C
        // traceparent and compact B3 (HttpTraceContext.toHeaders); a missing
        // entry here fails the preflight and the app reads every authed
        // call as signed-out.
        allowedHeaders: [
          "authorization",
          "b3",
          "content-type",
          "traceparent",
          "tracestate",
          "x-request-id",
        ],
        allowedMethods: ["DELETE", "GET", "PATCH", "POST", "PUT", "OPTIONS"],
        credentials: true,
      }),
      { global: true },
    );
  }),
);

/** Mints/propagates x-request-id; logs carry it via annotations. */
const requestIdLayer = HttpRouter.middleware(
  (httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestId = request.headers["x-request-id"] ?? crypto.randomUUID();
      const response = yield* httpApp.pipe(Effect.annotateLogs("requestId", requestId));
      return HttpServerResponse.setHeader(response, "x-request-id", requestId);
    }),
  { global: true },
);

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export { makeApiHttpEffect, makeApiLayer };

export type { ApiLayerOptions };
