import { Context } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import { UserNotFound } from "@tokenmaxxing/api-contract";
import type {
  AuthUser,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileDailyRow,
  ProfileResponse,
  ProfileStats,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model, source, or device.
 */

const PROFILE_CHART_START = "2026-01-01";

interface DailyQuery {
  groupBy: typeof ProfileDailyGroupBy.Type;
  since?: string | undefined;
  until?: string | undefined;
}

interface ProfilesServiceShape {
  getProfile(
    login: string,
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileResponse.Type, UserNotFound, any>;
  getDaily(
    login: string,
    query: DailyQuery,
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileDailyResponse.Type, UserNotFound, any>;
}

interface ProfileUser {
  shadowBanned: boolean;
  user: typeof AuthUser.Type;
}

interface ProfilesRepositoryShape {
  findUserByLogin(login: string): Effect.Effect<Option.Option<ProfileUser>, DatabaseError, any>;
  stats(userId: string): Effect.Effect<typeof ProfileStats.Type, DatabaseError, any>;
  daily(
    userId: string,
    query: DailyQuery,
  ): Effect.Effect<(typeof ProfileDailyRow.Type)[], DatabaseError, any>;
}

class ProfilesService extends Context.Service<ProfilesService, ProfilesServiceShape>()(
  "@tokenmaxxing/api/ProfilesService",
) {}

class ProfilesRepository extends Context.Service<ProfilesRepository, ProfilesRepositoryShape>()(
  "@tokenmaxxing/api/ProfilesRepository",
) {}

const makeProfilesService = Effect.fn("makeProfilesService")(function* () {
  const repository = yield* ProfilesRepository;

  const requireUser = Effect.fn("ProfilesService.requireUser")(function* (
    login: string,
    viewerUserId: string | null,
  ) {
    const result = yield* repository.findUserByLogin(login).pipe(Effect.orDie);
    if (
      Option.isNone(result) ||
      (result.value.shadowBanned && result.value.user.id !== viewerUserId)
    ) {
      return yield* Effect.fail(new UserNotFound({ login }));
    }

    return result.value.user;
  });

  return ProfilesService.of({
    getProfile: Effect.fn("ProfilesService.getProfile")(function* (login, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const stats = yield* repository.stats(user.id).pipe(Effect.orDie);

      return { stats, user };
    }),
    getDaily: Effect.fn("ProfilesService.getDaily")(function* (login, query, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const days = yield* repository.daily(user.id, query).pipe(Effect.orDie);

      return {
        days,
        range: profileDailyRange(query, new Date()),
      };
    }),
  });
});

function profileDailyRange(query: Pick<DailyQuery, "since" | "until">, now: Date) {
  return {
    first: query.since ?? PROFILE_CHART_START,
    last: query.until ?? todayKeyUtc(now),
  };
}

function todayKeyUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export {
  makeProfilesService,
  PROFILE_CHART_START,
  profileDailyRange,
  ProfilesRepository,
  ProfilesService,
  todayKeyUtc,
};

export type { ProfilesRepositoryShape };
