import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;

import { AreaChart } from "../components/charts/area-chart";
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
  firstDate: string | null;
  lastDate: string | null;
  peakDay: { date: string; spendUsd: number } | null;
  topModel: { model: string; spendUsd: number } | null;
  totalSpendUsd: number;
  totalTokens: number;
}

function ProfileDashboard({ rows, stats }: { rows: readonly DailyRow[]; stats: DashboardStats }) {
  const derived = useMemo(() => deriveCharts(rows), [rows]);

  return (
    <div className="grid grid-cols-1 gap-px border border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total spend" value={formatUsd(stats.totalSpendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Active days" value={String(stats.activeDays)} />
        <StatCard label="Avg / active day" value={formatUsd(stats.avgSpendPerActiveDay)} />
        <StatCard
          label="Peak day"
          value={stats.peakDay === null ? "—" : formatUsd(stats.peakDay.spendUsd)}
        />
        <StatCard
          label="Top model"
          value={stats.topModel === null ? "—" : modelFamily(stats.topModel.model)}
        />
      </div>

      <section className="bg-card p-5">
        <h2 className="font-medium">Daily spend</h2>
        <div className="mt-3">
          <Legend entries={derived.legend} />
        </div>
        <div className="mt-4">
          <StackedBars days={derived.stackedDays} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-px bg-border lg:grid-cols-2">
        <section className="bg-card p-5">
          <h2 className="font-medium">Cumulative spend</h2>
          <div className="mt-4">
            <AreaChart accent={derived.accent} points={derived.cumulative} />
          </div>
        </section>
        <section className="bg-card p-5">
          <h2 className="font-medium">Monthly spend</h2>
          <div className="mt-4">
            <MonthBars accent={derived.accent} months={derived.months} />
          </div>
        </section>
      </div>

      <section className="bg-card p-5">
        <h2 className="font-medium">Activity heatmap</h2>
        <div className="mt-4 overflow-x-auto">
          {derived.heatmap !== null ? (
            <Heatmap
              accent={derived.accent}
              byDate={derived.spendByDate}
              first={derived.heatmap.first}
              last={derived.heatmap.last}
            />
          ) : null}
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
  let outputTokens = 0;
  for (const row of rows) {
    outputTokens += row.outputTokens;
    spendByDate.set(row.date, (spendByDate.get(row.date) ?? 0) + row.costUsd);
    const family = modelFamily(row.key);
    const families = familiesByDate.get(row.date) ?? new Map<string, number>();
    families.set(family, (families.get(family) ?? 0) + row.costUsd);
    familiesByDate.set(row.date, families);
  }

  const first = rows[0]?.date ?? null;
  const last = rows.at(-1)?.date ?? null;
  const allDays = first !== null && last !== null ? enumerateDays(first, last) : [];

  const familyOrder = [...colors.keys()];
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

  let running = 0;
  const cumulative = allDays.map((date) => {
    running += spendByDate.get(date) ?? 0;
    return { date, value: running };
  });

  const byMonth = new Map<string, number>();
  for (const [date, value] of spendByDate) {
    const month = date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + value);
  }
  const months = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, value]) => ({ month, value }));

  return {
    accent,
    cumulative,
    heatmap: first !== null && last !== null ? { first, last } : null,
    legend: familyOrder.map((family) => ({ color: colors.get(family) ?? "#9ca3af", family })),
    months,
    outputTokens,
    spendByDate,
    stackedDays,
  };
}

export { Route };
