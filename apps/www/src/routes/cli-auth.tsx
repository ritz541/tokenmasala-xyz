import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, TerminalSquare } from "lucide-react";

import { errorMessage, runApi } from "../lib/api";
import { meQuery } from "../lib/queries";

interface CliAuthSearch {
  code: string;
}

const Route = createFileRoute("/cli-auth")({
  validateSearch: (search): CliAuthSearch => ({
    code: typeof search["code"] === "string" ? search["code"] : "",
  }),
  component: CliAuthPage,
});

function CliAuthPage() {
  const { code } = Route.useSearch();
  const me = useQuery(meQuery);
  const approve = useMutation({
    mutationFn: () => runApi((client) => client.me.approveCliLogin({ payload: { code } })),
  });

  return (
    <div className="mx-auto mt-24 flex max-w-sm flex-col items-center rounded-xl border border-border bg-card p-8 text-center">
      <TerminalSquare className="size-8 text-muted-foreground" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Connect your CLI</h1>

      {code === "" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Missing login code. Run <Code>tokenmaxxing login</Code> and follow the link it prints.
        </p>
      ) : me.isPending ? (
        <p className="mt-2 text-sm text-muted-foreground">Checking your session…</p>
      ) : me.isError ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in first, then come back to approve code <Code>{code}</Code>. This page will keep
            the code in the URL.
          </p>
          <Link
            className="mt-6 w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
            to="/login"
          >
            Sign in with GitHub
          </Link>
        </>
      ) : approve.isSuccess ? (
        <>
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-accent" />
            Approved <span className="font-medium">{approve.data.deviceName}</span>.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Head back to your terminal — the CLI is signing in now.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Approve the device showing code <Code>{code}</Code> as{" "}
            <span className="font-medium">{me.data.user.login}</span>? It will be able to push usage
            data to your profile until you revoke it.
          </p>
          {approve.isError ? (
            <p className="mt-3 text-sm text-red-500">
              {errorMessage(approve.error, "Approval failed; run `tokenmaxxing login` again.")}
            </p>
          ) : null}
          <button
            className="mt-6 w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
            type="button"
          >
            {approve.isPending ? "Approving…" : "Approve device"}
          </button>
        </>
      )}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

export { Route };

export type { CliAuthSearch };
