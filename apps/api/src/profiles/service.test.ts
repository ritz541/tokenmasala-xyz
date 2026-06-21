import { describe, expect, it } from "vitest";

import { profileDailyRange } from "./service";

describe("profileDailyRange", () => {
  const now = new Date("2026-06-21T23:30:00.000Z");

  it("defaults profile charts to 2026 year-to-date in UTC", () => {
    expect(profileDailyRange({}, now)).toEqual({
      first: "2026-01-01",
      last: "2026-06-21",
    });
  });

  it("uses explicit query bounds as the response chart range", () => {
    expect(
      profileDailyRange(
        {
          since: "2026-06-20",
          until: "2026-06-22",
        },
        now,
      ),
    ).toEqual({
      first: "2026-06-20",
      last: "2026-06-22",
    });
  });
});
