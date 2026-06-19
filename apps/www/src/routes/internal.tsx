import { useQuery, type QueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { AdminUsersResponse, type AdminDeviceStatus } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";

import { adminUsersQueryOptions } from "../lib/queries";
import { resolveApiUrl } from "../lib/config";

const INTERNAL_PATH = "/internal";

type AdminUsersData = typeof AdminUsersResponse.Type;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type InternalAdminLoadResult =
  | { status: "forbidden" }
  | { data: AdminUsersData; status: "ok" }
  | { status: "unauthenticated" };

const requireInternalAdminData = createServerFn({ method: "GET" }).handler(async () =>
  fetchInternalAdminData(getRequestHeader("cookie")),
);

const Route = createFileRoute("/internal")({
  loader: ({ context }) => loadInternalRoute(context.queryClient),
  component: InternalPage,
});

async function loadInternalRoute(
  queryClient: QueryClient,
  loadAdminData: () => Promise<InternalAdminLoadResult> = requireInternalAdminData,
): Promise<Exclude<InternalAdminLoadResult, { status: "unauthenticated" }>> {
  const result = await loadAdminData();
  if (result.status === "unauthenticated") {
    throw redirect({
      search: { redirect: INTERNAL_PATH },
      to: "/login",
    });
  }

  if (result.status === "ok") {
    queryClient.setQueryData(adminUsersQueryOptions.queryKey, result.data);
  }

  return result;
}

async function fetchInternalAdminData(
  cookie: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<InternalAdminLoadResult> {
  const response = await fetcher(`${resolveApiUrl()}/admin/users`, {
    headers: cookie === undefined ? undefined : { cookie },
  });

  if (response.status === 401) {
    return { status: "unauthenticated" };
  }

  if (response.status === 403 || response.status === 404) {
    return { status: "forbidden" };
  }

  if (!response.ok) {
    throw new Error(`Internal admin load failed with HTTP ${response.status}.`);
  }

  return {
    data: await Schema.decodeUnknownPromise(AdminUsersResponse)(await response.json()),
    status: "ok",
  };
}

function InternalPage() {
  const loaded = Route.useLoaderData();
  if (loaded.status === "forbidden") {
    return <NotFoundPage />;
  }

  const query = useQuery(adminUsersQueryOptions);
  const data = query.data ?? loaded.data;

  return (
    <div className="px-4 pb-10 pt-8">
      <header>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Internal</h1>
          <p className="mt-1 text-sm text-muted-foreground">{fleetSummary(data)}</p>
        </div>
        <dl className="-mx-4 mt-6 grid gap-px border-y border-border bg-border text-sm sm:grid-cols-3">
          <SummaryCell label="Latest CLI" value={formatVersion(data.latestCliVersion)} />
          <SummaryCell label="Users" value={formatInteger(data.summary.totalUsers)} />
          <SummaryCell label="Devices" value={formatInteger(data.summary.totalDevices)} />
        </dl>
      </header>
      <div className="-mx-4 mt-6 overflow-x-auto border-b border-border">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-[18%] p-3 font-medium">User</th>
              <th className="w-[10%] p-3 font-medium">Version</th>
              <th className="hidden w-[8%] p-3 font-medium md:table-cell">Arch</th>
              <th className="w-[10%] p-3 font-medium">Status</th>
              <th className="w-[16%] p-3 font-medium">Last check-in</th>
              <th className="w-[18%] p-3 font-medium">Device</th>
              <th className="hidden w-[10%] p-3 text-right font-medium lg:table-cell">Tokens</th>
              <th className="w-[12%] p-3 text-right font-medium">Usage</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((row) => (
              <tr className="border-b border-border last:border-b-0" key={row.user.id}>
                <td className="p-3 align-top">
                  <div className="font-medium">{row.user.login}</div>
                  <div className="text-xs text-muted-foreground">{row.user.name ?? "—"}</div>
                  <div className="mt-1 max-w-56 truncate text-xs text-muted-foreground">
                    {row.verifiedEmails.join(", ") || "no verified email"}
                  </div>
                </td>
                <td className="p-3 align-top font-mono font-semibold">
                  {formatVersion(row.latestDevice?.version ?? null)}
                </td>
                <td className="hidden p-3 align-top font-mono text-muted-foreground md:table-cell">
                  {row.latestDevice?.arch ?? "—"}
                </td>
                <td className="p-3 align-top">
                  <StatusPill status={row.status} />
                </td>
                <td className="p-3 align-top">
                  <div title={row.latestCheckInAt ?? undefined}>
                    {formatRelativeTime(row.latestCheckInAt, data.generatedAt)}
                  </div>
                  <div className="break-all text-xs text-muted-foreground">
                    {formatUtc(row.latestCheckInAt)}
                  </div>
                </td>
                <td className="p-3 align-top">
                  <div className="break-words">{row.latestDevice?.name ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.latestDevice === null
                      ? "no device"
                      : `${row.latestDevice.platform} · ${formatInteger(row.deviceCount)} device${row.deviceCount === 1 ? "" : "s"}`}
                  </div>
                </td>
                <td className="hidden p-3 text-right align-top lg:table-cell">
                  <div>{formatInteger(row.activeTokenCount)} active</div>
                  <div className="text-xs text-muted-foreground">
                    {formatInteger(row.revokedTokenCount)} revoked
                  </div>
                  <div className="text-xs text-muted-foreground">
                    used {formatRelativeTime(row.lastTokenUsedAt, data.generatedAt)}
                  </div>
                </td>
                <td className="p-3 text-right align-top">
                  <div>{formatCompactInteger(row.totalTokens)} tokens</div>
                  <div className="text-xs text-muted-foreground">
                    {formatUsd(row.totalSpendUsd)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatInteger(row.activeDays)} active days
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.sources.length === 0 ? "no sources" : row.sources.join(", ")}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page does not exist.</p>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-4">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-base font-semibold">{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: AdminDeviceStatus }) {
  const className = {
    latest: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    outdated: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    stale: "border-accent/50 bg-accent/10 text-accent",
    unknown: "border-border bg-muted text-muted-foreground",
  }[status];

  return (
    <span className={`inline-flex items-center border px-2 py-0.5 font-mono text-xs ${className}`}>
      {status}
    </span>
  );
}

function fleetSummary(data: AdminUsersData): string {
  return [
    `User fleet`,
    `${formatInteger(data.summary.latest)} on latest`,
    `${formatInteger(data.summary.outdated)} outdated`,
    `${formatInteger(data.summary.stale)} stale`,
    `${formatInteger(data.summary.unknown)} unknown`,
  ].join(" · ");
}

function formatVersion(version: string | null): string {
  if (version === null) {
    return "unknown";
  }

  return version.startsWith("v") ? version : `v${version}`;
}

function formatRelativeTime(value: string | null, now: string): string {
  if (value === null) {
    return "—";
  }

  const elapsedMs = Date.parse(now) - Date.parse(value);
  if (!Number.isFinite(elapsedMs)) {
    return "—";
  }

  const minutes = Math.max(Math.floor(elapsedMs / 60_000), 0);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function formatUtc(value: string | null): string {
  if (value === null) {
    return "";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return date.toISOString().replace(".000Z", "Z");
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactInteger = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const usd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});

function formatInteger(value: number): string {
  return integer.format(value);
}

function formatCompactInteger(value: number): string {
  return compactInteger.format(value);
}

function formatUsd(value: number): string {
  return usd.format(value);
}

export { Route };

export { fetchInternalAdminData, fleetSummary, formatRelativeTime, loadInternalRoute };

export type { InternalAdminLoadResult };
