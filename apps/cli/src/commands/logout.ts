import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ApiClientService, ConfigService, ConsoleService } from "../services";

const logoutCommand = Command.make(
  "logout",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => logoutEffect({ json }),
).pipe(Command.withDescription("Log out and revoke this device's CLI token"));

function logoutEffect(options: { json: boolean }) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);
    const console = yield* Effect.service(ConsoleService);

    const stored = yield* config.readConfig();
    const cleared = yield* config.clearToken();

    // Best-effort server-side revocation; local logout must succeed even
    // when the API is unreachable.
    if (cleared.token !== undefined) {
      const client = yield* clients.make({ baseUrl: stored.apiUrl, token: cleared.token });
      yield* client.usage.logout().pipe(Effect.ignore);
    }

    yield* Effect.sync(() => {
      if (options.json) {
        console.log(JSON.stringify({ status: "ok", tokenCleared: cleared.tokenCleared }));
      } else if (cleared.tokenCleared) {
        console.log("Logged out; the token was revoked.");
      } else {
        console.log("Not logged in; nothing to do.");
      }
    });
  });
}

export { logoutCommand, logoutEffect };
