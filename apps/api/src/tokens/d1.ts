import { cliTokens, devices, users } from "@tokenmaxxing/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Drizzle } from "../database";
import { TokensRepository } from "./service";

const makeD1TokensRepository = Effect.fn("makeD1TokensRepository")(function* () {
  const database = yield* Drizzle;

  return TokensRepository.of({
    findIdentityByHash: (tokenHash, now) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ token: cliTokens, user: users })
            .from(cliTokens)
            .innerJoin(users, eq(cliTokens.userId, users.id))
            .where(and(eq(cliTokens.tokenHash, tokenHash), isNull(cliTokens.revokedAt)))
            .limit(1),
        );
        const row = rows[0];
        if (row === undefined) {
          return Option.none();
        }

        // Freshness bookkeeping only; failures here must not fail auth.
        yield* database
          .use((db) =>
            db.update(cliTokens).set({ lastUsedAt: now }).where(eq(cliTokens.id, row.token.id)),
          )
          .pipe(Effect.ignore);

        return Option.some({
          deviceId: row.token.deviceId,
          tokenId: row.token.id,
          user: {
            avatarUrl: row.user.avatarUrl,
            id: row.user.id,
            login: row.user.login,
            name: row.user.name,
          },
        });
      }),
    listDevices: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select()
            .from(devices)
            .where(eq(devices.userId, userId))
            .orderBy(desc(devices.createdAt)),
        );

        return rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
          name: row.name,
          platform: row.platform,
        }));
      }),
    listTokens: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select()
            .from(cliTokens)
            .where(eq(cliTokens.userId, userId))
            .orderBy(desc(cliTokens.createdAt)),
        );

        return rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          deviceId: row.deviceId,
          id: row.id,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          name: row.name,
          revokedAt: row.revokedAt?.toISOString() ?? null,
        }));
      }),
    revokeToken: (userId, tokenId, now) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .update(cliTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(cliTokens.id, tokenId),
                eq(cliTokens.userId, userId),
                isNull(cliTokens.revokedAt),
              ),
            )
            .returning({ id: cliTokens.id }),
        );

        return rows.length > 0;
      }),
  });
});

const TokensRepositoryLive = Layer.effect(TokensRepository, makeD1TokensRepository());

export { makeD1TokensRepository, TokensRepositoryLive };
