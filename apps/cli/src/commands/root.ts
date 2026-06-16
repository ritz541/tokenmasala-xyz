import { Command } from "effect/unstable/cli";

import packageJson from "../../package.json";
import { verboseGlobalFlag } from "../errors";
import { loginCommand } from "./login";
import { logoutCommand } from "./logout";
import { serviceCommand } from "./service";
import { syncCommand } from "./sync";
import { whoamiCommand } from "./whoami";

const tokenmaxxingCommand = Command.make("tokenmaxxing").pipe(
  Command.withDescription("Sync your LLM token usage to the tokenmaxxing leaderboard"),
  Command.withGlobalFlags([verboseGlobalFlag]),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    whoamiCommand,
    syncCommand,
    serviceCommand,
  ]),
);

const runTokenmaxxingCommand = Command.runWith(tokenmaxxingCommand, {
  version: packageJson.version,
});

export { runTokenmaxxingCommand, tokenmaxxingCommand };
