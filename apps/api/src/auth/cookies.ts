import type { HttpServerRequest } from "effect/unstable/http";

/**
 * Session/state cookie plumbing for the browser auth flow. Cookie attributes
 * derive from the request host, so one deploy serves dev
 * (api.tokenmasala.localhost, http) and prod (api.tokenmasala.xyz,
 * https) without environment plumbing.
 */

const SESSION_COOKIE = "tmx_session";
const STATE_COOKIE = "tmx_oauth_state";

interface CookieScope {
  apiOrigin: string;
  domain: string;
  secure: boolean;
  wwwOrigin: string;
}

function cookieScopeFor(host: string): CookieScope {
  const hostname = host.split(":")[0] ?? host;
  // The local dev provider proxies with a rewritten Host (127.0.0.1:port),
  // so any loopback-ish host means dev; origins are fixed per environment.
  const isDev =
    hostname.endsWith(".tokenmasala.localhost") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (isDev) {
    return {
      apiOrigin: "http://api.tokenmasala.localhost:8788",
      domain: ".tokenmasala.localhost",
      secure: false,
      wwwOrigin: "http://tokenmasala.localhost:3002",
    };
  }

  return {
    apiOrigin: "https://api.tokenmasala.xyz",
    domain: ".tokenmasala.xyz",
    secure: true,
    wwwOrigin: "https://tokenmasala.xyz",
  };
}

function cookie(scope: CookieScope, name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${value}`,
    `Domain=${scope.domain}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (scope.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function readCookie(request: HttpServerRequest.HttpServerRequest, name: string): string | null {
  return request.cookies[name] ?? null;
}

/** Bearer header (non-browser clients) or the session cookie. */
function sessionTokenFrom(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers["authorization"];
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return readCookie(request, SESSION_COOKIE);
}

export { cookie, cookieScopeFor, readCookie, SESSION_COOKIE, sessionTokenFrom, STATE_COOKIE };
