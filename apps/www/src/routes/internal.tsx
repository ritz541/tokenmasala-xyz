import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import type { AdminDeviceStatus, AdminUsersResponse } from "@tokenmaxxing/api-contract";

import { Avatar } from "../components/ui/avatar";
import { isApiError } from "../lib/api";
import { adminUsersQueryOptions } from "../lib/queries";

const INTERNAL_PATH = "/internal";

type AdminUsersData = typeof AdminUsersResponse.Type;

const Route = createFileRoute("/internal")({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(adminUsersQueryOptions);
    } catch (error) {
      if (isApiError(error, "Unauthorized")) {
        throw redirect({
          search: { redirect: INTERNAL_PATH },
          to: "/login",
        });
      }
      if (isApiError(error, "Forbidden")) {
        throw notFound();
      }

      throw error;
    }
  },
  component: InternalPage,
  notFoundComponent: NotFoundPage,
});

function InternalPage() {
  const { data } = useSuspenseQuery(adminUsersQueryOptions);

  return (
    <>
      <header className="px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Internal</h1>
          <p className="mt-1 text-sm text-muted-foreground">{fleetSummary(data)}</p>
        </div>
      </header>
      <dl className="grid gap-px border-y border-border bg-border text-sm sm:grid-cols-3">
        <SummaryCell label="Latest CLI" value={formatVersion(data.latestCliVersion)} />
        <SummaryCell label="Users" value={formatInteger(data.summary.totalUsers)} />
        <SummaryCell label="Devices" value={formatInteger(data.summary.totalDevices)} />
      </dl>
      <div className="overflow-x-auto border-b border-border">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-[30%] p-3 font-medium">User</th>
              <th className="w-[16%] p-3 font-medium">Version</th>
              <th className="hidden w-[14%] p-3 font-medium md:table-cell">Arch</th>
              <th className="w-[16%] p-3 font-medium">Status</th>
              <th className="w-[24%] p-3 font-medium">Last check-in</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((row) => (
              <tr className="border-b border-border last:border-b-0" key={row.user.id}>
                <td className="p-3 align-top">
                  <Link
                    className="flex items-center gap-2.5 font-medium hover:underline"
                    params={{ user: row.user.login }}
                    to="/$user"
                  >
                    <Avatar size={24} src={row.user.avatarUrl} />
                    {row.user.login}
                  </Link>
                </td>
                <td className="p-3 align-top font-medium">
                  {formatVersion(row.latestDevice?.version ?? null)}
                </td>
                <td className="hidden p-3 align-top font-mono text-muted-foreground md:table-cell">
                  {row.latestDevice?.arch ?? "—"}
                </td>
                <td className="p-3 align-top">
                  <StatusPill status={row.status} title={serviceStatusTitle(row)} />
                </td>
                <td className="p-3 align-top">
                  <div title={row.latestCheckInAt ?? undefined}>
                    {formatRelativeTime(row.latestCheckInAt, data.generatedAt)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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

function StatusPill({ status, title }: { status: AdminDeviceStatus; title?: string }) {
  const className = {
    latest: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    "repair-needed": "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    updating: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    stale: "border-accent/50 bg-accent/10 text-accent",
    unknown: "border-border bg-muted text-muted-foreground",
  }[status];

  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 font-mono text-xs ${className}`}
      title={title}
    >
      {status}
    </span>
  );
}

function fleetSummary(data: AdminUsersData): string {
  return [
    `User fleet`,
    `${formatInteger(data.summary.latest)} on latest`,
    `${formatInteger(data.summary.repairNeeded)} repair needed`,
    `${formatInteger(data.summary.updating)} updating`,
    `${formatInteger(data.summary.stale)} stale`,
    `${formatInteger(data.summary.unknown)} unknown`,
  ].join(" · ");
}

function serviceStatusTitle(row: AdminUsersData["users"][number]): string | undefined {
  const device = row.latestDevice;
  if (device === null) {
    return undefined;
  }

  return [
    device.serviceBackend === null ? undefined : `backend: ${device.serviceBackend}`,
    device.serviceStatus === null ? undefined : `service: ${device.serviceStatus}`,
    device.serviceSchedulerActive === null
      ? undefined
      : `scheduler: ${device.serviceSchedulerActive ? "active" : "inactive"}`,
    device.serviceReloadRequired === null
      ? undefined
      : `reload: ${device.serviceReloadRequired ? "required" : "not required"}`,
    device.serviceError === null ? undefined : `error: ${device.serviceError}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
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

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatInteger(value: number): string {
  return integer.format(value);
}

export { Route };
