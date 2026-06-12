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

    return {
      api,
      db,
    };
  }),
);

export default stack;
