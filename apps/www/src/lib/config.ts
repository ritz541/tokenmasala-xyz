/**
 * Environment resolution mirrors the API's cookieScopeFor: vite dev (or a
 * *.tokenmaxxing.localhost host) means the local stack, anything else means
 * production. SSR without a window falls back to the build mode.
 */

const DEV_API_URL = "http://api.tokenmaxxing.localhost:8788";
const PROD_API_URL = "https://api.tokenmaxxing.851.sh";

function resolveApiUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.hostname.endsWith("tokenmaxxing.localhost") ? DEV_API_URL : PROD_API_URL;
  }

  return import.meta.env.DEV ? DEV_API_URL : PROD_API_URL;
}

export { resolveApiUrl };
