import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { computeCompositeScore, estimateTokens } from "../scoring.js";
import { extractKeywords, buildFtsQuery } from "../tokenize.js";
import { embed, embeddingsAvailable } from "../embeddings.js";

export function registerRecallTools(
  server: McpServer,
  db: Database.Database,
): void {
  // recall_context — primary retrieval tool
  server.tool(
    "recall_context",
    "Retrieve relevant context for a task from Team11's persistent memory. Returns findings, decisions, gotchas, and pheromone data ranked by relevance.",
    {
      task_description: z
        .string()
        .describe("Natural language description of the task"),
      max_tokens: z
        .number()
        .optional()
        .default(8000)
        .describe("Maximum tokens in response"),
    },
    async ({ task_description, max_tokens }) => {
      const keywords = extractKeywords(task_description);
      if (keywords.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                query: task_description,
                results_count: 0,
                findings: [],
                decisions: [],
                gotchas: [],
                facts: [],
                pheromones: [],
              }),
            },
          ],
        };
      }

      const ftsQuery = buildFtsQuery(keywords);

      // FTS5 search with BM25 scoring — weights: title(10), content(1), tags(2)
      // Excludes archived entries (superseded_by = -1 is the archive marker)
      const ftsResults = db
        .prepare(
          `
        SELECT f.*, bm25(findings_fts, 10.0, 1.0, 2.0) as bm25_score
        FROM findings_fts fts
        JOIN findings f ON f.id = fts.rowid
        WHERE findings_fts MATCH ?
          AND (f.superseded_by IS NULL OR f.superseded_by = 0)
        ORDER BY bm25(findings_fts, 10.0, 1.0, 2.0)
        LIMIT 50
      `,
        )
        .all(ftsQuery);

      // Vector search (if embeddings are available)
      let vectorResults: any[] = [];
      if (embeddingsAvailable()) {
        const queryVector = await embed(task_description);
        if (queryVector) {
          const vectorBlob = Buffer.from(queryVector.buffer);
          vectorResults = db
            .prepare(
              `
            SELECT f.*, v.distance
            FROM findings_vec v
            JOIN findings f ON f.id = v.finding_id
            WHERE v.embedding MATCH ? AND k = 30
            ORDER BY v.distance
          `,
            )
            .all(vectorBlob);
        }
      }

      // Merge results via Reciprocal Rank Fusion (RRF)
      // Then apply composite scoring as secondary sort within RRF groups
      const merged = mergeWithRRF(ftsResults, vectorResults);
      const scored = merged.map((r: any) => ({
        ...r,
        composite_score: computeCompositeScore({
          ...r,
          bm25_score: r.bm25_score ?? 0,
        }),
      }));
      // Final sort: RRF score primary, composite secondary
      scored.sort((a: any, b: any) => {
        const rrfDiff = (b.rrf_score ?? 0) - (a.rrf_score ?? 0);
        if (Math.abs(rrfDiff) > 0.001) return rrfDiff;
        return b.composite_score - a.composite_score;
      });

      // Token budget enforcement — reserve 500 tokens for envelope
      let tokenBudget = max_tokens - 500;
      const included: any[] = [];
      for (const r of scored) {
        const est = estimateTokens(r.title + r.content);
        if (tokenBudget - est < 0) break;
        tokenBudget -= est;
        included.push(r);

        // Update access tracking + usage-weighted decay: access IS reinforcement.
        // Bumping last_reinforced re-enters the 14-day grace period (see decay.ts).
        db.prepare(
          `UPDATE findings SET
             accessed_at = datetime('now'),
             access_count = access_count + 1,
             last_reinforced = datetime('now')
           WHERE id = ?`,
        ).run(r.id);
      }

      // Pheromone lookup by keyword match
      const pheromonePattern = `%${keywords.join("%")}%`;
      const pheromones = db
        .prepare(
          `
        SELECT * FROM pheromones
        WHERE task LIKE ? OR files_touched LIKE ? OR gotchas LIKE ?
        ORDER BY created_at DESC LIMIT 10
      `,
        )
        .all(pheromonePattern, pheromonePattern, pheromonePattern);

      const response = {
        query: task_description,
        results_count: included.length,
        token_estimate: max_tokens - tokenBudget,
        findings: included
          .filter((r: any) => r.type === "finding")
          .map(summarize),
        decisions: included
          .filter((r: any) => r.type === "decision")
          .map(summarize),
        gotchas: included
          .filter((r: any) => r.type === "gotcha")
          .map(summarize),
        facts: included
          .filter((r: any) => r.type === "fact")
          .map(summarize),
        pheromones: pheromones.map((p: any) => ({
          task: p.task,
          difficulty: p.difficulty,
          files: safeJsonParse(p.files_touched, []),
          gotchas: safeJsonParse(p.gotchas, []),
          duration_minutes: p.duration_minutes,
        })),
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    },
  );

  // get_detail — fetch full content by ID
  server.tool(
    "get_detail",
    "Get the full content of a specific memory entry by ID. Use after recall_context returns summaries.",
    {
      id: z.number().describe("The finding/decision/gotcha ID"),
    },
    async ({ id }) => {
      const result = db
        .prepare(`SELECT * FROM findings WHERE id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Not found" }),
            },
          ],
        };
      }
      // Update access tracking + usage-weighted decay.
      db.prepare(
        `UPDATE findings SET
           accessed_at = datetime('now'),
           access_count = access_count + 1,
           last_reinforced = datetime('now')
         WHERE id = ?`,
      ).run(id);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

function summarize(r: any) {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    confidence: r.confidence,
    score: Math.round(r.composite_score * 100) / 100,
    created_at: r.created_at,
    summary:
      r.content.length > 200
        ? r.content.substring(0, 200) + "..."
        : r.content,
  };
}

function safeJsonParse(str: string | null, fallback: any): any {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Reciprocal Rank Fusion (RRF) to merge FTS5 + vector search results.
 * RRF score = sum(1 / (k + rank)) across both result sets.
 * k = 60 is the standard constant.
 */
function mergeWithRRF(ftsResults: any[], vecResults: any[], k: number = 60): any[] {
  const scores = new Map<number, { item: any; score: number }>();

  ftsResults.forEach((item, rank) => {
    const existing = scores.get(item.id) || { item, score: 0 };
    existing.score += 1 / (k + rank);
    if (!scores.has(item.id)) existing.item = item;
    scores.set(item.id, existing);
  });

  vecResults.forEach((item, rank) => {
    const existing = scores.get(item.id) || { item, score: 0 };
    existing.score += 1 / (k + rank);
    if (!scores.has(item.id)) existing.item = item;
    scores.set(item.id, existing);
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrf_score: score }));
}
