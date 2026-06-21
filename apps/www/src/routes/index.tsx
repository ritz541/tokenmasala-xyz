import { Collapsible } from "@base-ui-components/react/collapsible";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";
import { useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react/ssr";
import { z } from "zod";

import { Button } from "../components/ui/button";
import { formatTokens, formatUsd } from "../components/charts/scale";
import { Avatar } from "../components/ui/avatar";
import { Code } from "../components/ui/code";
import { Tabs } from "../components/ui/tabs";
import { leaderboardQueryOptions } from "../lib/queries";

const LEADERBOARD_METRIC_VALUES = ["spend", "tokens"] as const;
const LEADERBOARD_WINDOW_VALUES = ["7d", "30d", "all"] as const;

const leaderboardSearchSchema = z.object({
  metric: z.enum(LEADERBOARD_METRIC_VALUES).default("spend").catch("spend"),
  window: z.enum(LEADERBOARD_WINDOW_VALUES).default("30d").catch("30d"),
});

type LeaderboardSearch = z.infer<typeof leaderboardSearchSchema>;

const DEFAULT_LEADERBOARD_SEARCH = {
  metric: "spend",
  window: "30d",
} as const satisfies LeaderboardSearch;

const BOOTSTRAP_COMMAND = "npm install -g @851-labs/tokenmaxxing && tokenmaxxing bootstrap";

const Route = createFileRoute("/")({
  validateSearch: leaderboardSearchSchema,
  search: {
    middlewares: [stripSearchParams<LeaderboardSearch>(DEFAULT_LEADERBOARD_SEARCH)],
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.metric, deps.window));
  },
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
  const { data } = useSuspenseQuery(leaderboardQueryOptions(metric, window));

  return (
    <>
      <HeroSection />

      <section aria-labelledby="homepage-leaderboard-title">
        <header className="px-4 pt-8 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="homepage-leaderboard-title">
                Leaderboard
              </h2>
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
        </header>

        <div className="overflow-hidden border-y border-border">
          {data.entries.length === 0 ? (
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
                {data.entries.map((entry) => (
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
      </section>

      <FaqSection />
    </>
  );
}

function HeroSection() {
  const [copied, setCopied] = useState(false);

  const copyBootstrapCommand = async () => {
    if (navigator.clipboard === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(BOOTSTRAP_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      return;
    }
  };

  return (
    <section className="border-b border-border px-4 py-10 sm:py-14" aria-labelledby="hero-title">
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl" id="hero-title">
        Welcome to tokenmaxxing
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Sync local agent usage, publish your profile, and climb the leaderboard.
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <code className="block min-w-0 overflow-x-auto border border-border bg-muted px-3 py-2 font-mono text-sm sm:flex-1">
          {BOOTSTRAP_COMMAND}
        </code>
        <Button className="shrink-0" onClick={() => void copyBootstrapCommand()} size="md">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy bootstrap command"}
        </Button>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="pt-8" aria-labelledby="homepage-faq-title">
      <h2 id="homepage-faq-title" className="px-4 text-lg font-semibold tracking-tight">
        FAQ
      </h2>
      <div className="mt-4 divide-y divide-border border-y border-border">
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
              <div className="ml-6 max-w-2xl pt-3 text-sm leading-6 text-muted-foreground">
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
