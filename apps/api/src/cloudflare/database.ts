import * as Cloudflare from "alchemy/Cloudflare";

const Database = Cloudflare.D1Database("DB", {
  name: "tokenmaxxing",
  migrationsDir: "./packages/db/migrations",
});

export { Database };
