import { createFileRoute } from "@tanstack/react-router";

import { OAuthProviderButtons } from "../components/oauth-providers";
import { Card } from "../components/ui/card";

const Route = createFileRoute("/login")({
  validateSearch: (search): LoginSearch => ({
    redirect: sanitizeLoginRedirectPath(
      typeof search["redirect"] === "string" ? search["redirect"] : null,
    ),
  }),
  component: LoginPage,
});

interface LoginSearch {
  redirect?: string | undefined;
}

function LoginPage() {
  const { redirect } = Route.useSearch();

  return (
    <Card className="mx-auto mt-24 flex max-w-sm flex-col items-center p-8 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Sign in to tokenmaxxing.sh</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose an OAuth provider to create or access your profile.
      </p>
      <OAuthProviderButtons className="mt-6" redirect={redirect} />
    </Card>
  );
}

function sanitizeLoginRedirectPath(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }

  try {
    const url = new URL(trimmed, "https://tokenmaxxing.invalid");
    if (url.origin !== "https://tokenmaxxing.invalid") {
      return undefined;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export { Route };

export type { LoginSearch };
