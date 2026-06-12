import { defineConfig } from "drizzle-kit";

const config = defineConfig({
  dialect: "sqlite",
  out: "./migrations",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});

export default config;
