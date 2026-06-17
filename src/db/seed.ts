import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";

ensureDatabase();

const agents = getDatabase().prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number };
const conversations = getDatabase().prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number };
const workspaces = getDatabase().prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number };

console.info(
  `Seed complete: agents=${agents.count} conversations=${conversations.count} workspaces=${workspaces.count}`
);
