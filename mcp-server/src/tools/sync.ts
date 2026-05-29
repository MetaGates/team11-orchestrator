import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadSyncConfig,
  forceSync,
  isSyncActive,
} from "../sync.js";

export function registerSyncTools(
  server: McpServer,
  projectRoot: string,
): void {
  server.tool(
    "sync_status",
    "Check the status of Turso sync. Returns whether sync is active and connection details.",
    {},
    async () => {
      const config = loadSyncConfig(projectRoot);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              sync_enabled: isSyncActive(),
              provider: config?.provider || "none",
              url: config?.url || "local-only",
              interval_seconds: config?.syncInterval || 60,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "force_sync",
    "Force an immediate sync with the Turso cloud. Use after batch operations.",
    {},
    async () => {
      if (!isSyncActive()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "Sync not active. Configure sync in .team11/config.json",
              }),
            },
          ],
        };
      }
      await forceSync();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ synced: true }),
          },
        ],
      };
    },
  );
}
