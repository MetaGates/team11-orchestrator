import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { registerRecallTools } from "./recall.js";
import { registerStoreTools } from "./store.js";
import { registerSearchTools } from "./search.js";
import { registerPheromoneTools } from "./pheromones.js";
import { registerSyncTools } from "./sync.js";
import { registerSummaryTools } from "./summaries.js";
import { registerContradictionTools } from "./contradictions.js";
import { registerHealthTools } from "./health.js";
import { registerCoordinationTools } from "./coordination.js";

export function registerTools(
  server: McpServer,
  db: Database.Database,
  projectRoot: string,
): void {
  registerRecallTools(server, db);
  registerStoreTools(server, db);
  registerSearchTools(server, db);
  registerPheromoneTools(server, db, projectRoot);
  registerSyncTools(server, projectRoot);
  registerSummaryTools(server, db, projectRoot);
  registerContradictionTools(server, db);
  registerCoordinationTools(server, db);

  // health_check is registered last so it can report the total tool count.
  // Count: recall(2) + store(3) + search(7) + pheromones(2) + sync(2) +
  //        summaries(2) + contradictions(3) + coordination(6) + health(1) = 28
  const TOOL_COUNT = 28;
  registerHealthTools(server, db, TOOL_COUNT);
}
