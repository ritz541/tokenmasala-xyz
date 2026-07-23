import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEventSummary } from "@tokenmaxxing/api-contract";

import { activityFeedQueryOptions } from "../lib/queries";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";

type EventSummary = typeof ActivityEventSummary.Type;

function formatTokens(num: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(num);
}

function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost);
}

function formatTimeAgo(tsString: string): string {
  const date = new Date(tsString);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return `${Math.max(0, diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

function ActivityFeed() {
  const query = useQuery(activityFeedQueryOptions);
  const [liveEvents, setLiveEvents] = useState<EventSummary[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      return;
    }

    const apiUrl = process.env.VITE_PUBLIC_API_URL ?? "http://api.tokenmasala.localhost:8788";
    const es = new EventSource(`${apiUrl}/activity/stream`);

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as EventSummary;
        setLiveEvents((prev) => {
          if (prev.some((e) => e.id === parsed.id)) return prev;
          return [parsed, ...prev].slice(0, 50);
        });
      } catch {
        // ignore parse error
      }
    };

    return () => es.close();
  }, []);

  const baseEvents = query.data?.events ?? [];
  const mergedEventsMap = new Map<string, EventSummary>();
  for (const e of liveEvents) {
    mergedEventsMap.set(e.id, e);
  }
  for (const e of baseEvents) {
    if (!mergedEventsMap.has(e.id)) {
      mergedEventsMap.set(e.id, e);
    }
  }

  const events = [...mergedEventsMap.values()].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  );

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-center justify-between border-b border-neutral-800 pb-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-500"></span>
          </span>
          <h3 className="text-sm font-semibold text-neutral-200">Live Activity Feed</h3>
        </div>
        <span className="text-xs text-neutral-500 font-mono">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </div>

      {events.length === 0 ? (
        <div className="py-6 text-center text-xs text-neutral-500 font-mono">
          No live token activity recorded yet. Run{" "}
          <code className="text-pink-400">tokenmaxxing sync</code> to broadcast activity.
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[400px] overflow-y-auto pr-1">
          {events.map((event) => (
            <div
              key={event.id}
              className="flex items-center justify-between rounded-md border border-neutral-800/80 bg-neutral-950/60 p-2.5 text-xs font-mono transition-colors hover:border-neutral-700"
            >
              <div className="flex items-center gap-2.5 overflow-hidden">
                <Avatar src={event.user.avatarUrl ?? null} name={event.user.name} size="sm" />
                <div className="flex items-center gap-2 truncate">
                  <span className="font-medium text-neutral-200 truncate">{event.user.name}</span>
                  <Badge
                    variant="muted"
                    className="text-[10px] text-pink-400 border-pink-500/30 uppercase"
                  >
                    {event.source}
                  </Badge>
                  <span className="text-neutral-400 truncate">{event.model}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 ml-2">
                {event.cacheReadTokens > 0 && (
                  <span className="text-neutral-500 text-[11px]">
                    cache: {formatTokens(event.cacheReadTokens)}
                  </span>
                )}
                <span className="font-semibold text-neutral-200">
                  {formatTokens(event.totalTokens)} tok
                </span>
                <span className="text-neutral-400">{formatCost(event.costUsd)}</span>
                <span className="text-[10px] text-neutral-500 min-w-[50px] text-right">
                  {formatTimeAgo(event.ts)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { ActivityFeed };
