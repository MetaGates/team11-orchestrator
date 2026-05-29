import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { forceSync, isSyncActive } from "../sync.js";

export function registerContradictionTools(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    "store_contradiction",
    "Store a contradiction between two claims discovered by agents.",
    {
      claim_a: z.string().describe("First claim"),
      source_a: z.string().describe("Source of first claim (e.g., Pair 1, F001)"),
      claim_b: z.string().describe("Contradicting claim"),
      source_b: z.string().describe("Source of contradicting claim"),
      resolution: z.string().optional().describe("How it was resolved, if known"),
      status: z.enum(["OPEN", "RESOLVED", "DEFERRED"]).optional().default("OPEN"),
    },
    async ({ claim_a, source_a, claim_b, source_b, resolution, status }) => {
      const result = db.prepare(`
        INSERT INTO contradictions (claim_a, source_a, claim_b, source_b, resolution, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(claim_a, source_a, claim_b, source_b, resolution ?? null, status);
      if (isSyncActive()) await forceSync();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ stored: true, id: result.lastInsertRowid, status }),
        }],
      };
    },
  );

  server.tool(
    "resolve_contradiction",
    "Resolve a previously stored contradiction.",
    {
      id: z.number().describe("Contradiction ID"),
      resolution: z.string().describe("How it was resolved"),
      status: z.enum(["RESOLVED", "DEFERRED"]).default("RESOLVED"),
    },
    async ({ id, resolution, status }) => {
      db.prepare(`
        UPDATE contradictions SET resolution = ?, status = ?, resolved_at = datetime('now') WHERE id = ?
      `).run(resolution, status, id);
      if (isSyncActive()) await forceSync();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ updated: true, id, status }) }],
      };
    },
  );

  server.tool(
    "list_contradictions",
    "List contradictions, optionally filtered by status.",
    {
      status: z.enum(["OPEN", "RESOLVED", "DEFERRED", "ALL"]).optional().default("OPEN"),
      limit: z.number().optional().default(20),
    },
    async ({ status, limit }) => {
      const results = status === "ALL"
        ? db.prepare(`SELECT * FROM contradictions ORDER BY created_at DESC LIMIT ?`).all(limit)
        : db.prepare(`SELECT * FROM contradictions WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ contradictions: results, count: results.length }) }],
      };
    },
  );
}
