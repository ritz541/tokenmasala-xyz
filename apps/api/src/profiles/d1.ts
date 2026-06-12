import { devices, usageDays, users } from "@tokenmaxxing/db";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Drizzle } from "../database";
import { ProfilesRepository } from "./service";

const makeD1ProfilesRepository = Effect.fn("makeD1ProfilesRepository")(function* () {
  const database = yield* Drizzle;

  return ProfilesRepository.of({
    findUserByLogin: (login) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db.select().from(users).where(eq(users.login, login)).limit(1),
        );
        const row = rows[0];

        return row === undefined
          ? Option.none()
          : Option.some({ avatarUrl: row.avatarUrl, id: row.id, login: row.login, name: row.name });
      }),
    stats: (userId) =>
      Effect.gen(function* () {
        const [totals] = yield* database.use((db) =>
          db
            .select({
              activeDays: sql<number>`count(distinct ${usageDays.date})`,
              deviceCount: sql<number>`count(distinct ${usageDays.deviceId})`,
              firstDate: sql<string | null>`min(${usageDays.date})`,
              lastDate: sql<string | null>`max(${usageDays.date})`,
              totalSpendUsd: sql<number | null>`sum(${usageDays.costUsd})`,
              totalTokens: sql<number | null>`sum(${usageDays.totalTokens})`,
            })
            .from(usageDays)
            .where(eq(usageDays.userId, userId)),
        );

        const peakDays = yield* database.use((db) =>
          db
            .select({
              date: usageDays.date,
              spendUsd: sql<number>`sum(${usageDays.costUsd})`.as("day_spend"),
            })
            .from(usageDays)
            .where(eq(usageDays.userId, userId))
            .groupBy(usageDays.date)
            .orderBy(desc(sql`day_spend`))
            .limit(1),
        );

        const topModels = yield* database.use((db) =>
          db
            .select({
              model: usageDays.model,
              spendUsd: sql<number>`sum(${usageDays.costUsd})`.as("model_spend"),
            })
            .from(usageDays)
            .where(eq(usageDays.userId, userId))
            .groupBy(usageDays.model)
            .orderBy(desc(sql`model_spend`))
            .limit(1),
        );

        const sourceRows = yield* database.use((db) =>
          db
            .selectDistinct({ source: usageDays.source })
            .from(usageDays)
            .where(eq(usageDays.userId, userId))
            .orderBy(asc(usageDays.source)),
        );

        const activeDays = totals?.activeDays ?? 0;
        const totalSpendUsd = totals?.totalSpendUsd ?? 0;

        return {
          activeDays,
          avgSpendPerActiveDay: activeDays === 0 ? 0 : totalSpendUsd / activeDays,
          deviceCount: totals?.deviceCount ?? 0,
          firstDate: totals?.firstDate ?? null,
          lastDate: totals?.lastDate ?? null,
          peakDay: peakDays[0] ?? null,
          sources: sourceRows.map((row) => row.source),
          topModel: topModels[0] ?? null,
          totalSpendUsd,
          totalTokens: totals?.totalTokens ?? 0,
        };
      }),
    daily: (userId, query) =>
      Effect.gen(function* () {
        const key =
          query.groupBy === "model"
            ? usageDays.model
            : query.groupBy === "source"
              ? usageDays.source
              : sql<string>`coalesce(${devices.name}, ${usageDays.deviceId})`;

        const conditions: SQL[] = [eq(usageDays.userId, userId)];
        if (query.since !== undefined) {
          conditions.push(gte(usageDays.date, query.since));
        }
        if (query.until !== undefined) {
          conditions.push(lte(usageDays.date, query.until));
        }

        const rows = yield* database.use((db) => {
          const base = db
            .select({
              cacheCreationTokens: sql<number>`sum(${usageDays.cacheCreationTokens})`,
              cacheReadTokens: sql<number>`sum(${usageDays.cacheReadTokens})`,
              costUsd: sql<number>`sum(${usageDays.costUsd})`,
              date: usageDays.date,
              inputTokens: sql<number>`sum(${usageDays.inputTokens})`,
              key: sql<string>`${key}`.as("group_key"),
              outputTokens: sql<number>`sum(${usageDays.outputTokens})`,
              totalTokens: sql<number>`sum(${usageDays.totalTokens})`,
            })
            .from(usageDays);

          return (
            query.groupBy === "device"
              ? base.leftJoin(devices, eq(usageDays.deviceId, devices.id))
              : base
          )
            .where(and(...conditions))
            .groupBy(usageDays.date, sql`group_key`)
            .orderBy(asc(usageDays.date), asc(sql`group_key`));
        });

        return rows;
      }),
  });
});

const ProfilesRepositoryLive = Layer.effect(ProfilesRepository, makeD1ProfilesRepository());

export { makeD1ProfilesRepository, ProfilesRepositoryLive };
