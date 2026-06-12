import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { UserNotFound } from "@tokenmaxxing/api-contract";
import type {
  AuthUser,
  ProfileDailyGroupBy,
  ProfileDailyRow,
  ProfileResponse,
  ProfileStats,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model, source, or device.
 */

interface DailyQuery {
  groupBy: typeof ProfileDailyGroupBy.Type;
  since?: string | undefined;
  until?: string | undefined;
}

interface ProfilesServiceShape {
  getProfile(login: string): Effect.Effect<typeof ProfileResponse.Type, UserNotFound, any>;
  getDaily(
    login: string,
    query: DailyQuery,
  ): Effect.Effect<(typeof ProfileDailyRow.Type)[], UserNotFound, any>;
}

interface ProfilesRepositoryShape {
  findUserByLogin(
    login: string,
  ): Effect.Effect<Option.Option<typeof AuthUser.Type>, DatabaseError, any>;
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

  const requireUser = Effect.fn("ProfilesService.requireUser")(function* (login: string) {
    const user = yield* repository.findUserByLogin(login).pipe(Effect.orDie);
    if (Option.isNone(user)) {
      return yield* Effect.fail(new UserNotFound({ login }));
    }

    return user.value;
  });

  return ProfilesService.of({
    getProfile: Effect.fn("ProfilesService.getProfile")(function* (login) {
      const user = yield* requireUser(login);
      const stats = yield* repository.stats(user.id).pipe(Effect.orDie);

      return { stats, user };
    }),
    getDaily: Effect.fn("ProfilesService.getDaily")(function* (login, query) {
      const user = yield* requireUser(login);

      return yield* repository.daily(user.id, query).pipe(Effect.orDie);
    }),
  });
});

const ProfilesServiceLive = Layer.effect(ProfilesService, makeProfilesService());

export { makeProfilesService, ProfilesRepository, ProfilesService, ProfilesServiceLive };

export type { DailyQuery, ProfilesRepositoryShape, ProfilesServiceShape };
