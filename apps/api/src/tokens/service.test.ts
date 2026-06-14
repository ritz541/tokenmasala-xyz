import { DeviceNotFound } from "@tokenmaxxing/api-contract";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeTokensService, TokensRepository, type TokensRepositoryShape } from "./service";

interface TestTokensService {
  deleteDevice(userId: string, deviceId: string): Effect.Effect<void, DeviceNotFound>;
}

function repositoryWithDeleteResult(result: boolean) {
  const deleteDevice = vi.fn(() => Effect.succeed(result));

  const repository: TokensRepositoryShape = {
    deleteDevice,
    findIdentityByHash: () => Effect.succeed(Option.none()),
    listDevices: () => Effect.succeed([]),
    listTokens: () => Effect.succeed([]),
    revokeToken: () => Effect.succeed(false),
  };

  return { deleteDevice, repository };
}

async function makeService(repository: TokensRepositoryShape) {
  return (await Effect.runPromise(
    makeTokensService().pipe(Effect.provideService(TokensRepository, repository)),
  )) as unknown as TestTokensService;
}

describe("TokensService.deleteDevice", () => {
  it("deletes an owned device through the repository", async () => {
    const { deleteDevice, repository } = repositoryWithDeleteResult(true);
    const service = await makeService(repository);

    await Effect.runPromise(service.deleteDevice("user_123", "device_123"));

    expect(deleteDevice).toHaveBeenCalledWith("user_123", "device_123", expect.any(Date));
  });

  it("fails with DeviceNotFound when no owned device was deleted", async () => {
    const { repository } = repositoryWithDeleteResult(false);
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(service.deleteDevice("user_123", "device_missing")),
    ).rejects.toBeInstanceOf(DeviceNotFound);
  });
});
