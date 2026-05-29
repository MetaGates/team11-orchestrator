import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { forceSync, isSyncActive } from "../sync.js";

/**
 * Compute the blob SHA for a file, matching git's content-addressable storage.
 * Uses `git hash-object` for tracked files; falls back to sha256 for untracked/dirty.
 */
function computeBlobSha(filePath: string, projectRoot: string): string {
  const absPath = resolve(projectRoot, filePath);
  try {
    // Try git hash-object first (works for tracked files).
    // execFileSync (no shell) — absPath is passed as an argv element, so a
    // malicious file_path cannot inject shell metacharacters (D1: RCE fix).
    const sha = execFileSync("git", ["hash-object", absPath], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (sha) return sha;
  } catch {
    // Fall through to content hash
  }
  // Fallback: sha256 of file content (for untracked/dirty files)
  const content = readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

interface SummaryRow {
  id: number;
  file_path: string;
  blob_sha: string;
  summary: string;
  key_exports: string | null;
  line_count: number | null;
  byte_size: number | null;
  tags: string | null;
  generated_by: string;
  generated_at: string;
  accessed_at: string;
  access_count: number;
}

export function registerSummaryTools(
  server: McpServer,
  db: Database.Database,
  projectRoot: string,
): void {
  server.tool(
    "get_file_summary",
    "Get a cached structural summary for a file. Returns the summary if the file content (by git blob SHA) hasn't changed, or {cached: false} if the file needs a fresh read.",
    {
      file_path: z
        .string()
        .describe("Relative path from project root (e.g. 'client-game/src/main.js')"),
      project_root: z
        .string()
        .optional()
        .describe("Override project root (defaults to server's project root)"),
    },
    async ({ file_path, project_root }) => {
      const root = project_root ?? projectRoot;

      // Verify file exists before hashing
      const absPath = resolve(root, file_path);
      try {
        statSync(absPath);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cached: false,
                error: "file_not_found",
                file_path,
              }),
            },
          ],
        };
      }

      const blobSha = computeBlobSha(file_path, root);

      const row = db
        .prepare(
          `SELECT * FROM file_summaries WHERE file_path = ? AND blob_sha = ?`,
        )
        .get(file_path, blobSha) as SummaryRow | undefined;

      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cached: false,
                file_path,
                blob_sha: blobSha,
              }),
            },
          ],
        };
      }

      // Update access tracking
      db.prepare(
        `UPDATE file_summaries
         SET accessed_at = datetime('now'),
             access_count = access_count + 1
         WHERE id = ?`,
      ).run(row.id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              cached: true,
              file_path: row.file_path,
              blob_sha: row.blob_sha,
              summary: row.summary,
              key_exports: row.key_exports ? JSON.parse(row.key_exports) : null,
              line_count: row.line_count,
              byte_size: row.byte_size,
              tags: row.tags ? JSON.parse(row.tags) : null,
              generated_at: row.generated_at,
              access_count: row.access_count + 1,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "store_file_summary",
    "Store a structural summary for a file, keyed by its current git blob SHA. Upserts on (file_path, blob_sha) — safe to call repeatedly.",
    {
      file_path: z
        .string()
        .describe("Relative path from project root"),
      summary: z
        .string()
        .describe("Structural summary of the file (~400 tokens)"),
      key_exports: z
        .array(z.string())
        .optional()
        .describe("Exported functions, classes, constants"),
      line_count: z.number().optional().describe("Number of lines in the file"),
      byte_size: z.number().optional().describe("File size in bytes"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization (e.g. 'ui', 'network', 'server')"),
      project_root: z
        .string()
        .optional()
        .describe("Override project root (defaults to server's project root)"),
    },
    async ({ file_path, summary, key_exports, line_count, byte_size, tags, project_root }) => {
      const root = project_root ?? projectRoot;
      const blobSha = computeBlobSha(file_path, root);
      const keyExportsJson = key_exports ? JSON.stringify(key_exports) : null;
      const tagsJson = tags ? JSON.stringify(tags) : null;

      const result = db
        .prepare(
          `INSERT INTO file_summaries (file_path, blob_sha, summary, key_exports, line_count, byte_size, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_path, blob_sha) DO UPDATE SET
             summary = excluded.summary,
             key_exports = excluded.key_exports,
             line_count = excluded.line_count,
             byte_size = excluded.byte_size,
             tags = excluded.tags,
             generated_at = datetime('now'),
             accessed_at = datetime('now')`,
        )
        .run(file_path, blobSha, summary, keyExportsJson, line_count ?? null, byte_size ?? null, tagsJson);

      if (isSyncActive()) await forceSync();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              file_path,
              blob_sha: blobSha,
              id: result.lastInsertRowid,
            }),
          },
        ],
      };
    },
  );
}
