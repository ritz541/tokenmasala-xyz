import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";

import { formatTokens, formatUsd } from "../components/charts/scale";
import { Avatar } from "../components/ui/avatar";
import { Code } from "../components/ui/code";
import { Tabs } from "../components/ui/tabs";
import { leaderboardQueryOptions } from "../lib/queries";

interface LeaderboardSearch {
  metric: typeof LeaderboardMetric.Type;
  window: typeof LeaderboardWindow.Type;
}

const Route = createFileRoute("/")({
  validateSearch: (search): LeaderboardSearch => ({
    metric: search["metric"] === "tokens" ? "tokens" : "spend",
    window: search["window"] === "7d" ? "7d" : search["window"] === "30d" ? "30d" : "all",
  }),
  component: LeaderboardPage,
});

const WINDOWS: { label: string; value: typeof LeaderboardWindow.Type }[] = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "All time", value: "all" },
];

const METRICS: { label: string; value: typeof LeaderboardMetric.Type }[] = [
  { label: "Spend", value: "spend" },
  { label: "Tokens", value: "tokens" },
];

function LeaderboardPage() {
  const { metric, window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const leaderboard = useQuery(leaderboardQueryOptions(metric, window));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who is maxxing the most tokens. Join with{" "}
            <Code>bunx @851-labs/tokenmaxxing@latest login</Code>
          </p>
        </div>
        <div className="flex gap-2">
          <Tabs
            onChange={(value) => navigate({ search: (prev) => ({ ...prev, metric: value }) })}
            options={METRICS}
            value={metric}
          />
          <Tabs
            onChange={(value) => navigate({ search: (prev) => ({ ...prev, window: value }) })}
            options={WINDOWS}
            value={window}
          />
        </div>
      </div>

      <div className="mt-6 overflow-hidden border border-border">
        {leaderboard.isPending ? (
          <p className="p-6 text-sm text-muted-foreground">Loading the rankings…</p>
        ) : leaderboard.isError ? (
          <p className="p-6 text-sm text-muted-foreground">
            Could not load the leaderboard; refresh to retry.
          </p>
        ) : leaderboard.data.entries.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            Nobody on the board yet — be the first to sync.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-12 p-3 font-medium">#</th>
                <th className="p-3 font-medium">User</th>
                <th className="p-3 text-right font-medium">Spend</th>
                <th className="p-3 text-right font-medium">Tokens</th>
                <th className="hidden p-3 text-right font-medium sm:table-cell">Active days</th>
                <th className="hidden p-3 text-right font-medium sm:table-cell">Last active</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.data.entries.map((entry) => (
                <tr
                  className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/40"
                  key={entry.user.id}
                >
                  <td className="p-3 font-mono text-muted-foreground">{entry.rank}</td>
                  <td className="p-3">
                    <Link
                      className="flex items-center gap-2.5 font-medium hover:underline"
                      params={{ user: entry.user.login }}
                      to="/$user"
                    >
                      <Avatar size={24} src={entry.user.avatarUrl} />
                      {entry.user.login}
                    </Link>
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums">
                    {formatUsd(entry.spendUsd)}
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums">
                    {formatTokens(entry.totalTokens)}
                  </td>
                  <td className="hidden p-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {entry.activeDays}
                  </td>
                  <td className="hidden p-3 text-right text-muted-foreground sm:table-cell">
                    {entry.lastDate ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export { Route };

export type { LeaderboardSearch };
