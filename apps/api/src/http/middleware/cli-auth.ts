import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";

import { CliAuth, CurrentCliIdentity, Unauthorized } from "@tokenmaxxing/api-contract";
import type { CliIdentity } from "@tokenmaxxing/api-contract";

import { TokensService } from "../../tokens/service";

/**
 * Bearer-only authentication for the CLI surface: a raw `tmx_` token
 * resolved against cli_tokens (hashed, revocation-checked). No cookies —
 * browsers have no business on these endpoints.
 */

const CliAuthLive = Layer.effect(
  CliAuth,
  Effect.gen(function* () {
    const tokens = yield* TokensService;

    return CliAuth.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"];
        const rawToken = authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
        const identity =
          rawToken === null
            ? Option.none<typeof CliIdentity.Type>()
            : yield* tokens
                .resolveCliToken(rawToken)
                .pipe(Effect.catchCause(() => Effect.succeedNone));
        if (Option.isNone(identity)) {
          return yield* Effect.fail(
            new Unauthorized({ message: "Run `tokenmaxxing login` first." }),
          );
        }

        return yield* Effect.provideService(httpEffect, CurrentCliIdentity, identity.value);
      }),
    );
  }),
);

export { CliAuthLive };
