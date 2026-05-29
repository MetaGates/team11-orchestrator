import { statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { isSyncActive } from "../sync.js";
import { embeddingsAvailable, embeddingDimensions, EMBEDDING_MODEL } from "../embeddings.js";

/**
 * Register the health_check tool.
 * Returns database counts, sync status, embedding availability,
 * and the number of tools registered on the server.
 */
export function registerHealthTools(
  server: McpServer,
  db: Database.Database,
  toolCount: number,
): void {
  server.tool(
    "health_check",
    "Return server health: DB table counts, sync status, embedding availability, and registered tool count.",
    {},
    async () => {
      // Safe query helper — returns -1 on failure so the response degrades
      // instead of crashing the entire tool.
      const safeQuery = (): Record<string, number> | null => {
        try {
          return db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM findings) as findings,
              (SELECT COUNT(*) FROM pheromones) as pheromones,
              (SELECT COUNT(*) FROM contradictions) as contradictions,
              (SELECT COUNT(*) FROM file_summaries) as summaries,
              (SELECT COUNT(*) FROM findings WHERE superseded_by = -1) as archived
          `).get() as Record<string, number>;
        } catch {
          return null;
        }
      };

      try {
        const counts = safeQuery();

        const syncActive = isSyncActive();

        const result = {
          db: {
            findings_count: counts?.findings ?? -1,
            pheromones_count: counts?.pheromones ?? -1,
            contradictions_count: counts?.contradictions ?? -1,
            file_summaries_count: counts?.summaries ?? -1,
            archived_count: counts?.archived ?? -1,
            // statSync is intentional — entire handler uses synchronous better-sqlite3 queries
            size_bytes: (() => {
              try {
                const mainSize = statSync(db.name).size;
                let totalSize = mainSize;
                try { totalSize += statSync(db.name + '-wal').size; } catch { /* no WAL file */ }
                try { totalSize += statSync(db.name + '-shm').size; } catch { /* no SHM file */ }
                return totalSize;
              } catch { return -1; }
            })(),
          },
          sync: {
            active: syncActive,
            provider: syncActive ? ("turso" as const) : null,
          },
          embeddings: {
            available: embeddingsAvailable(),
            model: EMBEDDING_MODEL,
            dimensions: embeddingDimensions(),
          },
          tools_registered: toolCount,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "health_check_failed", details: msg }, null, 2),
            },
          ],
        };
      }
    },
  );
}
