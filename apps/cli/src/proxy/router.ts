/**
 * Request routing for the proxy. The local proxy listens on a single port and
 * forwards every request to the real upstream API. We infer the upstream base
 * URL and the provider family from three signals, in priority order:
 *
 *   1. `X-TM-Upstream` request header (set by the user's harness config or a
 *      shell wrapper) — explicit override, always wins.
 *   2. The request path: `/v1/...` → OpenAI-compatible, `/v1/messages` or
 *      `/v1/complete` → Anthropic, `/openai/...` → OpenAI, `/anthropic/...`
 *      → Anthropic. This lets a friend point one base URL at the proxy and
 *      still hit both providers.
 *   3. Environment variables: `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` if set.
 *
 * The resolved {@link ProxyTarget} is also used by the usage mapper to pick
 * the default `source` label (`openai` vs `anthropic`) before any explicit
 * `--label` override is applied.
 */

import type { IncomingHttpHeaders } from "node:http";

type ProviderFamily = "anthropic" | "google" | "openai";

interface ProxyTarget {
  /** Provider family inferred from the request, used for default source. */
  readonly family: ProviderFamily;
  /** The absolute upstream base URL to forward to (no trailing slash). */
  readonly upstreamBaseUrl: string;
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
const DEFAULT_GOOGLE_BASE = "https://generativelanguage.googleapis.com";

function resolveTarget(input: {
  readonly env: Record<string, string | undefined>;
  readonly headers: Headers;
  readonly pathname: string;
}): ProxyTarget {
  const upstreamHeader = headerValue(input.headers, "x-tm-upstream");
  if (upstreamHeader !== undefined && upstreamHeader.trim() !== "") {
    const family = familyForUrl(upstreamHeader) ?? "openai";
    return { family, upstreamBaseUrl: stripTrailingSlash(upstreamHeader) };
  }

  const pathname = input.pathname.toLowerCase();

  // Explicit provider path prefixes.
  if (pathname.startsWith("/anthropic")) {
    return { family: "anthropic", upstreamBaseUrl: resolveAnthropicBase(input.env) };
  }
  if (pathname.startsWith("/openai")) {
    return { family: "openai", upstreamBaseUrl: resolveOpenaiBase(input.env) };
  }
  if (pathname.startsWith("/google") || pathname.startsWith("/v1beta")) {
    return { family: "google", upstreamBaseUrl: resolveGoogleBase(input.env) };
  }

  // Standard OpenAI-style `/v1/...` paths.
  if (pathname.startsWith("/v1/")) {
    if (pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")) {
      return { family: "anthropic", upstreamBaseUrl: resolveAnthropicBase(input.env) };
    }
    if (pathname.startsWith("/v1/complete")) {
      return { family: "anthropic", upstreamBaseUrl: resolveAnthropicBase(input.env) };
    }
    return { family: "openai", upstreamBaseUrl: resolveOpenaiBase(input.env) };
  }

  // Fall back to the OpenAI env base (most harnesses default to OpenAI-style).
  return { family: "openai", upstreamBaseUrl: resolveOpenaiBase(input.env) };
}

function resolveOpenaiBase(env: Record<string, string | undefined>): string {
  return stripTrailingSlash(env["OPENAI_BASE_URL"] ?? env["OPENAI_API_BASE"] ?? DEFAULT_OPENAI_BASE);
}

function resolveAnthropicBase(env: Record<string, string | undefined>): string {
  return stripTrailingSlash(env["ANTHROPIC_BASE_URL"] ?? DEFAULT_ANTHROPIC_BASE);
}

function resolveGoogleBase(env: Record<string, string | undefined>): string {
  return stripTrailingSlash(env["GOOGLE_BASE_URL"] ?? DEFAULT_GOOGLE_BASE);
}

function familyForUrl(url: string): ProviderFamily | undefined {
  const lower = url.toLowerCase();
  if (lower.includes("anthropic")) {
    return "anthropic";
  }
  if (lower.includes("generativelanguage") || lower.includes("googleapis")) {
    return "google";
  }
  if (lower.includes("openai")) {
    return "openai";
  }

  return undefined;
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null ? undefined : value;
}

function incomingHeadersToWeb(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, String(item));
      }
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export { familyForUrl, incomingHeadersToWeb, resolveTarget };
export type { ProviderFamily, ProxyTarget };
