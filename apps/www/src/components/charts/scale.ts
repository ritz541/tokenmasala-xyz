import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;

/**
 * Shared chart math: linear scales, model-family bucketing, and number
 * formatting. Charts are pure SVG; everything here is deterministic and
 * unit-testable.
 */

function linearScale(domainMax: number, rangeMax: number) {
  const safeMax = domainMax <= 0 ? 1 : domainMax;

  return (value: number) => (value / safeMax) * rangeMax;
}

/** "Nice" axis max so gridlines land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return niceFraction * 10 ** exponent;
}

const MODEL_FAMILY_RULES: readonly [RegExp, string][] = [
  [/^claude-fable/i, "Claude Fable"],
  [/^claude-mythos/i, "Claude Mythos"],
  [/^claude-opus/i, "Claude Opus"],
  [/^claude-sonnet/i, "Claude Sonnet"],
  [/^claude-haiku/i, "Claude Haiku"],
  [/^gpt-5\.5/i, "GPT-5.5"],
  [/^gpt-5\.4/i, "GPT-5.4"],
  [/^gpt-5/i, "GPT-5"],
  [/^gpt/i, "GPT"],
  [/codex/i, "GPT Codex"],
  [/gemini/i, "Gemini"],
  [/^o[0-9]/i, "OpenAI o-series"],
];

function modelFamily(model: string): string {
  for (const [pattern, family] of MODEL_FAMILY_RULES) {
    if (pattern.test(model)) {
      return family;
    }
  }

  return "Other";
}

/** Palette tuned to read on both themes; "Other" is always the gray. */
const FAMILY_PALETTE = [
  "#f97316",
  "#22c55e",
  "#38bdf8",
  "#8b5cf6",
  "#eab308",
  "#ec4899",
  "#14b8a6",
] as const;

const OTHER_COLOR = "#9ca3af";

/** Stable family -> color assignment ordered by total spend (top first). */
function familyColors(rows: readonly DailyRow[]): Map<string, string> {
  const spendByFamily = new Map<string, number>();
  for (const row of rows) {
    const family = modelFamily(row.key);
    spendByFamily.set(family, (spendByFamily.get(family) ?? 0) + row.costUsd);
  }

  const ranked = [...spendByFamily.entries()]
    .filter(([family]) => family !== "Other")
    .sort((a, b) => b[1] - a[1])
    .map(([family]) => family);

  const colors = new Map<string, string>();
  ranked.forEach((family, index) => {
    colors.set(family, FAMILY_PALETTE[index % FAMILY_PALETTE.length]!);
  });
  if (spendByFamily.has("Other")) {
    colors.set("Other", OTHER_COLOR);
  }

  return colors;
}

const usd0 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd2 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

function formatUsd(value: number): string {
  return value >= 100 ? usd0.format(value) : usd2.format(value);
}

function formatTokens(value: number): string {
  if (value >= 1e12) {
    return `${(value / 1e12).toFixed(2)}T`;
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }

  return value.toFixed(0);
}

const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLongLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const dayLabel = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
});

/** Opaque YYYY-MM-DD keys render via UTC so no local-tz shifting occurs. */
function formatDay(date: string): string {
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

function formatMonth(month: string): string {
  return monthLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Full month + year, e.g. "June 2026" — used in tooltips. */
function formatMonthLong(month: string): string {
  return monthLongLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Every YYYY-MM-DD between two inclusive bounds (pure string walking). */
function enumerateDays(first: string, last: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}

export {
  enumerateDays,
  familyColors,
  formatDay,
  formatMonth,
  formatMonthLong,
  formatTokens,
  formatUsd,
  linearScale,
  modelFamily,
  niceMax,
};
