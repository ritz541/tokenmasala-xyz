import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;

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
import { StatCard } from "../components/stat-card";
import { Avatar } from "../components/ui/avatar";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { profileDailyQueryOptions, profileQueryOptions } from "../lib/queries";

const Route = createFileRoute("/$user")({
  component: ProfilePage,
});

/** The daily-bars chart stays readable up to roughly this many days. */
const DAILY_WINDOW = 184;

const countFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function ProfilePage() {
  const { user } = Route.useParams();
  const profile = useQuery(profileQueryOptions(user));
  const daily = useQuery(profileDailyQueryOptions(user));

  if (profile.isPending || daily.isPending) {
    return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  }

  if (profile.isError || daily.isError) {
    return (
      <div className="mt-24 text-center">
        <h1 className="text-xl font-semibold">No profile for “{user}”</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Either it does not exist or nothing has been synced yet.
        </p>
      </div>
    );
  }

  const { stats } = profile.data;
  const owner = profile.data.user;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-4">
        <Avatar size={56} src={owner.avatarUrl} />
        <h1 className="text-2xl font-semibold tracking-tight">{owner.login}</h1>
      </header>

      {daily.data.days.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No usage yet — run <Code>tokenmaxxing sync</Code> to fill this page.
        </Card>
      ) : (
        <ProfileDashboard rows={daily.data.days} stats={stats} />
      )}
    </div>
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

function ProfileDashboard({ rows, stats }: { rows: readonly DailyRow[]; stats: DashboardStats }) {
  const derived = useMemo(() => deriveCharts(rows), [rows]);

  return (
    <div className="-mx-4 grid grid-cols-1 gap-px border-y border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
        <StatCard label="Total spend" value={formatUsd(stats.totalSpendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Sessions" value={formatCount(stats.sessionCount)} />
        <div aria-hidden="true" className="hidden bg-card md:block" />
        <StatCard
          label="Top model"
          value={stats.topModel === null ? "—" : modelFamily(stats.topModel.model)}
        />
        <StatCard label="Current streak" value={formatCount(stats.currentStreakDays)} />
        <StatCard label="Longest streak" value={formatCount(stats.longestStreakDays)} />
        <StatCard label="Active days" value={formatCount(stats.activeDays)} />
      </div>

      <section className="bg-card p-5">
        <h2 className="font-medium">Daily Spend</h2>
        <div className="mt-3">
          <Legend entries={derived.legend} />
        </div>
        <div className="mt-4">
          <StackedBars days={derived.stackedDays} />
        </div>
      </section>

      <section className="bg-card p-5">
        <h2 className="font-medium">Activity Heatmap</h2>
        <div className="mt-4">
          {derived.heatmap !== null ? (
            <Heatmap
              accent={derived.accent}
              byDate={derived.spendByDate}
              first={derived.heatmap.first}
              last={derived.heatmap.last}
              segmentsByDate={derived.segmentsByDate}
            />
          ) : null}
        </div>
      </section>

      <section className="bg-card p-5">
        <h2 className="font-medium">Monthly Spend</h2>
        <div className="mt-4">
          <MonthBars months={derived.months} />
        </div>
      </section>
    </div>
  );
}

function deriveCharts(rows: readonly DailyRow[]) {
  const colors = familyColors(rows);
  const accent = colors.values().next().value ?? "#f97316";

  // Per-day totals and per-day family segments.
  const spendByDate = new Map<string, number>();
  const familiesByDate = new Map<string, Map<string, number>>();
  const spendByMonth = new Map<string, number>();
  const familiesByMonth = new Map<string, Map<string, number>>();
  let outputTokens = 0;
  for (const row of rows) {
    outputTokens += row.outputTokens;
    spendByDate.set(row.date, (spendByDate.get(row.date) ?? 0) + row.costUsd);
    const family = modelFamily(row.key);
    const families = familiesByDate.get(row.date) ?? new Map<string, number>();
    families.set(family, (families.get(family) ?? 0) + row.costUsd);
    familiesByDate.set(row.date, families);

    const month = row.date.slice(0, 7);
    spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + row.costUsd);
    const monthFamilies = familiesByMonth.get(month) ?? new Map<string, number>();
    monthFamilies.set(family, (monthFamilies.get(family) ?? 0) + row.costUsd);
    familiesByMonth.set(month, monthFamilies);
  }

  const first = rows[0]?.date ?? null;
  const last = rows.at(-1)?.date ?? null;
  const allDays = first !== null && last !== null ? enumerateDays(first, last) : [];
  const heatmapRange =
    last !== null
      ? {
          first: `${last.slice(0, 4)}-01-01`,
          last: `${last.slice(0, 4)}-12-31`,
        }
      : null;

  const familyOrder = [...colors.keys()];
  const segmentsByDate = new Map(
    [...familiesByDate.entries()].map(([date, families]) => [
      date,
      familyOrder.map((family) => ({
        color: colors.get(family) ?? "#9ca3af",
        family,
        value: families.get(family) ?? 0,
      })),
    ]),
  );

  const stackedDays: StackedDay[] = allDays.slice(-DAILY_WINDOW).map((date) => {
    const families = familiesByDate.get(date);
    return {
      date,
      segments: familyOrder.map((family) => ({
        color: colors.get(family) ?? "#9ca3af",
        family,
        value: families?.get(family) ?? 0,
      })),
      total: spendByDate.get(date) ?? 0,
    };
  });

  const months =
    last !== null
      ? enumerateCalendarYearMonths(last.slice(0, 4)).map((month) => ({
          month,
          segments: familyOrder.map((family) => ({
            color: colors.get(family) ?? "#9ca3af",
            family,
            value: familiesByMonth.get(month)?.get(family) ?? 0,
          })),
          value: spendByMonth.get(month) ?? 0,
        }))
      : [];

  return {
    accent,
    heatmap: heatmapRange,
    legend: familyOrder.map((family) => ({ color: colors.get(family) ?? "#9ca3af", family })),
    months,
    outputTokens,
    segmentsByDate,
    spendByDate,
    stackedDays,
  };
}

function enumerateCalendarYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
}

export { Route };
