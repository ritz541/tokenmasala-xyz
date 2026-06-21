import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  CliLoginStartInput,
  IngestUsageInput,
  ProfileDailyResponse,
  SyncUsageInput,
  UsageCheckInInput,
} from "./schemas";

describe("device telemetry inputs", () => {
  it("keeps old clients without version or arch compatible", async () => {
    await expect(
      Schema.decodeUnknownPromise(CliLoginStartInput)({
        deviceId: "device_123",
        deviceName: "Mac.localdomain",
        devicePlatform: "darwin",
      }),
    ).resolves.toEqual({
      deviceId: "device_123",
      deviceName: "Mac.localdomain",
      devicePlatform: "darwin",
    });

    await expect(
      Schema.decodeUnknownPromise(IngestUsageInput)({
        device: { name: "Mac.localdomain", platform: "darwin" },
        reports: [],
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      reports: [],
    });

    await expect(
      Schema.decodeUnknownPromise(SyncUsageInput)({
        days: [],
        device: { name: "Mac.localdomain", platform: "darwin" },
      }),
    ).resolves.toEqual({
      days: [],
      device: { name: "Mac.localdomain", platform: "darwin" },
    });

    await expect(
      Schema.decodeUnknownPromise(UsageCheckInInput)({
        device: { name: "Mac.localdomain", platform: "darwin" },
        service: {
          repairAttemptedAt: "2026-06-21T18:00:00.000Z",
          repairReason: "scheduler-inactive",
          repairStatus: "scheduled",
          status: "success",
        },
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      service: {
        repairAttemptedAt: "2026-06-21T18:00:00.000Z",
        repairReason: "scheduler-inactive",
        repairStatus: "scheduled",
        status: "success",
      },
    });
  });
});

describe("profile daily responses", () => {
  it("carries chart range metadata separately from sparse usage rows", async () => {
    await expect(
      Schema.decodeUnknownPromise(ProfileDailyResponse)({
        days: [
          {
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUsd: 12.34,
            date: "2026-06-19",
            inputTokens: 100,
            key: "claude-opus-4",
            outputTokens: 200,
            totalTokens: 300,
          },
        ],
        range: {
          first: "2026-01-01",
          last: "2026-06-21",
        },
      }),
    ).resolves.toEqual({
      days: [
        {
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 12.34,
          date: "2026-06-19",
          inputTokens: 100,
          key: "claude-opus-4",
          outputTokens: 200,
          totalTokens: 300,
        },
      ],
      range: {
        first: "2026-01-01",
        last: "2026-06-21",
      },
    });
  });
});
