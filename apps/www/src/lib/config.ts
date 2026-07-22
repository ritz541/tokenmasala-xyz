/**
 * Environment resolution mirrors the API's cookieScopeFor: vite dev (or a
 * *.tokenmasala.localhost host) means the local stack, anything else means
 * production.
 */

const DEV_API_URL = "http://api.tokenmasala.localhost:8788";
const PROD_API_URL = "https://api.tokenmasala.xyz";

function resolveApiUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.hostname.endsWith("tokenmasala.localhost") ? DEV_API_URL : PROD_API_URL;
  }

  return import.meta.env.DEV ? DEV_API_URL : PROD_API_URL;
}

export { resolveApiUrl };
