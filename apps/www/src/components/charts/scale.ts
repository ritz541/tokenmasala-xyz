import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;

/**
 * Shared chart math: linear scales, model-family bucketing, and number
 * formatting. Charts are pure SVG; everything here is deterministic and
 * unit-testable.
 */

/** Shared bar-chart geometry so the charts can't drift apart. */
const CHART_WIDTH = 940;
/** Left gutter (px) reserved for the value-axis labels. */
const CHART_AXIS = 44;
/** Gridline count; `CHART_TICKS + 1` lines render, including the baseline. */
const CHART_TICKS = 4;

function linearScale(domainMax: number, rangeMax: number) {
  const safeMax = domainMax <= 0 ? 1 : domainMax;

  return (value: number) => (value / safeMax) * rangeMax;
}

/**
 * Slot width and bar width shared by the vertical bar charts. `fill` is the
 * fraction of the slot the bar occupies, capped at `cap` and floored at `floor`.
 */
function barLayout(count: number, fill: number, cap: number, floor = 0) {
  const slot = (CHART_WIDTH - CHART_AXIS) / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * fill, cap), floor);

  return { barWidth, slot };
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

const MODEL_FAMILY_ORDER = [
  "GPT-5.5",
  "GPT-5.4",
  "GPT-5",
  "GPT",
  "GPT Codex",
  "OpenAI o-series",
  "Claude Fable",
  "Claude Mythos",
  "Claude Opus",
  "Claude Sonnet",
  "Claude Haiku",
  "Gemini",
] as const;

function modelFamily(model: string): string {
  for (const [pattern, family] of MODEL_FAMILY_RULES) {
    if (pattern.test(model)) {
      return family;
    }
  }

  return "Other";
}

/** Fixed palette tuned to read on both themes. */
const MODEL_FAMILY_COLORS = {
  "Claude Fable": "#38bdf8",
  "Claude Haiku": "#ec4899",
  "Claude Mythos": "#a855f7",
  "Claude Opus": "#eab308",
  "Claude Sonnet": "#14b8a6",
  Gemini: "#ef4444",
  GPT: "#6366f1",
  "GPT Codex": "#0ea5e9",
  "GPT-5": "#8b5cf6",
  "GPT-5.4": "#22c55e",
  "GPT-5.5": "#f97316",
  "OpenAI o-series": "#84cc16",
  Other: "#9ca3af",
} as const satisfies Record<string, string>;

/** Stable family -> color assignment in canonical model-family order. */
function familyColors(rows: readonly DailyRow[]): Map<string, string> {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(modelFamily(row.key));
  }

  const colors = new Map<string, string>();
  for (const family of MODEL_FAMILY_ORDER) {
    if (seen.has(family)) {
      colors.set(family, MODEL_FAMILY_COLORS[family]);
    }
  }
  if (seen.has("Other")) {
    colors.set("Other", MODEL_FAMILY_COLORS.Other);
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
  barLayout,
  CHART_AXIS,
  CHART_TICKS,
  CHART_WIDTH,
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
