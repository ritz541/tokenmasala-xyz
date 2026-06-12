import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const productName = "Tokenmaxxing";
const apiWorkerName = "tokenmaxxing-api";

type TokenmaxxingSandbox = "development" | "production";

interface RuntimeUrls {
  apiUrl: string;
  sandbox: TokenmaxxingSandbox;
  wwwUrl: string;
}

const runtimeUrlTable = {
  development: {
    apiUrl: "http://api.tokenmaxxing.localhost:8788",
    sandbox: "development",
    wwwUrl: "http://tokenmaxxing.localhost:3002",
  },
  production: {
    apiUrl: "https://api.tokenmaxxing.851.sh",
    sandbox: "production",
    wwwUrl: "https://tokenmaxxing.851.sh",
  },
} as const satisfies Record<TokenmaxxingSandbox, RuntimeUrls>;

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface AppConfigShape {
  apiWorkerName: string;
  corsOrigins: string[];
  github: GitHubOAuthConfig;
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

    return makeAppConfig(
      {},
      {
        github: {
          clientId: githubClientId,
          clientSecret: Redacted.value(githubClientSecret),
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
  const sandbox: TokenmaxxingSandbox =
    env.TOKENMAXXING_ENV === "development" ? "development" : "production";

  return runtimeUrlTable[sandbox];
}

export { AppConfig, makeAppConfig };

export type { AppConfigEnv, AppConfigSecrets, AppConfigShape, GitHubOAuthConfig, RuntimeUrls };
