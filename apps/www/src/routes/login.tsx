import { createFileRoute } from "@tanstack/react-router";

import { LOGIN_OAUTH_PROVIDERS, OAuthProviderButtons } from "../components/oauth-providers";
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
    <div className="flex min-h-[calc(100vh-12rem)] items-center px-4 py-8">
      <Card className="mx-auto flex w-full max-w-sm flex-col items-center p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to tokenmaxxing.sh</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose an OAuth provider to create or access your profile.
        </p>
        <OAuthProviderButtons
          className="mt-6"
          providers={LOGIN_OAUTH_PROVIDERS}
          redirect={redirect}
        />
      </Card>
    </div>
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
