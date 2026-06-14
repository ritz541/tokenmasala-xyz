import { describe, expect, it } from "vitest";

import { encodeOAuthState, redirectPathFromOAuthState, sanitizeOAuthRedirectPath } from "./oauth";

describe("sanitizeOAuthRedirectPath", () => {
  it("keeps same-site paths including query strings", () => {
    expect(sanitizeOAuthRedirectPath("/cli-auth?code=ABCD-1234")).toBe("/cli-auth?code=ABCD-1234");
  });

  it("falls back for missing or external redirects", () => {
    expect(sanitizeOAuthRedirectPath(null)).toBe("/settings");
    expect(sanitizeOAuthRedirectPath("https://evil.example/cli-auth")).toBe("/settings");
    expect(sanitizeOAuthRedirectPath("//evil.example/cli-auth")).toBe("/settings");
  });
});

describe("redirectPathFromOAuthState", () => {
  it("round-trips the redirect embedded in oauth state", () => {
    const state = encodeOAuthState("nonce", "/cli-auth?code=ABCD-1234");

    expect(redirectPathFromOAuthState(state)).toBe("/cli-auth?code=ABCD-1234");
  });

  it("falls back for malformed state", () => {
    expect(redirectPathFromOAuthState("nonce")).toBe("/settings");
    expect(redirectPathFromOAuthState("nonce.not-base64-url")).toBe("/settings");
  });
});
