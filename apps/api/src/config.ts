import * as Config from "effect/Config";
import { Context } from "effect";
import { Effect } from "effect";
import * as Redacted from "effect/Redacted";

const productName = "TokenMasala";
const apiWorkerName = "tokenmasala-api";

type TokenmasalaSandbox = "development" | "production";

interface RuntimeUrls {
  apiUrl: string;
  sandbox: TokenmasalaSandbox;
  wwwUrl: string;
}

const runtimeUrlTable = {
  development: {
    apiUrl: "http://api.tokenmasala.localhost:8788",
    sandbox: "development",
    wwwUrl: "http://tokenmasala.localhost:3002",
  },
  production: {
    apiUrl: "https://api.tokenmasala.xyz",
    sandbox: "production",
    wwwUrl: "https://tokenmasala.xyz",
  },
} as const satisfies Record<TokenmasalaSandbox, RuntimeUrls>;

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface AppConfigShape {
  apiWorkerName: string;
  corsOrigins: string[];
  github: GitHubOAuthConfig;
  google: GoogleOAuthConfig;
  productName: string;
  urls: RuntimeUrls;
}

/**
 * The worker's complete configuration, resolved once per invocation in the
 * worker's OUTER Effect.gen — alchemy discovers the Config.* reads there and
 * binds them as deploy-time secrets — and provided as a plain Layer.succeed
 * everywhere else.
 */
class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "@tokenmaxxing/api/AppConfig",
) {
  /** Secrets resolve from .env at deploy time and bind as secret_text. */
  static readonly fromEnv = Effect.gen(function* () {
    const githubClientId = yield* Config.string("GITHUB_CLIENT_ID");
    const githubClientSecret = yield* Config.redacted("GITHUB_CLIENT_SECRET");
    const googleClientId = yield* Config.string("GOOGLE_CLIENT_ID");
    const googleClientSecret = yield* Config.redacted("GOOGLE_CLIENT_SECRET");

    return makeAppConfig(
      {},
      {
        github: {
          clientId: githubClientId,
          clientSecret: Redacted.value(githubClientSecret),
        },
        google: {
          clientId: googleClientId,
          clientSecret: Redacted.value(googleClientSecret),
        },
      },
    );
  });
}

interface AppConfigEnv {
  TOKENMAXXING_ENV?: string;
}

interface AppConfigSecrets {
  github: GitHubOAuthConfig;
  google: GoogleOAuthConfig;
}

function makeAppConfig(env: AppConfigEnv, secrets: AppConfigSecrets): AppConfigShape {
  const urls = resolveRuntimeUrls(env);

  return {
    apiWorkerName,
    corsOrigins: corsOriginsFor(urls),
    productName,
    urls,
    ...secrets,
  };
}

function corsOriginsFor(urls: RuntimeUrls): string[] {
  return [
    ...new Set([
      new URL(urls.wwwUrl).origin,
      // Local dev always passes browser CORS, regardless of resolved sandbox.
      new URL(runtimeUrlTable.development.wwwUrl).origin,
    ]),
  ];
}

function resolveRuntimeUrls(env: AppConfigEnv): RuntimeUrls {
  const sandbox: TokenmasalaSandbox =
    env.TOKENMAXXING_ENV === "development" ? "development" : "production";

  return runtimeUrlTable[sandbox];
}

export { AppConfig };

export type { AppConfigShape, GitHubOAuthConfig, GoogleOAuthConfig };
