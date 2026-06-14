import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  cookie,
  cookieScopeFor,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
} from "../../auth/cookies";
import { generateToken } from "../../auth/crypto";
import { AuthService } from "../../auth/service";
import { AppConfig } from "../../config";
import { buildAuthorizeUrl, GitHubClient } from "../../github/client";

/**
 * Routes that cannot live in the HttpApi contract: the OAuth browser flow
 * (302 redirects + Set-Cookie). They register as raw router routes and share
 * the router's global middleware (CORS, request ids) with the contract
 * endpoints.
 */

const DEFAULT_OAUTH_REDIRECT_PATH = "/settings";

const oauthStartRoute = HttpRouter.add(
  "GET",
  "/auth/github/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* AppConfig;
    const scope = cookieScopeFor(request.headers["host"] ?? "");
    const url = new URL(request.url, "http://localhost");
    const redirectPath = sanitizeOAuthRedirectPath(url.searchParams.get("redirect"));
    const state = encodeOAuthState(generateToken(), redirectPath);

    return HttpServerResponse.empty({ status: 302 }).pipe(
      HttpServerResponse.setHeaders({
        location: buildAuthorizeUrl(
          config.github,
          `${scope.apiOrigin}/auth/github/callback`,
          state,
        ),
        "set-cookie": cookie(scope, STATE_COOKIE, state, 600),
      }),
    );
  }),
);

const oauthCallbackRoute = HttpRouter.add(
  "GET",
  "/auth/github/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = cookieScopeFor(request.headers["host"] ?? "");
    const url = new URL(request.url, "http://localhost");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = readCookie(request, STATE_COOKIE);
    if (code === null || state === null || expectedState === null || state !== expectedState) {
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "oauth_state_mismatch", message: "Sign-in expired; try again." } },
        { status: 400 },
      );
    }
    const redirectPath = redirectPathFromOAuthState(state);

    const auth = yield* AuthService;
    const github = yield* GitHubClient;
    const result = yield* Effect.gen(function* () {
      const accessToken = yield* github.exchangeCode(
        code,
        `${scope.apiOrigin}/auth/github/callback`,
      );
      const profile = yield* github.fetchUser(accessToken);
      // The GitHub access token is dropped here on purpose — identity is
      // all this product needs.
      return yield* auth.signInWithGitHub({
        avatarUrl: profile.avatarUrl,
        githubId: profile.githubId,
        login: profile.login,
        name: profile.name,
      });
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error("github oauth callback failed", String(cause).slice(0, 500));
          return Option.none<{ token: string }>();
        }),
      ),
    );

    return Option.match(result, {
      onNone: () =>
        HttpServerResponse.jsonUnsafe(
          { error: { code: "oauth_failed", message: "GitHub sign-in failed; try again." } },
          { status: 502 },
        ),
      onSome: ({ token }) =>
        HttpServerResponse.empty({ status: 302 }).pipe(
          HttpServerResponse.setHeaders({
            location: `${scope.wwwOrigin}${redirectPath}`,
            "set-cookie": cookie(scope, SESSION_COOKIE, token, 30 * 24 * 60 * 60),
          }),
        ),
    });
  }),
);

// Clears the cookie even for expired sessions, so it stays outside the
// Authorization middleware.
const signoutRoute = HttpRouter.add(
  "POST",
  "/auth/signout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = cookieScopeFor(request.headers["host"] ?? "");
    const token = sessionTokenFrom(request);
    if (token !== null) {
      const auth = yield* AuthService;
      yield* auth.signOut(token).pipe(Effect.ignore);
    }

    return HttpServerResponse.jsonUnsafe({ ok: true }).pipe(
      HttpServerResponse.setHeader("set-cookie", cookie(scope, SESSION_COOKIE, "", 0)),
    );
  }),
);

const oauthRoutesLayer = Layer.mergeAll(oauthStartRoute, oauthCallbackRoute, signoutRoute);

function sanitizeOAuthRedirectPath(value: string | null): string {
  if (value === null) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  try {
    const url = new URL(trimmed, "https://tokenmaxxing.invalid");
    if (url.origin !== "https://tokenmaxxing.invalid") {
      return DEFAULT_OAUTH_REDIRECT_PATH;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }
}

function encodeOAuthState(nonce: string, redirectPath: string): string {
  return `${nonce}.${base64UrlEncode(redirectPath)}`;
}

function redirectPathFromOAuthState(state: string): string {
  const encodedRedirect = state.split(".", 2)[1];
  if (encodedRedirect === undefined || encodedRedirect.length === 0) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  const redirectPath = base64UrlDecode(encodedRedirect);
  if (redirectPath === null) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  return sanitizeOAuthRedirectPath(redirectPath);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export {
  encodeOAuthState,
  oauthRoutesLayer,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
};
