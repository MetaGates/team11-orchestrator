/**
 * write-and-sync.ts — Standalone script for the Secretary agent.
 *
 * Ensures all DB tables exist (initDb), writes outbox entries,
 * triggers Turso sync so coworkers see changes within 60s.
 *
 * Usage: node dist/scripts/write-and-sync.js <outbox.json>
 *
 * The JSON file contains an array of outbox entries:
 * [
 *   { "type": "fact", "title": "...", "content": "...", "confidence": "high" },
 *   { "type": "pheromone", "task": "...", "pair": "...", "difficulty": "LOW", ... },
 *   { "type": "gotcha", "title": "...", "content": "...", "evidence": "..." },
 *   { "type": "contradiction", "claim_a": "...", "source_a": "...", ... },
 *   { "type": "reinforced", "finding_id": 42 },
 *   { "type": "release_files", "pair_id": "cs-pair-1" }
 * ]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../db.js";
import { loadSyncConfig, initSync, forceSync, shutdownSync } from "../sync.js";
import { initEmbeddings } from "../embeddings.js";
import { storeEmbedding } from "../tools/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(): string {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team11"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not find project root");
}

interface OutboxEntry {
  type: string;
  [key: string]: unknown;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node dist/scripts/write-and-sync.js <outbox.json>");
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const dbPath = join(projectRoot, ".team11", "memory.db");

  // 1. Init DB — ensures ALL tables exist (including new ones)
  const db = initDb(dbPath);
  console.error(`[write-and-sync] DB initialized: ${dbPath}`);

  // 1b. Init the embedding model so findings written below get vector
  // embeddings (D6 fix). Without this, storeEmbedding() no-ops because
  // embeddingsAvailable() is false, and Secretary-written knowledge stays
  // invisible to vector recall. Non-blocking: if the model fails to load,
  // embeddingsAvailable() stays false and we degrade to FTS-only (same as
  // before this fix) rather than erroring.
  await initEmbeddings();

  // 2. Init Turso sync
  const syncConfig = loadSyncConfig(projectRoot);
  if (syncConfig) {
    await initSync(dbPath, syncConfig);
    console.error("[write-and-sync] Turso sync connected");
  } else {
    console.error("[write-and-sync] No sync config — local-only mode");
  }

  // 3. Read and process outbox entries
  let entries: OutboxEntry[];
  try {
    entries = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (err) {
    console.error(`[write-and-sync] Failed to parse ${inputPath}:`, err);
    process.exit(1);
  }

  if (!Array.isArray(entries)) {
    console.error("[write-and-sync] Expected JSON array");
    process.exit(1);
  }

  const results = { facts: 0, pheromones: 0, gotchas: 0, contradictions: 0, reinforced: 0, released: 0, errors: 0 };

  for (const entry of entries) {
    try {
      switch (entry.type) {
        case "fact": {
          const factTitle = entry.title as string;
          const factContent = entry.content as string;
          const factResult = db.prepare(
            `INSERT INTO findings (title, content, type, confidence, importance, source_pair, tags)
             VALUES (?, ?, 'fact', ?, 0.6, ?, ?)`
          ).run(
            factTitle,
            factContent,
            (entry.confidence as string) ?? "high",
            (entry.pair as string) ?? null,
            entry.tags ? JSON.stringify(entry.tags) : null
          );
          // D6: compute + store embedding the same way store_finding does
          // (reuse storeEmbedding; same `${title} ${content}` shape).
          await storeEmbedding(db, factResult.lastInsertRowid, `${factTitle} ${factContent}`);
          results.facts++;
          break;
        }

        case "pheromone":
          db.prepare(
            `INSERT INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, estimated_duration_minutes, rounds, findings_count, verdict_breakdown)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            entry.task as string,
            (entry.pair as string) ?? null,
            (entry.difficulty as string) ?? "MEDIUM",
            JSON.stringify((entry.files_touched as string[]) ?? []),
            JSON.stringify((entry.gotchas as string[]) ?? []),
            (entry.actual_duration_min as number) ?? null,
            (entry.estimated_duration_min as number) ?? null,
            (entry.rounds as number) ?? null,
            (entry.findings_count as number) ?? null,
            entry.verdict_breakdown ? JSON.stringify(entry.verdict_breakdown) : null
          );
          results.pheromones++;
          break;

        case "gotcha": {
          const gotchaTitle = entry.title as string;
          const gotchaContent = entry.evidence
            ? `${entry.content}\n\nEvidence: ${entry.evidence}`
            : (entry.content as string);
          const gotchaResult = db.prepare(
            `INSERT INTO findings (title, content, type, confidence, importance, tags)
             VALUES (?, ?, 'gotcha', 'high', 0.7, ?)`
          ).run(
            gotchaTitle,
            gotchaContent,
            entry.tags ? JSON.stringify(entry.tags) : null
          );
          // D6: embed the stored content (matches store_gotcha's
          // `${title} ${fullContent}` shape) so it's vector-searchable.
          await storeEmbedding(db, gotchaResult.lastInsertRowid, `${gotchaTitle} ${gotchaContent}`);
          results.gotchas++;
          break;
        }

        case "contradiction":
          db.prepare(
            `INSERT INTO contradictions (claim_a, source_a, claim_b, source_b, status)
             VALUES (?, ?, ?, ?, 'OPEN')`
          ).run(
            entry.claim_a as string,
            entry.source_a as string,
            entry.claim_b as string,
            entry.source_b as string
          );
          results.contradictions++;
          break;

        case "reinforced":
          db.prepare(
            `UPDATE findings SET confidence_score = 1.0, last_reinforced = datetime('now'), updated_at = datetime('now') WHERE id = ?`
          ).run(entry.finding_id as number);
          results.reinforced++;
          break;

        case "release_files":
          db.prepare(
            `UPDATE active_edits SET released_at = datetime('now'), status = 'merged' WHERE pair_id = ? AND released_at IS NULL`
          ).run(entry.pair_id as string);
          results.released++;
          break;

        default:
          console.error(`[write-and-sync] Unknown entry type: ${entry.type}`);
          results.errors++;
      }
    } catch (err) {
      console.error(`[write-and-sync] Error processing ${entry.type} entry:`, err);
      results.errors++;
    }
  }

  // 4. Force Turso sync to push changes to cloud
  if (syncConfig) {
    await forceSync();
    console.error("[write-and-sync] Turso sync pushed");
  }

  // 5. Report results
  console.log(JSON.stringify(results));

  // 6. Clean up
  shutdownSync();
  db.close();
}

main().catch((err) => {
  console.error("[write-and-sync] Fatal:", err);
  process.exit(1);
});
