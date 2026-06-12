import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AuthRepositoryLive } from "./auth/d1";
import { AuthService, makeAuthService } from "./auth/service";
import { Database } from "./cloudflare/database";
import { CliLoginRepositoryLive } from "./clilogin/d1";
import { CliLoginService, makeCliLoginService } from "./clilogin/service";
import { AppConfig } from "./config";
import { Drizzle } from "./database";
import { GitHubClient, makeGitHubClient } from "./github/client";
import { AuthorizationLive } from "./http/middleware/authorization";
import { CliAuthLive } from "./http/middleware/cli-auth";
import { makeApiHttpEffect } from "./http/layer";
import { makeTokensService, TokensService } from "./tokens/service";
import { TokensRepositoryLive } from "./tokens/d1";

const ApiWorker = Cloudflare.Worker(
  "api",
  {
    name: "tokenmaxxing-api",
    main: import.meta.filename,
    url: false,
    compatibility: {
      date: "2026-06-02",
      flags: ["nodejs_compat"],
    },
    domain: "api.tokenmaxxing.851.sh",
    observability: {
      enabled: true,
    },
    dev: {
      port: 8788,
      strictPort: true,
    },
  },
  Effect.gen(function* () {
    const connection = yield* Cloudflare.D1Connection.bind(Database);

    // Config reads stay in this outer Effect so alchemy's deploy-time
    // binding discovery sees them (secrets bind as secret_text).
    const config = yield* AppConfig.fromEnv;
    const appConfigLayer = Layer.succeed(AppConfig, config);
    const drizzleLayer = Drizzle.layer(connection);

    const auth = yield* makeAuthService().pipe(
      Effect.provide(AuthRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const cliLogin = yield* makeCliLoginService().pipe(
      Effect.provide(CliLoginRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const tokens = yield* makeTokensService().pipe(
      Effect.provide(TokensRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const github = yield* makeGitHubClient().pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(AppConfig, config),
    );

    // Handlers and raw routes (OAuth) resolve these services at request
    // time, not layer-build time — this context rides along with every
    // routed request.
    const rawRouteServices = Context.empty().pipe(
      Context.add(AppConfig, config),
      Context.add(AuthService, auth),
      Context.add(CliLoginService, cliLogin),
      Context.add(GitHubClient, github),
      Context.add(TokensService, tokens),
    );

    return {
      fetch: makeApiHttpEffect({
        appConfigLayer,
        authServiceLayer: Layer.succeed(AuthService, auth),
        cliLoginServiceLayer: Layer.succeed(CliLoginService, cliLogin),
        drizzleLayer,
        middlewareLayer: Layer.mergeAll(AuthorizationLive, CliAuthLive),
        tokensServiceLayer: Layer.succeed(TokensService, tokens),
      }).pipe(Effect.map((apiHttpEffect) => apiHttpEffect.pipe(Effect.provide(rawRouteServices)))),
    };
  }).pipe(Effect.provide([Cloudflare.D1ConnectionLive, Cloudflare.D1ConnectionPolicyLive])),
);

export default ApiWorker;
