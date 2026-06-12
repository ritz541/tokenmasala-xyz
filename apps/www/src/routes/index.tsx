import { createFileRoute } from "@tanstack/react-router";

const Route = createFileRoute("/")({
  component: LeaderboardPage,
});

function LeaderboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The leaderboard lands with the usage-sync milestone. Install the CLI and run{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">tokenmaxxing sync</code>{" "}
        to be on it at launch.
      </p>
    </div>
  );
}

export { Route };
