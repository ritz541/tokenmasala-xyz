import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vitest";

import { deriveCharts } from "./$user";

type DailyRow = typeof ProfileDailyRow.Type;

function row(input: { costUsd: number; date: string; key: string; totalTokens: number }): DailyRow {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: input.costUsd,
    date: input.date,
    inputTokens: input.totalTokens,
    key: input.key,
    outputTokens: 0,
    totalTokens: input.totalTokens,
  };
}

describe("deriveCharts", () => {
  it("builds separate spend and token charts from daily profile rows", () => {
    const derived = deriveCharts([
      row({ costUsd: 90, date: "2026-06-01", key: "gpt-5.5", totalTokens: 100 }),
      row({ costUsd: 10, date: "2026-06-01", key: "claude-fable-5", totalTokens: 900 }),
    ]);

    expect(derived.spendDays[0]?.total).toBe(100);
    expect(derived.tokenDays[0]?.total).toBe(1_000);

    expect(derived.spendLegend.map((entry) => entry.family)).toEqual(["GPT-5.5", "Claude Fable"]);
    expect(derived.tokenLegend.map((entry) => entry.family)).toEqual(["Claude Fable", "GPT-5.5"]);
    expect(derived.tokenLegend[0]?.percent).toBe(90);
  });
});

export {};
