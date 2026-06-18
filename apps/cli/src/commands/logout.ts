import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ApiClientService, ConfigService } from "../services";
import { humanFrame, humanLog, writeJson } from "../output";

const logoutCommand = Command.make(
  "logout",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => logoutEffect({ json }),
).pipe(Command.withDescription("Log out and revoke this device's CLI token"));

function logoutEffect(options: { json: boolean }) {
  return humanFrame(
    "Logout",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const clients = yield* Effect.service(ApiClientService);

      const stored = yield* config.readConfig();
      const cleared = yield* config.clearToken();

      // Best-effort server-side revocation; local logout must succeed even
      // when the API is unreachable.
      if (cleared.token !== undefined) {
        const client = yield* clients.make({ baseUrl: stored.apiUrl, token: cleared.token });
        yield* client.usage.logout().pipe(Effect.ignore);
      }

      if (options.json) {
        yield* writeJson({ status: "ok", tokenCleared: cleared.tokenCleared });
      } else if (cleared.tokenCleared) {
        yield* humanLog("success", "Logged out; the token was revoked", options);
      } else {
        yield* humanLog("info", "Not logged in; nothing to do", options);
      }
    }),
  );
}

export { logoutCommand, logoutEffect };
