import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { extractKeywords, buildFtsQuery } from "../tokenize.js";
import { runDecay, reinforce, restore, touchManyOnRead } from "../decay.js";

export function registerSearchTools(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    "search_memory",
    "Search Team11's persistent memory with a free-text query. Returns matching entries ranked by relevance.",
    {
      query: z
        .string()
        .describe(
          "Free-text search query. Keywords are extracted (stopwords removed, " +
            "identifiers/paths split into tokens) and matched as OR-of-keywords — " +
            "any matching keyword returns the entry, ranked by BM25 relevance. " +
            "Boolean/phrase/prefix operators are NOT honored.",
        ),
      type_filter: z
        .enum([
          "finding",
          "decision",
          "gotcha",
          "fact",
          "architecture",
          "all",
        ])
        .optional()
        .default("all"),
      limit: z.number().optional().default(20),
    },
    async ({ query, type_filter, limit }) => {
      const keywords = extractKeywords(query);
      if (keywords.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results: [], count: 0 }),
            },
          ],
        };
      }

      const ftsQuery = buildFtsQuery(keywords);
      // Exclude archived (superseded_by = -1) AND consolidate merge-losers
      // (superseded_by = positive keeper id). Mirrors recall.ts:58 — the single
      // active predicate every other tool uses. Without it, archived rows are
      // returned AND the touchManyOnRead below would reset their decay timer,
      // un-archiving them.
      let sql = `
        SELECT f.*, bm25(findings_fts, 10.0, 1.0, 2.0) as relevance
        FROM findings_fts fts
        JOIN findings f ON f.id = fts.rowid
        WHERE findings_fts MATCH ?
          AND (f.superseded_by IS NULL OR f.superseded_by = 0)
      `;
      const params: any[] = [ftsQuery];

      if (type_filter && type_filter !== "all") {
        sql += ` AND f.type = ?`;
        params.push(type_filter);
      }

      sql += ` ORDER BY relevance LIMIT ?`;
      params.push(limit);

      const results = db.prepare(sql).all(...params) as Array<{ id: number }>;

      // Usage-weighted decay: touching returned entries bumps last_reinforced
      // so they re-enter the 14-day grace period (see decay.ts). Safe to touch
      // all results — the query above already excludes archived/superseded rows.
      touchManyOnRead(db, results.map((r) => r.id));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, count: results.length }),
          },
        ],
      };
    },
  );

  server.tool(
    "list_recent",
    "List the most recent memory entries, optionally filtered by type.",
    {
      type_filter: z
        .enum([
          "finding",
          "decision",
          "gotcha",
          "fact",
          "architecture",
          "all",
        ])
        .optional()
        .default("all"),
      limit: z.number().optional().default(20),
      days: z
        .number()
        .optional()
        .default(30)
        .describe("Only show entries from the last N days"),
      include_archived: z.boolean().optional().default(false),
    },
    async ({ type_filter, limit, days, include_archived }) => {
      let sql = `SELECT * FROM findings WHERE created_at >= datetime('now', ?)`;
      const params: any[] = [`-${days} days`];

      // Exclude archived/superseded by default, consistent with list_stale.
      if (!include_archived) {
        sql += ` AND (superseded_by IS NULL OR superseded_by = 0)`;
      }

      if (type_filter && type_filter !== "all") {
        sql += ` AND type = ?`;
        params.push(type_filter);
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const results = db.prepare(sql).all(...params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, count: results.length }),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_stats",
    "Show statistics about Team11's persistent memory database.",
    {},
    async () => {
      // Active corpus only — exclude archived (superseded_by = -1) and
      // consolidate merge-losers (positive keeper id). Counting them overstates
      // the live corpus and disagrees with health_check. The separate `archived`
      // count below preserves visibility (consistent with health_check).
      const ACTIVE = `(superseded_by IS NULL OR superseded_by = 0)`;
      const stats = {
        total: db
          .prepare(`SELECT COUNT(*) as count FROM findings WHERE ${ACTIVE}`)
          .get(),
        archived: db
          .prepare(
            `SELECT COUNT(*) as count FROM findings WHERE superseded_by IS NOT NULL AND superseded_by != 0`,
          )
          .get(),
        by_type: db
          .prepare(
            `SELECT type, COUNT(*) as count FROM findings WHERE ${ACTIVE} GROUP BY type`,
          )
          .all(),
        by_confidence: db
          .prepare(
            `SELECT confidence, COUNT(*) as count FROM findings WHERE ${ACTIVE} GROUP BY confidence`,
          )
          .all(),
        recent_7d: db
          .prepare(
            `SELECT COUNT(*) as count FROM findings WHERE created_at >= datetime('now', '-7 days') AND ${ACTIVE}`,
          )
          .get(),
        pheromones: db
          .prepare(`SELECT COUNT(*) as count FROM pheromones`)
          .get(),
        oldest: db
          .prepare(
            `SELECT created_at FROM findings WHERE ${ACTIVE} ORDER BY created_at ASC LIMIT 1`,
          )
          .get(),
        newest: db
          .prepare(
            `SELECT created_at FROM findings WHERE ${ACTIVE} ORDER BY created_at DESC LIMIT 1`,
          )
          .get(),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
        ],
      };
    },
  );

  // -- Confidence decay tools --

  server.tool(
    "run_decay",
    "Run confidence decay across all memory entries. Updates scores based on time since last reinforcement. Flags stale entries (<50%) and archives very stale ones (<25%).",
    {},
    async () => {
      const result = runDecay(db);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "reinforce_finding",
    "Reinforce a finding — reset its confidence decay timer. Use when an agent re-confirms a fact is still true.",
    {
      id: z.number().describe("Finding ID to reinforce"),
    },
    async ({ id }) => {
      reinforce(db, id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ reinforced: true, id }),
          },
        ],
      };
    },
  );

  server.tool(
    "restore_finding",
    "Restore an archived finding. Un-archives it and resets confidence to 1.0.",
    {
      id: z.number().describe("Finding ID to restore"),
    },
    async ({ id }) => {
      restore(db, id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ restored: true, id }),
          },
        ],
      };
    },
  );

  server.tool(
    "list_stale",
    "List findings with low confidence scores that may need re-verification or archival.",
    {
      threshold: z
        .number()
        .optional()
        .default(0.5)
        .describe("Confidence threshold (default 0.5)"),
      include_archived: z.boolean().optional().default(false),
    },
    async ({ threshold, include_archived }) => {
      let sql = `SELECT id, title, type, confidence_score, last_reinforced, created_at FROM findings WHERE confidence_score < ?`;
      if (!include_archived) {
        sql += ` AND (superseded_by IS NULL OR superseded_by = 0)`;
      }
      sql += ` ORDER BY confidence_score ASC`;

      const results = db.prepare(sql).all(threshold);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { stale: results, count: results.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
