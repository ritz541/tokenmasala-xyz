import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { MeResponse } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import { Laptop, KeyRound } from "lucide-react";

import { Button } from "../components/ui/button";
import { Code } from "../components/ui/code";
import { errorMessage, runApi } from "../lib/api";
import { resolveApiUrl } from "../lib/config";
import { devicesQuery, meQuery, tokensQuery } from "../lib/queries";

const SETTINGS_PATH = "/settings";

type Me = typeof MeResponse.Type;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const requireSettingsSession = createServerFn({ method: "GET" }).handler(async () =>
  fetchSettingsSession(getRequestHeader("cookie")),
);

const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => guardSettingsRoute(context.queryClient),
  component: SettingsPage,
});

async function guardSettingsRoute(
  queryClient: QueryClient,
  loadSession: () => Promise<Me | null> = requireSettingsSession,
): Promise<void> {
  const me = await loadSession();
  if (me === null) {
    throw redirect({
      search: { redirect: SETTINGS_PATH },
      to: "/login",
    });
  }

  queryClient.setQueryData(meQuery.queryKey, me);
}

async function fetchSettingsSession(
  cookie: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<Me | null> {
  const response = await fetcher(`${resolveApiUrl()}/me`, {
    headers: cookie === undefined ? undefined : { cookie },
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Settings session check failed with HTTP ${response.status}.`);
  }

  return Schema.decodeUnknownPromise(MeResponse)(await response.json());
}

function SettingsPage() {
  const me = useQuery(meQuery);

  if (me.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (me.isError) {
    return (
      <p className="text-sm text-red-500">
        {errorMessage(me.error, "Could not load your session; refresh and try again.")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium">{me.data.user.login}</span>
        </p>
      </div>
      <DevicesSection />
      <TokensSection />
    </div>
  );
}

function DevicesSection() {
  const devices = useQuery(devicesQuery);

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Laptop className="size-4" /> Devices
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every machine that has pushed usage. Aggregates on your profile span all of them.
      </p>
      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        {devices.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : devices.isError || devices.data.devices.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No devices yet — run <Code>tokenmaxxing login</Code> on a machine to add it.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {devices.data.devices.map((device) => (
                <tr className="border-b border-border last:border-b-0" key={device.id}>
                  <td className="p-3 font-medium">{device.name}</td>
                  <td className="p-3 text-muted-foreground">{device.platform}</td>
                  <td className="p-3 text-right text-muted-foreground">
                    {device.lastSyncAt === null
                      ? "never synced"
                      : `synced ${new Date(device.lastSyncAt).toLocaleString()}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TokensSection() {
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery);
  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      runApi((client) => client.me.revokeToken({ params: { tokenId } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <KeyRound className="size-4" /> CLI tokens
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tokens never expire — revoking here (or `tokenmaxxing logout` on the device) is the only
        kill switch.
      </p>
      {revoke.isError ? (
        <p className="mt-2 text-sm text-red-500">
          {errorMessage(revoke.error, "Revoke failed; refresh and try again.")}
        </p>
      ) : null}
      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        {tokens.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : tokens.isError || tokens.data.tokens.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No CLI tokens yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {tokens.data.tokens.map((token) => (
                <tr className="border-b border-border last:border-b-0" key={token.id}>
                  <td className="p-3 font-medium">{token.name ?? "unnamed"}</td>
                  <td className="p-3 text-muted-foreground">
                    {token.lastUsedAt === null
                      ? "never used"
                      : `used ${new Date(token.lastUsedAt).toLocaleString()}`}
                  </td>
                  <td className="p-3 text-right">
                    {token.revokedAt !== null ? (
                      <span className="text-muted-foreground">revoked</span>
                    ) : (
                      <Button
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(token.id)}
                        variant="destructive"
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export { fetchSettingsSession, guardSettingsRoute, Route };
