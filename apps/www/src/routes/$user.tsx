import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;
type DailyRange = (typeof ProfileDailyResponse.Type)["range"];

import { Heatmap } from "../components/charts/heatmap";
import { MonthBars } from "../components/charts/month-bars";
import {
  enumerateDays,
  familyColors,
  formatTokens,
  formatUsd,
  modelFamily,
} from "../components/charts/scale";
import { Legend, StackedBars, type StackedDay } from "../components/charts/stacked-bars";
import { WeekdayBars } from "../components/charts/weekday-bars";
import { StatCard } from "../components/stat-card";
import { Avatar } from "../components/ui/avatar";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { profileDailyQueryOptions, profileQueryOptions } from "../lib/queries";

const Route = createFileRoute("/$user")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(profileQueryOptions(params.user)),
      context.queryClient.ensureQueryData(profileDailyQueryOptions(params.user)),
    ]);
  },
  component: ProfilePage,
});

const countFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user));
  const { stats } = profile;
  const owner = profile.user;

  return (
    <>
      <header className="flex items-center gap-4 px-4 py-8">
        <Avatar size={56} src={owner.avatarUrl} />
        <h1 className="text-2xl font-semibold tracking-tight">{owner.login}</h1>
      </header>

      {daily.days.length === 0 ? (
        <div className="px-4">
          <Card className="p-6 text-sm text-muted-foreground">
            No usage yet — run <Code>tokenmaxxing sync</Code> to fill this page.
          </Card>
        </div>
      ) : (
        <ProfileDashboard range={daily.range} rows={daily.days} stats={stats} />
      )}
    </>
  );
}

interface DashboardStats {
  activeDays: number;
  avgSpendPerActiveDay: number;
  currentStreakDays: number;
  firstDate: string | null;
  lastDate: string | null;
  longestStreakDays: number;
  peakDay: { date: string; spendUsd: number } | null;
  sessionCount: number;
  topModel: { model: string; spendUsd: number } | null;
  totalSpendUsd: number;
  totalTokens: number;
}

function ProfileDashboard({
  range,
  rows,
  stats,
}: {
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: DashboardStats;
}) {
  const derived = useMemo(() => deriveCharts(rows, range), [range, rows]);
  const [hoveredSpendFamily, setHoveredSpendFamily] = useState<string | null>(null);
  const [hoveredTokensFamily, setHoveredTokensFamily] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-px border-y border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <StatCard label="Total spend" value={formatUsd(stats.totalSpendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Sessions" value={formatCount(stats.sessionCount)} />
        <div aria-hidden="true" className="order-last bg-background" />
        <StatCard
          label="Top model"
          value={stats.topModel === null ? "—" : modelFamily(stats.topModel.model)}
        />
        <StatCard label="Current streak" value={formatCount(stats.currentStreakDays)} />
        <StatCard label="Longest streak" value={formatCount(stats.longestStreakDays)} />
        <StatCard label="Active days" value={formatCount(stats.activeDays)} />
      </div>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Spend</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Daily spend by model family across ${derived.spendDays.length} days`}
              days={derived.spendDays}
              highlight={hoveredSpendFamily}
              valueFormatter={formatUsd}
            />
          </div>
          <Legend entries={derived.spendLegend} onHover={setHoveredSpendFamily} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Tokens</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Daily tokens by model family across ${derived.tokenDays.length} days`}
              days={derived.tokenDays}
              highlight={hoveredTokensFamily}
              valueFormatter={formatTokens}
            />
          </div>
          <Legend entries={derived.tokenLegend} onHover={setHoveredTokensFamily} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Activity Heatmap</h2>
        <div className="mt-4">
          {derived.heatmap !== null ? (
            <Heatmap
              byDate={derived.spendByDate}
              first={derived.heatmap.first}
              last={derived.heatmap.last}
              segmentsByDate={derived.segmentsByDate}
            />
          ) : null}
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Most Active Time</h2>
        <div className="mt-4">
          <WeekdayBars spend={derived.spendByWeekday} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Monthly Spend</h2>
        <div className="mt-4">
          <MonthBars months={derived.months} />
        </div>
      </section>
    </div>
  );
}

function deriveCharts(rows: readonly DailyRow[], range: DailyRange) {
  const colors = familyColors(rows);

  // Per-day totals and per-day family segments.
  const spendByDate = new Map<string, number>();
  const tokenByDate = new Map<string, number>();
  const spendFamiliesByDate = new Map<string, Map<string, number>>();
  const tokenFamiliesByDate = new Map<string, Map<string, number>>();
  const spendByMonth = new Map<string, number>();
  const familiesByMonth = new Map<string, Map<string, number>>();
  // Spend bucketed by weekday, Monday-first: [0]=Mon … [6]=Sun.
  const spendByWeekday = [0, 0, 0, 0, 0, 0, 0];
  let outputTokens = 0;
  for (const row of rows) {
    outputTokens += row.outputTokens;
    spendByDate.set(row.date, (spendByDate.get(row.date) ?? 0) + row.costUsd);
    tokenByDate.set(row.date, (tokenByDate.get(row.date) ?? 0) + row.totalTokens);
    // getUTCDay() is Sunday-first; shift to Monday-first. UTC avoids tz drift.
    const weekday = (new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    spendByWeekday[weekday] = (spendByWeekday[weekday] ?? 0) + row.costUsd;
    const family = modelFamily(row.key);
    const spendFamilies = spendFamiliesByDate.get(row.date) ?? new Map<string, number>();
    spendFamilies.set(family, (spendFamilies.get(family) ?? 0) + row.costUsd);
    spendFamiliesByDate.set(row.date, spendFamilies);
    const tokenFamilies = tokenFamiliesByDate.get(row.date) ?? new Map<string, number>();
    tokenFamilies.set(family, (tokenFamilies.get(family) ?? 0) + row.totalTokens);
    tokenFamiliesByDate.set(row.date, tokenFamilies);

    const month = row.date.slice(0, 7);
    spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + row.costUsd);
    const monthFamilies = familiesByMonth.get(month) ?? new Map<string, number>();
    monthFamilies.set(family, (monthFamilies.get(family) ?? 0) + row.costUsd);
    familiesByMonth.set(month, monthFamilies);
  }

  const allDays = enumerateDays(range.first, range.last);
  const heatmapRange = {
    first: calendarYearStart(range.last),
    last: calendarYearEnd(range.last),
  };

  const familyOrder = [...colors.keys()];
  const segmentsByDate = new Map(
    [...spendFamiliesByDate.entries()].map(([date, families]) => [
      date,
      familyOrder.map((family) => ({
        color: colors.get(family) ?? "#9ca3af",
        family,
        value: families.get(family) ?? 0,
      })),
    ]),
  );

  const chartedDays = allDays;
  const spendDays = buildStackedDays(
    chartedDays,
    familyOrder,
    colors,
    spendFamiliesByDate,
    spendByDate,
  );
  const tokenDays = buildStackedDays(
    chartedDays,
    familyOrder,
    colors,
    tokenFamiliesByDate,
    tokenByDate,
  );

  const months = enumerateCalendarMonths(range.first, range.last).map((month) => ({
    month,
    segments: familyOrder.map((family) => ({
      color: colors.get(family) ?? "#9ca3af",
      family,
      value: familiesByMonth.get(month)?.get(family) ?? 0,
    })),
    value: spendByMonth.get(month) ?? 0,
  }));

  return {
    heatmap: heatmapRange,
    months,
    outputTokens,
    segmentsByDate,
    spendByDate,
    spendDays,
    spendLegend: buildLegend(spendDays, colors),
    spendByWeekday,
    tokenDays,
    tokenLegend: buildLegend(tokenDays, colors),
  };
}

function buildStackedDays(
  days: readonly string[],
  familyOrder: readonly string[],
  colors: ReadonlyMap<string, string>,
  familiesByDate: ReadonlyMap<string, ReadonlyMap<string, number>>,
  totalsByDate: ReadonlyMap<string, number>,
): StackedDay[] {
  return days.map((date) => {
    const families = familiesByDate.get(date);
    return {
      date,
      segments: familyOrder.map((family) => ({
        color: colors.get(family) ?? "#9ca3af",
        family,
        value: families?.get(family) ?? 0,
      })),
      total: totalsByDate.get(date) ?? 0,
    };
  });
}

function buildLegend(days: readonly StackedDay[], colors: ReadonlyMap<string, string>) {
  const valueByFamily = new Map<string, number>();
  let total = 0;
  for (const day of days) {
    for (const segment of day.segments) {
      valueByFamily.set(segment.family, (valueByFamily.get(segment.family) ?? 0) + segment.value);
      total += segment.value;
    }
  }

  return [...colors.keys()]
    .map((family) => ({
      color: colors.get(family) ?? "#9ca3af",
      family,
      percent: total > 0 ? ((valueByFamily.get(family) ?? 0) / total) * 100 : 0,
      value: valueByFamily.get(family) ?? 0,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .map(({ color, family, percent }) => ({ color, family, percent }));
}

function enumerateCalendarMonths(first: string, last: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${last.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return out;
}

function calendarYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

function calendarYearEnd(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

export { deriveCharts, Route };
