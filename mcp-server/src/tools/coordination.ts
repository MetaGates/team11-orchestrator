import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { forceSync, isSyncActive } from "../sync.js";

export function registerCoordinationTools(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    "claim_file",
    "Claim a file for editing. Returns conflict info if already claimed by another pair.",
    {
      operator: z.string().describe("Operator name (e.g., CyberStein)"),
      pair_id: z.string().describe("Pair ID (e.g., cs-pair-1)"),
      file_path: z.string().describe("File path to claim"),
      action: z.string().optional().describe("What the pair intends to do with the file"),
    },
    async ({ operator, pair_id, file_path, action }) => {
      const existing = db.prepare(`
        SELECT id, operator, pair_id, action, status, claimed_at
        FROM active_edits
        WHERE file_path = ? AND released_at IS NULL
      `).get(file_path) as { id: number; operator: string; pair_id: string; action: string | null; status: string; claimed_at: string } | undefined;

      if (existing && existing.pair_id !== pair_id) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              claimed: false,
              held_by: existing.pair_id,
              held_by_operator: existing.operator,
              action: existing.action,
              since: existing.claimed_at,
            }),
          }],
        };
      }

      if (existing && existing.pair_id === pair_id) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              claimed: true,
              id: existing.id,
              note: "Already claimed by this pair",
            }),
          }],
        };
      }

      const result = db.prepare(`
        INSERT INTO active_edits (operator, pair_id, file_path, action)
        VALUES (?, ?, ?, ?)
      `).run(operator, pair_id, file_path, action ?? null);

      if (isSyncActive()) await forceSync();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ claimed: true, id: result.lastInsertRowid }),
        }],
      };
    },
  );

  server.tool(
    "release_file",
    "Release all file claims for a pair (typically after merge).",
    {
      pair_id: z.string().describe("Pair ID whose claims to release"),
    },
    async ({ pair_id }) => {
      const result = db.prepare(`
        UPDATE active_edits
        SET released_at = datetime('now'), status = 'merged'
        WHERE pair_id = ? AND released_at IS NULL
      `).run(pair_id);

      if (isSyncActive()) await forceSync();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ released: true, files_released: result.changes }),
        }],
      };
    },
  );

  server.tool(
    "list_active_edits",
    "List all currently claimed files, optionally filtered by operator.",
    {
      operator: z.string().optional().describe("Filter by operator name"),
    },
    async ({ operator }) => {
      const results = operator
        ? db.prepare(`SELECT * FROM active_edits WHERE released_at IS NULL AND operator = ? ORDER BY claimed_at DESC`).all(operator)
        : db.prepare(`SELECT * FROM active_edits WHERE released_at IS NULL ORDER BY claimed_at DESC`).all();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ active_edits: results, count: results.length }),
        }],
      };
    },
  );

  server.tool(
    "register_operator",
    "Register a new Team11 operator or update an existing one.",
    {
      name: z.string().describe("Operator name"),
      github: z.string().optional().describe("GitHub username"),
      prefix: z.string().describe("Short prefix for pair IDs (e.g., cs)"),
      pairs: z.string().optional().describe("JSON array of pair numbers (default: [1,2,3,4,5])"),
    },
    async ({ name, github, prefix, pairs }) => {
      db.prepare(`
        INSERT INTO operators (name, github, prefix, pairs)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          github = excluded.github,
          prefix = excluded.prefix,
          pairs = excluded.pairs,
          last_active = datetime('now')
      `).run(name, github ?? null, prefix, pairs ?? "[1,2,3,4,5]");

      if (isSyncActive()) await forceSync();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ registered: true, name, prefix }),
        }],
      };
    },
  );

  server.tool(
    "list_operators",
    "List all registered Team11 operators.",
    {},
    async () => {
      const results = db.prepare(`SELECT * FROM operators ORDER BY last_active DESC`).all();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ operators: results, count: results.length }),
        }],
      };
    },
  );

  server.tool(
    "heartbeat_operator",
    "Update an operator's last_active timestamp.",
    {
      name: z.string().describe("Operator name"),
    },
    async ({ name }) => {
      const result = db.prepare(`
        UPDATE operators SET last_active = datetime('now') WHERE name = ?
      `).run(name);

      if (isSyncActive()) await forceSync();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            updated: result.changes > 0,
            name,
            note: result.changes === 0 ? "Operator not found" : undefined,
          }),
        }],
      };
    },
  );
}
