import { describe, expect, it } from "vitest";

import { estimateCostUsd, priceForModel } from "./pricing";

describe("priceForModel", () => {
  it("matches by longest prefix", () => {
    expect(priceForModel("claude-3-5-sonnet-20241022").inputUsd).toBe(3);
    expect(priceForModel("gpt-4o-mini").inputUsd).toBe(0.15);
    expect(priceForModel("claude-opus-4-20250514").inputUsd).toBe(15);
  });

  it("is case-insensitive", () => {
    expect(priceForModel("Claude-3-5-Sonnet-20241022").inputUsd).toBe(3);
  });

  it("falls back to the default entry for unknown models", () => {
    expect(priceForModel("some-unknown-model").inputUsd).toBe(1);
  });
});

describe("estimateCostUsd", () => {
  it("is zero when there is no usage", () => {
    expect(
      estimateCostUsd("gpt-4o", {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    ).toBe(0);
  });

  it("computes input + output only for an OpenAI model", () => {
    // gpt-4o: $2.5/M input, $10/M output
    const cost = estimateCostUsd("gpt-4o", {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    });
    // 2.5 + 10 = 12.5
    expect(cost).toBeCloseTo(12.5, 5);
  });

  it("includes cache token costs for a Claude model", () => {
    // claude-3-5-sonnet: input 3, output 15, cacheRead 0.3, cacheCreation 3.75
    const cost = estimateCostUsd("claude-3-5-sonnet-20241022", {
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 4_000_000,
    });
    // 3 + 15 + 0.3 + 3.75 = 22.05
    expect(cost).toBeCloseTo(22.05, 5);
  });

  it("rounds to 6 decimal places", () => {
    const cost = estimateCostUsd("gpt-4o-mini", {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
    });
    // 1/1e6 * 0.15 = 0.00000015 -> rounds to 0.000000
    expect(cost).toBe(0);
  });
});
