import { describe, expect, it } from "vitest";
import { parseGitLogOutput } from "./collector";

describe("parseGitLogOutput", () => {
  it("returns empty array for empty git output", () => {
    expect(parseGitLogOutput("")).toEqual([]);
    expect(parseGitLogOutput("   \n  ")).toEqual([]);
  });

  it("parses numstat lines and groups activity by local date", () => {
    const gitLogOutput = `
commit 1a2b3c4d
author-date:2026-07-23T10:15:30+05:30
10\t2\tsrc/index.ts
5\t0\tREADME.md

commit 5e6f7g8h
author-date:2026-07-23T14:20:00+05:30
15\t5\tsrc/app.ts

commit 9i0j1k2l
author-date:2026-07-22T18:00:00+05:30
3\t1\tpackage.json
`;

    const days = parseGitLogOutput(gitLogOutput);

    expect(days).toEqual([
      {
        additions: 3,
        commitCount: 1,
        date: "2026-07-22",
        deletions: 1,
        prCount: 0,
        pushCount: 1,
      },
      {
        additions: 30,
        commitCount: 2,
        date: "2026-07-23",
        deletions: 7,
        prCount: 0,
        pushCount: 2,
      },
    ]);
  });
});
