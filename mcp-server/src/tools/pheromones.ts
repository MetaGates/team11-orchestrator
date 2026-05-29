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
        results = db
          .prepare(
            `SELECT * FROM pheromones WHERE task LIKE ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(`%${task_keywords}%`, limit);
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

function safeJsonParse(str: string | null, fallback: any): any {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
