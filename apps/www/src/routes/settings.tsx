import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { DeviceSummary, MeResponse, UserAccountSummary } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import { Key, Laptop, Link } from "@phosphor-icons/react/ssr";

import {
  oauthProviderLabel,
  oauthProviderLinks,
  type OAuthProviderId,
} from "../components/oauth-providers";
import { Button, buttonClassName } from "../components/ui/button";
import { Code } from "../components/ui/code";
import { errorMessage, runApi } from "../lib/api";
import { resolveApiUrl } from "../lib/config";
import {
  accountsQueryOptions,
  devicesQueryOptions,
  meQueryOptions,
  tokensQueryOptions,
} from "../lib/queries";

const SETTINGS_PATH = "/settings";

type Me = typeof MeResponse.Type;
type Device = typeof DeviceSummary.Type;
type Account = typeof UserAccountSummary.Type;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type DeviceDeleteInvalidationKey = readonly unknown[];

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

  queryClient.setQueryData(meQueryOptions.queryKey, me);
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
  const me = useQuery(meQueryOptions);

  if (me.isPending) {
    return (
      <div className="px-4 pt-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="px-4 pt-8">
        <p className="text-sm text-red-500">
          {errorMessage(me.error, "Could not load your session; refresh and try again.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 px-4 pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <ConnectedAccountsSection />
      <DevicesSection login={me.data.user.login} />
      <TokensSection />
    </div>
  );
}

function ConnectedAccountsSection() {
  const accounts = useQuery(accountsQueryOptions);
  const byProvider =
    accounts.data === undefined
      ? new Map<OAuthProviderId, Account>()
      : new Map(accounts.data.accounts.map((account) => [account.provider, account]));
  const providerLinks = oauthProviderLinks({ redirect: SETTINGS_PATH });

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Link className="size-4" /> Connected accounts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign in with any connected provider to reach the same profile.
      </p>
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        {accounts.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : accounts.isError ? (
          <p className="p-4 text-sm text-red-500">
            {errorMessage(accounts.error, "Could not load connected accounts.")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {providerLinks.map((provider) => {
                const account = byProvider.get(provider.id);

                return (
                  <tr className="border-b border-border last:border-b-0" key={provider.id}>
                    <td className="p-3 font-medium">{oauthProviderLabel(provider.id)}</td>
                    <td className="p-3 text-muted-foreground">
                      {account === undefined ? "Not connected" : accountLabel(account)}
                    </td>
                    <td className="p-3 text-right">
                      {account === undefined ? (
                        <a
                          className={buttonClassName({ variant: "primary", size: "sm" })}
                          href={provider.href}
                        >
                          Connect
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Connected</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function DevicesSection({ login }: { login: string }) {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQueryOptions);
  const deleteDevice = useMutation({
    mutationFn: (device: Device) =>
      runApi((client) => client.me.deleteDevice({ params: { deviceId: device.id } })),
    onSuccess: async () => {
      await Promise.all(
        deviceDeleteInvalidationKeys(login).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });

  const requestDelete = (device: Device) => {
    if (!confirmDeviceDelete(device)) {
      return;
    }

    deleteDevice.mutate(device);
  };

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Laptop className="size-4" /> Devices
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every machine that has pushed usage. Aggregates on your profile span all of them.
      </p>
      {deleteDevice.isError ? (
        <p className="mt-2 text-sm text-red-500">
          {errorMessage(deleteDevice.error, "Delete failed; refresh and try again.")}
        </p>
      ) : null}
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
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
                  <td className="p-3 text-right">
                    <Button
                      disabled={deleteDevice.isPending}
                      onClick={() => requestDelete(device)}
                      variant="destructive"
                    >
                      Delete data
                    </Button>
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
  const tokens = useQuery(tokensQueryOptions);
  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      runApi((client) => client.me.revokeToken({ params: { tokenId } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQueryOptions.queryKey }),
  });

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Key className="size-4" /> CLI tokens
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
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
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

function accountLabel(account: Account): string {
  return account.email ?? account.login ?? account.name ?? "Connected";
}

function deviceDeleteConfirmationMessage(deviceName: string): string {
  return `Delete synced usage for ${deviceName}? This removes the device from your profile and revokes its CLI tokens.`;
}

function confirmDeviceDelete(
  device: Pick<Device, "name">,
  confirm: (message: string) => boolean = window.confirm,
): boolean {
  return confirm(deviceDeleteConfirmationMessage(device.name));
}

function deviceDeleteInvalidationKeys(login: string): DeviceDeleteInvalidationKey[] {
  return [devicesQueryOptions.queryKey, tokensQueryOptions.queryKey, ["profile", login]];
}

export {
  accountLabel,
  confirmDeviceDelete,
  deviceDeleteConfirmationMessage,
  deviceDeleteInvalidationKeys,
  fetchSettingsSession,
  guardSettingsRoute,
  Route,
};
