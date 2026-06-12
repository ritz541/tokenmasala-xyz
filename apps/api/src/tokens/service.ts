import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TokenNotFound } from "@tokenmaxxing/api-contract";
import type { CliIdentity, CliTokenSummary, DeviceSummary } from "@tokenmaxxing/api-contract";

import { CLI_TOKEN_PREFIX, hashCliToken } from "../auth/crypto";
import type { DatabaseError } from "../database";

/**
 * CLI token resolution and the settings surface (devices + tokens). Tokens
 * never expire — `revokedAt` is the only kill switch, so resolution checks
 * revocation and freshness only via `lastUsedAt` bookkeeping.
 */

interface TokensServiceShape {
  /** Resolves a raw `tmx_` bearer; touches lastUsedAt on success. */
  resolveCliToken(
    rawToken: string,
  ): Effect.Effect<Option.Option<typeof CliIdentity.Type>, never, any>;
  listDevices(userId: string): Effect.Effect<(typeof DeviceSummary.Type)[], never, any>;
  listTokens(userId: string): Effect.Effect<(typeof CliTokenSummary.Type)[], never, any>;
  revokeToken(userId: string, tokenId: string): Effect.Effect<void, TokenNotFound, any>;
}

interface TokensRepositoryShape {
  findIdentityByHash(
    tokenHash: string,
    now: Date,
  ): Effect.Effect<Option.Option<typeof CliIdentity.Type>, DatabaseError, any>;
  listDevices(userId: string): Effect.Effect<(typeof DeviceSummary.Type)[], DatabaseError, any>;
  listTokens(userId: string): Effect.Effect<(typeof CliTokenSummary.Type)[], DatabaseError, any>;
  revokeToken(
    userId: string,
    tokenId: string,
    now: Date,
  ): Effect.Effect<boolean, DatabaseError, any>;
}

class TokensService extends Context.Service<TokensService, TokensServiceShape>()(
  "@tokenmaxxing/api/TokensService",
) {}

class TokensRepository extends Context.Service<TokensRepository, TokensRepositoryShape>()(
  "@tokenmaxxing/api/TokensRepository",
) {}

const makeTokensService = Effect.fn("makeTokensService")(function* () {
  const repository = yield* TokensRepository;

  return TokensService.of({
    resolveCliToken: Effect.fn("TokensService.resolveCliToken")(function* (rawToken) {
      if (!rawToken.startsWith(CLI_TOKEN_PREFIX)) {
        return Option.none();
      }
      const tokenHash = yield* hashCliToken(rawToken);

      return yield* repository.findIdentityByHash(tokenHash, new Date()).pipe(Effect.orDie);
    }),
    listDevices: Effect.fn("TokensService.listDevices")(function* (userId) {
      return yield* repository.listDevices(userId).pipe(Effect.orDie);
    }),
    listTokens: Effect.fn("TokensService.listTokens")(function* (userId) {
      return yield* repository.listTokens(userId).pipe(Effect.orDie);
    }),
    revokeToken: Effect.fn("TokensService.revokeToken")(function* (userId, tokenId) {
      const revoked = yield* repository.revokeToken(userId, tokenId, new Date()).pipe(Effect.orDie);
      if (!revoked) {
        return yield* Effect.fail(new TokenNotFound({ id: tokenId }));
      }
    }),
  });
});

const TokensServiceLive = Layer.effect(TokensService, makeTokensService());

export { makeTokensService, TokensRepository, TokensService, TokensServiceLive };

export type { TokensRepositoryShape, TokensServiceShape };
