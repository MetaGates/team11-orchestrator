import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { forceSync, isSyncActive } from "../sync.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerPheromoneTools(
  server: McpServer,
  db: Database.Database,
  projectRoot: string,
): void {
  server.tool(
    "store_pheromone",
    "Store a pheromone trail after completing a task. Helps future agents estimate difficulty and avoid gotchas.",
    {
      task: z.string().describe("Task description"),
      pair: z.string().optional(),
      difficulty: z.enum(["LOW", "MEDIUM", "HIGH"]),
      files_touched: z
        .array(z.string())
        .describe("List of files modified"),
      gotchas: z
        .array(z.string())
        .optional()
        .describe("Non-obvious issues encountered"),
      duration_minutes: z.number().optional(),
      estimated_duration_minutes: z.number().optional().describe("Estimated duration before starting"),
      rounds: z
        .number()
        .optional()
        .describe("Number of code-audit rounds"),
      findings_count: z.number().optional(),
      verdict_breakdown: z.object({
        confirmed: z.number(),
        disputed: z.number(),
        deferred: z.number(),
      }).optional().describe("Verdict counts from audit"),
    },
    async ({
      task,
      pair,
      difficulty,
      files_touched,
      gotchas,
      duration_minutes,
      estimated_duration_minutes,
      rounds,
      findings_count,
      verdict_breakdown,
    }) => {
      const result = db
        .prepare(
          `
        INSERT INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, estimated_duration_minutes, rounds, findings_count, verdict_breakdown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          task,
          pair ?? null,
          difficulty,
          JSON.stringify(files_touched),
          JSON.stringify(gotchas ?? []),
          duration_minutes ?? null,
          estimated_duration_minutes ?? null,
          rounds ?? null,
          findings_count ?? null,
          verdict_breakdown ? JSON.stringify(verdict_breakdown) : null,
        );

      // Dual-write to pheromones.json
      const pheromonePath = join(projectRoot, ".team11", "pheromones.json");
      try {
        const existing = existsSync(pheromonePath)
          ? JSON.parse(readFileSync(pheromonePath, "utf8"))
          : { trails: [] };
        existing.trails.push({
          date: new Date().toISOString().split("T")[0],
          pair: pair ?? null,
          task,
          difficulty,
          files: files_touched,
          gotchas: gotchas ?? [],
          estimated_duration_min: estimated_duration_minutes ?? null,
          actual_duration_min: duration_minutes ?? null,
          rounds: rounds ?? null,
          findings_count: findings_count ?? null,
          verdict_breakdown: verdict_breakdown ?? null,
        });
        writeFileSync(pheromonePath, JSON.stringify(existing, null, 2));
      } catch (err) {
        console.error("[team11-memory] Warning: Failed to write pheromones.json:", err);
      }

      if (isSyncActive()) await forceSync();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: result.lastInsertRowid,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "get_pheromones",
    "Get pheromone trail data for files or tasks. Shows what happened last time someone worked on these files.",
    {
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to check pheromone data for"),
      task_keywords: z
        .string()
        .optional()
        .describe("Keywords to search pheromone tasks"),
      limit: z.number().optional().default(10),
    },
    async ({ files, task_keywords, limit }) => {
      let results: any[] = [];

      if (files && files.length > 0) {
        const placeholders = files
          .map(() => `files_touched LIKE ?`)
          .join(" OR ");
        const params = files.map((f) => `%${f}%`);
        results = db
          .prepare(
            `SELECT * FROM pheromones WHERE ${placeholders} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...params, limit);
      } else if (task_keywords) {
        // Tokenised OR-search (2026-08-24, audit finding A2.9): the previous
        // single `task LIKE '%<whole phrase>%'` returned 0 rows for ANY multi-
        // word query — which is exactly what the CEO's mandatory Step-1 call
        // sends. Split on whitespace, drop tokens <3 chars, OR the rest, rank
        // by how many tokens hit, then by recency. A query that leaves no
        // usable token falls back to the whole-phrase LIKE (old behaviour).
        const tokens = tokenizeTaskKeywords(task_keywords);
        if (tokens.length === 0) {
          results = db
            .prepare(
              `SELECT * FROM pheromones WHERE task LIKE ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(`%${task_keywords}%`, limit);
        } else {
          const patterns = tokens.map((t) => `%${escapeLike(t)}%`);
          const hit = `(CASE WHEN task LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`;
          const where = patterns.map(() => `task LIKE ? ESCAPE '\\'`).join(" OR ");
          results = db
            .prepare(
              `SELECT *, (${patterns.map(() => hit).join(" + ")}) AS match_count
                 FROM pheromones
                WHERE ${where}
                ORDER BY match_count DESC, created_at DESC
                LIMIT ?`,
            )
            .all(...patterns, ...patterns, limit);
        }
      } else {
        results = db
          .prepare(
            `SELECT * FROM pheromones ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit);
      }

      const parsed = results.map((r: any) => ({
        ...r,
        files_touched: safeJsonParse(r.files_touched, []),
        gotchas: safeJsonParse(r.gotchas, []),
        verdict_breakdown: safeJsonParse(r.verdict_breakdown, null),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pheromones: parsed,
              count: parsed.length,
            }),
          },
        ],
      };
    },
  );
}

/**
 * Whitespace tokens with edge punctuation stripped, tokens shorter than 3
 * chars dropped, deduped case-insensitively (SQLite LIKE is already ASCII
 * case-insensitive, so the original casing is kept for the pattern).
 */
function tokenizeTaskKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/^["'`(),;:]+|["'`(),;:]+$/g, "");
    if (t.length < 3) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Escape LIKE metacharacters so a token containing `%` or `_` matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function safeJsonParse(str: string | null, fallback: any): any {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
