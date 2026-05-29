import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createHash } from "node:crypto";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { forceSync, isSyncActive } from "../sync.js";

/**
 * Generate and store embedding for a finding.
 * Skips if embeddings unavailable or content unchanged (by hash).
 */
async function storeEmbedding(db: Database.Database, findingId: number | bigint, content: string): Promise<void> {
  if (!embeddingsAvailable()) return;

  const contentHash = createHash("sha256").update(content).digest("hex");

  // Check cache — skip if content unchanged
  const cached = db.prepare(`SELECT content_hash FROM embedding_cache WHERE finding_id = ?`).get(Number(findingId)) as { content_hash: string } | undefined;
  if (cached && cached.content_hash === contentHash) return;

  const vector = await embed(content);
  if (!vector) return;

  const vectorBlob = Buffer.from(vector.buffer);

  // Store in vec0 virtual table
  db.prepare(`INSERT OR REPLACE INTO findings_vec (finding_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(Number(findingId), vectorBlob);

  // Store in cache
  db.prepare(`INSERT OR REPLACE INTO embedding_cache (finding_id, content_hash, embedding) VALUES (?, ?, ?)`).run(Number(findingId), contentHash, vectorBlob);
}

export function registerStoreTools(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    "store_finding",
    "Store a finding, decision, gotcha, or fact in Team11's persistent memory.",
    {
      title: z.string().describe("Short title for the finding"),
      content: z.string().describe("Full content/description"),
      type: z
        .enum(["finding", "decision", "gotcha", "fact", "architecture"])
        .default("finding"),
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .default("medium"),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.4),
      source_pair: z
        .string()
        .optional()
        .describe("Which pair created this"),
      source_file: z
        .string()
        .optional()
        .describe("Original source file path"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization"),
    },
    async ({
      title,
      content,
      type,
      confidence,
      importance,
      source_pair,
      source_file,
      tags,
    }) => {
      const tagsJson = tags ? JSON.stringify(tags) : null;

      const result = db
        .prepare(
          `
        INSERT INTO findings (title, content, type, confidence, importance, source_pair, source_file, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          title,
          content,
          type,
          confidence,
          importance,
          source_pair ?? null,
          source_file ?? null,
          tagsJson,
        );

      await storeEmbedding(db, result.lastInsertRowid, `${title} ${content}`);
      if (isSyncActive()) await forceSync();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: result.lastInsertRowid,
              type,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "store_decision",
    "Store an architectural or design decision with rationale.",
    {
      title: z.string().describe("Decision title"),
      content: z.string().describe("What was decided"),
      rationale: z.string().describe("Why this was decided"),
      decided_by: z.string().optional().default("Human"),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, content, rationale, decided_by, tags }) => {
      const fullContent = `${content}\n\nRationale: ${rationale}\nDecided by: ${decided_by}`;
      const tagsJson = tags ? JSON.stringify(tags) : null;

      const result = db
        .prepare(
          `
        INSERT INTO findings (title, content, type, confidence, importance, tags)
        VALUES (?, ?, 'decision', 'high', 0.8, ?)
      `,
        )
        .run(title, fullContent, tagsJson);

      await storeEmbedding(db, result.lastInsertRowid, `${title} ${fullContent}`);
      if (isSyncActive()) await forceSync();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: result.lastInsertRowid,
              type: "decision",
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "store_gotcha",
    "Store a gotcha or non-obvious pitfall for future agents to avoid.",
    {
      title: z.string().describe("Brief gotcha description"),
      content: z
        .string()
        .describe("Full explanation with file paths and evidence"),
      evidence: z
        .string()
        .optional()
        .describe("How this was discovered"),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, content, evidence, tags }) => {
      const fullContent = evidence
        ? `${content}\n\nEvidence: ${evidence}`
        : content;
      const tagsJson = tags ? JSON.stringify(tags) : null;

      const result = db
        .prepare(
          `
        INSERT INTO findings (title, content, type, confidence, importance, tags)
        VALUES (?, ?, 'gotcha', 'high', 0.7, ?)
      `,
        )
        .run(title, fullContent, tagsJson);

      await storeEmbedding(db, result.lastInsertRowid, `${title} ${fullContent}`);
      if (isSyncActive()) await forceSync();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: result.lastInsertRowid,
              type: "gotcha",
            }),
          },
        ],
      };
    },
  );
}

// Re-export for use by seed script
export { storeEmbedding };
