import { Collapsible } from "@base-ui-components/react/collapsible";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";
import type { ReactNode } from "react";

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

const FAQ_ITEMS: { answer: ReactNode; question: string }[] = [
  {
    question: "What is tokenmaxxing?",
    answer:
      "tokenmaxxing is a public leaderboard for LLM agent usage. It syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users.",
  },
  {
    question: "How do I join the leaderboard?",
    answer: (
      <>
        Install the CLI, then run the bootstrap command.
        <span className="mt-3 block">
          <Code>npm install -g @851-labs/tokenmaxxing</Code>
        </span>
        <span className="mt-2 block">
          <Code>tokenmaxxing bootstrap</Code>
        </span>
        <span className="mt-3 block">
          Bootstrap signs you in, syncs your usage, and can set up automatic syncing.
        </span>
      </>
    ),
  },
  {
    question: "Which agents does it support?",
    answer: (
      <>
        tokenmaxxing uses{" "}
        <a
          className="font-medium text-foreground hover:underline"
          href="https://ccusage.com/"
          rel="noreferrer"
          target="_blank"
        >
          ccusage
        </a>{" "}
        to parse local usage from Claude Code, Codex, OpenCode, Gemini CLI, and Copilot CLI.
      </>
    ),
  },
  {
    question: "What data gets uploaded?",
    answer:
      "Only daily aggregates: date, model name, agent source, token counts, and API-equivalent cost. Prompts, file paths, project names, and session content are never uploaded.",
  },
  {
    question: "Why is usage data missing?",
    answer:
      "tokenmaxxing only reads usage data that still exists on your local computer. Some agents clean up old local logs automatically; for example, Claude Code can retain logs for only 30 days by default. If older local data has already been deleted, tokenmaxxing cannot recover or upload it.",
  },
  {
    question: "Are profiles public?",
    answer:
      "Yes. Profiles and leaderboard totals are public. Device hostnames are shown only to you in settings and in your own per-device breakdown.",
  },
  {
    question: "Can I sync multiple machines?",
    answer: (
      <>
        Yes. Run <Code>tokenmaxxing bootstrap</Code> on each machine. Your profile aggregates usage
        across devices, and sync is idempotent, so you can run it as often as you want.
      </>
    ),
  },
  {
    question: "How can I sync usage automatically?",
    answer: (
      <>
        Run <Code>tokenmaxxing service install</Code> to install an optional background service that
        syncs hourly. Use <Code>tokenmaxxing service status</Code> to check the last run and{" "}
        <Code>tokenmaxxing service doctor</Code> to inspect scheduler files, auth, locks,
        auto-update settings, and recent logs.
      </>
    ),
  },
  {
    question: "Can I delete or revoke access?",
    answer: (
      <>
        Yes. CLI tokens do not expire automatically, but you can revoke them with{" "}
        <Code>tokenmaxxing logout</Code> or from settings. You can also remove device data from your
        settings page.
      </>
    ),
  },
  {
    question: "How is spend calculated?",
    answer:
      "Spend is an API-equivalent estimate from the parsed usage data. It is meant for leaderboard comparison and usage tracking, not billing reconciliation.",
  },
  {
    question: "Can I preview what will sync?",
    answer: (
      <>
        Yes. Run <Code>tokenmaxxing sync --dry-run</Code> to see what would be pushed. You can also
        limit the range with <Code>--since YYYY-MM-DD</Code> or choose sources with flags like{" "}
        <Code>--sources claude,codex</Code>.
      </>
    ),
  },
];

function LeaderboardPage() {
  const { metric, window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const leaderboard = useQuery(leaderboardQueryOptions(metric, window));

  return (
    <div className="px-4 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who is maxxing the most tokens. Join with{" "}
            <Code>npm install -g @851-labs/tokenmaxxing</Code>
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

      <div className="-mx-4 mt-6 overflow-hidden border-y border-border">
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

      <FaqSection />
    </div>
  );
}

function FaqSection() {
  return (
    <section className="mt-10 pt-8" aria-labelledby="homepage-faq-title">
      <h2 id="homepage-faq-title" className="text-lg font-semibold tracking-tight">
        FAQ
      </h2>
      <div className="-mx-4 mt-4 divide-y divide-border border-y border-border">
        {FAQ_ITEMS.map((item) => (
          <Collapsible.Root className="px-4 py-4" key={item.question}>
            <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-2 bg-transparent p-0 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="w-4 shrink-0 text-center font-mono text-muted-foreground transition-transform group-data-[panel-open]:rotate-45">
                +
              </span>
              <span>{item.question}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel
              className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0"
              hiddenUntilFound
            >
              <div className="max-w-2xl pt-3 text-sm leading-6 text-muted-foreground">
                {item.answer}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}
      </div>
    </section>
  );
}

export { Route };

export type { LeaderboardSearch };
