import { DeviceMissing } from "@tokenmaxxing/api-contract";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeUsageService,
  UsageRepository,
  type SyncResult,
  type UsageRepositoryShape,
} from "./service";

const user = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

const device = {
  name: "Mac.localdomain",
  platform: "darwin",
};

const usageDay = {
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 12.34,
  date: "2026-06-15",
  inputTokens: 100,
  model: "GPT-5.5",
  outputTokens: 200,
  source: "codex",
  totalTokens: 300,
};

const sourceStats = [{ sessionCount: 706, source: "codex" }];

interface TestUsageService {
  syncBatch(
    identity: {
      deviceId: string | null;
      tokenId: string;
      user: typeof user;
    },
    syncDevice: typeof device,
    days: readonly (typeof usageDay)[],
    syncSourceStats?: readonly (typeof sourceStats)[number][],
  ): Effect.Effect<SyncResult, DeviceMissing>;
}

function makeRepository() {
  const upsertChunk = vi.fn(() => Effect.succeed(undefined));
  const touchDevice = vi.fn(() => Effect.succeed(undefined));
  const upsertSourceStats = vi.fn(() => Effect.succeed(undefined));

  const repository: UsageRepositoryShape = {
    touchDevice,
    upsertChunk,
    upsertSourceStats,
  };

  return { repository, touchDevice, upsertChunk, upsertSourceStats };
}

async function makeService(repository: UsageRepositoryShape) {
  return (await Effect.runPromise(
    makeUsageService().pipe(Effect.provideService(UsageRepository, repository)),
  )) as unknown as TestUsageService;
}

describe("UsageService.syncBatch", () => {
  it("upserts daily rows, source stats, and touches the device", async () => {
    const { repository, touchDevice, upsertChunk, upsertSourceStats } = makeRepository();
    const service = await makeService(repository);

    const result = await Effect.runPromise(
      service.syncBatch(
        { deviceId: "device_123", tokenId: "token_123", user },
        device,
        [usageDay],
        sourceStats,
      ),
    );

    expect(result.received).toBe(1);
    expect(result.upserted).toBe(1);
    expect(upsertChunk).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      [usageDay],
      expect.any(Date),
    );
    expect(upsertSourceStats).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      sourceStats,
      expect.any(Date),
    );
    expect(touchDevice).toHaveBeenCalledWith("device_123", device, expect.any(Date));
    expect(upsertChunk.mock.invocationCallOrder[0]).toBeLessThan(
      upsertSourceStats.mock.invocationCallOrder[0]!,
    );
    expect(upsertSourceStats.mock.invocationCallOrder[0]).toBeLessThan(
      touchDevice.mock.invocationCallOrder[0]!,
    );
  });

  it("does not touch storage when the token has no device", async () => {
    const { repository, touchDevice, upsertChunk, upsertSourceStats } = makeRepository();
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(
        service.syncBatch({ deviceId: null, tokenId: "token_123", user }, device, []),
      ),
    ).rejects.toBeInstanceOf(DeviceMissing);

    expect(upsertChunk).not.toHaveBeenCalled();
    expect(upsertSourceStats).not.toHaveBeenCalled();
    expect(touchDevice).not.toHaveBeenCalled();
  });
});
