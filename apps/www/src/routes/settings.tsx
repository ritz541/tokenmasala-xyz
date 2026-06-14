import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Laptop, KeyRound } from "lucide-react";

import { errorMessage, runApi } from "../lib/api";
import { devicesQuery, meQuery, tokensQuery } from "../lib/queries";

const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const me = useQuery(meQuery);

  if (me.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (me.isError) {
    return (
      <div className="mt-24 text-center">
        <p className="text-sm text-muted-foreground">Sign in to manage your devices and tokens.</p>
        <Link
          className="mt-4 inline-block text-sm underline"
          search={{ redirect: "/settings" }}
          to="/login"
        >
          Sign in with GitHub
        </Link>
      </div>
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
            No devices yet — run <code className="font-mono text-xs">tokenmaxxing login</code> on a
            machine to add it.
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
                      <button
                        className="text-red-500 hover:underline disabled:opacity-50"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(token.id)}
                        type="button"
                      >
                        Revoke
                      </button>
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

export { Route };
