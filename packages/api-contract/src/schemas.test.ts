import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { CliLoginStartInput, IngestUsageInput, SyncUsageInput, UsageCheckInInput } from "./schemas";

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
        service: { status: "success" },
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      service: { status: "success" },
    });
  });
});
