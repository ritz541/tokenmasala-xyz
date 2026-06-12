import { localState, Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Database } from "./apps/api/src/cloudflare/database";
import ApiWorker from "./apps/api/src/worker";

const stack = Stack(
  "tokenmaxxing",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const api = yield* ApiWorker;
    const db = yield* Database;

    const www = yield* Cloudflare.Vite("www", {
      name: "tokenmaxxing-www",
      rootDir: "./apps/www",
      url: false,
      compatibility: {
        date: "2026-06-02",
        flags: ["nodejs_compat"],
      },
      domain: "tokenmaxxing.851.sh",
      observability: {
        enabled: true,
      },
      dev: {
        host: "tokenmaxxing.localhost",
        port: 3002,
        strictPort: true,
      },
    });

    return {
      api,
      db,
      www,
    };
  }),
);

export default stack;
