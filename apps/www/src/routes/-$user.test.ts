import { describe, expect, it } from "vitest";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";

import { deriveCharts } from "./$user";

type DailyRange = (typeof ProfileDailyResponse.Type)["range"];
type DailyRow = typeof ProfileDailyRow.Type;

describe("deriveCharts", () => {
  it("fills sparse usage rows across the server-provided chart range", () => {
    const range: DailyRange = {
      first: "2026-06-19",
      last: "2026-06-21",
    };
    const rows: DailyRow[] = [
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 12,
        date: "2026-06-19",
        inputTokens: 100,
        key: "claude-opus-4",
        outputTokens: 200,
        totalTokens: 300,
      },
    ];

    const derived = deriveCharts(rows, range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      last: "2026-12-31",
    });
    expect(derived.spendDays.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 12],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.tokenDays.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 300],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.months.map((month) => [month.month, month.value])).toEqual([["2026-06", 12]]);
  });

  it("renders the heatmap across the full calendar year", () => {
    const range: DailyRange = {
      first: "2026-01-01",
      last: "2026-06-21",
    };

    const derived = deriveCharts([], range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      last: "2026-12-31",
    });
    expect(derived.spendDays.at(0)?.date).toBe("2026-01-01");
    expect(derived.spendDays.at(-1)?.date).toBe("2026-06-21");
  });

  it("renders every month from range start through range end", () => {
    const range: DailyRange = {
      first: "2026-01-01",
      last: "2026-06-21",
    };

    const derived = deriveCharts([], range);

    expect(derived.months.map((month) => month.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
  });
});
