#!/usr/bin/env node

import { runCliMain } from "./entrypoint";

// This file is the CLI entrypoint only. Run unconditionally so Bun standalone
// builds do not depend on platform-specific import.meta.main behavior.
runCliMain();
