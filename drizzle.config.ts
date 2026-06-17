import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.AGENT_CONFERENCE_DB_PATH ?? "./.agent-conference-data/agent-conference.db"
  }
});
