import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.AGENTMELD_DB_PATH ?? "./.agentmeld-data/agentmeld.db"
  }
});
