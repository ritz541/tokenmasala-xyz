import { Layer } from "effect";

import { ApiClientLive } from "./api-client";
import { BrowserLive } from "./browser";
import { ClockLive } from "./clock";
import { ConfigLive } from "./config";
import { ConsoleLive } from "./console";
import { TerminalLive } from "./terminal";

export { ApiClientLive, ApiClientService, type TokenmaxxingApiClient } from "./api-client";
export { BrowserLive, BrowserService } from "./browser";
export { ClockLive, ClockService } from "./clock";
export {
  ConfigLive,
  ConfigReadError,
  ConfigService,
  ConfigWriteError,
  type CliConfig,
  type ConfigError,
} from "./config";
export { ConsoleLive, ConsoleService } from "./console";
export { TerminalLive, TerminalService } from "./terminal";

const CliServicesLive = Layer.mergeAll(
  ApiClientLive,
  BrowserLive,
  ClockLive,
  ConfigLive,
  ConsoleLive,
  TerminalLive,
);

export { CliServicesLive };
