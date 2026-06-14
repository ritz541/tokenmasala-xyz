import { describe, expect, it } from "vitest";

import { oauthProviderLinks } from "./oauth-providers";

describe("oauthProviderLinks", () => {
  it("builds provider links without a redirect", () => {
    const [github] = oauthProviderLinks();
    if (github === undefined) {
      throw new Error("expected GitHub provider");
    }

    expect(github.id).toBe("github");
    expect(github.label).toBe("Continue with GitHub");

    const url = new URL(github.href);
    expect(url.pathname).toBe("/auth/github/start");
    expect(url.searchParams.get("redirect")).toBeNull();
  });

  it("keeps the CLI login redirect on provider links", () => {
    const [github] = oauthProviderLinks({ redirect: "/login/cli?code=ABCD-1234" });
    if (github === undefined) {
      throw new Error("expected GitHub provider");
    }

    const url = new URL(github.href);

    expect(url.pathname).toBe("/auth/github/start");
    expect(url.searchParams.get("redirect")).toBe("/login/cli?code=ABCD-1234");
  });
});
