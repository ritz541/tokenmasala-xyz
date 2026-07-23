import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import {
  AdminUserNotFound,
  DeviceNotFound,
  DeviceMissing,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenNotFound,
  UserNotFound,
} from "./errors";
import { Authorization, CliAuth } from "./middleware";
import {
  AdminUsersResponse,
  CliLoginApproveInput,
  CliLoginApproveResponse,
  CliLoginPollInput,
  CliLoginPollResponse,
  CliLoginStartInput,
  CliLoginStartResponse,
  CliTokenSummary,
  DeviceSummary,
  HealthResponse,
  IngestEventsInput,
  IngestEventsResponse,
  IngestGithubInput,
  IngestGithubResponse,
  IngestSessionsInput,
  IngestSessionsResponse,
  IngestUsageInput,
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
  MeResponse,
  OkResponse,
  PresenceResponse,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileResponse,
  ShadowBanUserResponse,
  StatsResponse,
  UsageCheckInInput,
  UsageCheckInResponse,
  SyncUsageInput,
  SyncUsageResponse,
  UserAccountSummary,
} from "./schemas";

/**
 * The whole HTTP contract, one group per domain. Authorization guards the
 * session-cookie surface (www), CliAuth guards the bearer-token surface
 * (CLI), and leaderboard/profiles stay public. The OAuth browser flow
 * (redirects + Set-Cookie) lives in raw router routes, not here.
 */

class HealthGroup extends HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("status", "/health", {
    success: HealthResponse,
  }),
) {}

class MeGroup extends HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: MeResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAccounts", "/me/accounts", {
      success: Schema.Struct({ accounts: Schema.Array(UserAccountSummary) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("approveCliLogin", "/cli/login/approve", {
      payload: CliLoginApproveInput,
      success: CliLoginApproveResponse,
      error: [LoginCodeNotFound, LoginCodeExpired],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDevices", "/me/devices", {
      success: Schema.Struct({ devices: Schema.Array(DeviceSummary) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteDevice", "/me/devices/:deviceId/delete", {
      params: {
        deviceId: Schema.String,
      },
      success: OkResponse,
      error: DeviceNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listTokens", "/me/tokens", {
      success: Schema.Struct({ tokens: Schema.Array(CliTokenSummary) }),
    }),
    HttpApiEndpoint.post("revokeToken", "/me/tokens/:tokenId/revoke", {
      params: {
        tokenId: Schema.String,
      },
      success: OkResponse,
      error: TokenNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("presence", "/presence", {
      success: PresenceResponse,
    }),
  )
  .middleware(Authorization) {}

class CliLoginGroup extends HttpApiGroup.make("cliLogin")
  .add(
    HttpApiEndpoint.post("start", "/cli/login/start", {
      payload: CliLoginStartInput,
      success: CliLoginStartResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("poll", "/cli/login/poll", {
      payload: CliLoginPollInput,
      success: CliLoginPollResponse,
      error: [LoginCodeNotFound, LoginCodeExpired],
    }),
  ) {}

class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.post("checkIn", "/usage/check-in", {
      payload: UsageCheckInInput,
      success: UsageCheckInResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("ingest", "/usage/ingest", {
      payload: IngestUsageInput,
      success: SyncUsageResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    // Legacy structured sync for old CLI clients. New clients send normalized
    // daily ccusage reports and aggregate source stats to /usage/ingest.
    HttpApiEndpoint.post("sync", "/usage/sync", {
      payload: SyncUsageInput,
      success: SyncUsageResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    // Append-only event ingestion. The server watermarks by event `ts` per
    // (device, source) so re-sent older events are dropped and recorded totals
    // never decrease (a cleared local cache cannot subtract history).
    HttpApiEndpoint.post("events", "/usage/events", {
      payload: IngestEventsInput,
      success: IngestEventsResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    // Lossless, cache-clear-safe ingestion. The CLI sends ccusage's
    // per-session report; the server dedups by (device, source, sessionId)
    // and additively folds only NEW sessions into usageDays. A cleared local
    // cache cannot drop history and post-clear work is added, not clamped.
    HttpApiEndpoint.post("sessions", "/usage/sessions", {
      payload: IngestSessionsInput,
      success: IngestSessionsResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("githubSync", "/github/sync", {
      payload: IngestGithubInput,
      success: IngestGithubResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("logout", "/cli/logout", {
      success: OkResponse,
    }),
  )
  .middleware(CliAuth) {}

class LeaderboardGroup extends HttpApiGroup.make("leaderboard").add(
  HttpApiEndpoint.get("list", "/leaderboard", {
    query: {
      metric: Schema.optional(LeaderboardMetric),
      window: Schema.optional(LeaderboardWindow),
    },
    success: LeaderboardResponse,
  }),
) {}

class StatsGroup extends HttpApiGroup.make("stats").add(
  HttpApiEndpoint.get("get", "/stats", {
    success: StatsResponse,
  }),
) {}

class ProfilesGroup extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("get", "/profiles/:login", {
      params: {
        login: Schema.String,
      },
      success: ProfileResponse,
      error: UserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("daily", "/profiles/:login/daily", {
      params: {
        login: Schema.String,
      },
      query: {
        groupBy: Schema.optional(ProfileDailyGroupBy),
        since: Schema.optional(Schema.String),
        until: Schema.optional(Schema.String),
      },
      success: ProfileDailyResponse,
      error: UserNotFound,
    }),
  ) {}

class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listUsers", "/admin/users", {
      success: AdminUsersResponse,
      error: Forbidden,
    }),
  )
  .add(
    HttpApiEndpoint.post("shadowBanUser", "/admin/users/:userId/shadow-ban", {
      params: {
        userId: Schema.String,
      },
      success: ShadowBanUserResponse,
      error: [Forbidden, AdminUserNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("shadowUnbanUser", "/admin/users/:userId/shadow-unban", {
      params: {
        userId: Schema.String,
      },
      success: ShadowBanUserResponse,
      error: [Forbidden, AdminUserNotFound],
    }),
  )
  .middleware(Authorization) {}

class TokenmaxxingApi extends HttpApi.make("tokenmaxxing")
  .add(HealthGroup)
  .add(MeGroup)
  .add(CliLoginGroup)
  .add(UsageGroup)
  .add(LeaderboardGroup)
  .add(StatsGroup)
  .add(ProfilesGroup)
  .add(AdminGroup) {}

export {
  AdminGroup,
  CliLoginGroup,
  HealthGroup,
  LeaderboardGroup,
  MeGroup,
  ProfilesGroup,
  StatsGroup,
  TokenmaxxingApi,
  UsageGroup,
};
