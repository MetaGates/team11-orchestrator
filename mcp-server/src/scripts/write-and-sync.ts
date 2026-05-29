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
 *   { "type": "release_files", "pair_id": "cs-pair-1", "files": ["a.ts", "b.ts"] }
 * ]
 *
 * CONCURRENCY: this carrier writes the SAME tables (findings / pheromones /
 * contradictions / active_edits) as process-pair-log.ts and consolidate-memory.ts,
 * and triggers the SAME Turso forceSync, so it MUST serialise against them. It
 * acquires the SAME single-flight lock (`.team11/_secretary.lock`) those two use
 * — the lock helpers below are the IDENTICAL atomic-mkdir + 120s CAS-stale-steal
 * pattern. If the lock is held by a live copy we exit 0 cleanly (the outbox file
 * is durable; the CEO/caller can re-run us once the holder releases).
 *
 * IDEMPOTENCY: every finding/gotcha insert carries source_file (the outbox path)
 * so the findings UNIQUE(title, source_file) constraint dedupes re-runs of the
 * same outbox; a UNIQUE collision is counted as `skipped`, not an error.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
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

// --- single-flight lock (shared with process-pair-log.ts + consolidate-memory.ts)
//
// IDENTICAL mechanism to those two carriers: an atomic mkdir on a directory is
// the sole ownership signal (NO { recursive: true } — recursive makes EEXIST
// silent, defeating the lock). Stale recovery is a compare-and-swap via atomic
// rename so two racing stealers (or a stealer + a fresh holder) can never both
// believe they own it. We share the SAME lock dir name so all three mutually
// exclude on the shared better-sqlite3 DB + Turso forceSync.

const LOCK_DIR_NAME = "_secretary.lock";
const LOCK_META_NAME = "owner.json";
const STALE_LOCK_MS = 120_000; // 120s: holder presumably crashed past this.

function lockDirPath(projectRoot: string): string {
  return join(projectRoot, ".team11", LOCK_DIR_NAME);
}

interface LockMeta {
  pid: number;
  acquired_at: string; // ISO-8601
}

/** Best-effort read of lock owner metadata; malformed/missing returns null. */
function readLockMeta(dir: string): LockMeta | null {
  try {
    const raw = readFileSync(join(dir, LOCK_META_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.acquired_at === "string") {
      return parsed as LockMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically create the lock dir and stamp ownership. Returns true on success,
 * false on EEXIST (already held). Any other fs error propagates.
 */
function tryCreateLock(dir: string): boolean {
  try {
    mkdirSync(dir); // atomic; NO { recursive: true }.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  const meta: LockMeta = { pid: process.pid, acquired_at: new Date().toISOString() };
  writeFileSync(join(dir, LOCK_META_NAME), JSON.stringify(meta) + "\n");
  return true;
}

/**
 * Acquire the single-flight lock. Returns true if we hold it, false if a live
 * copy holds it (caller should exit 0 cleanly). Stale-lock recovery uses a
 * CAS-via-atomic-rename, identical to process-pair-log.ts — see that file for
 * the full proof that double-acquire is impossible.
 */
function acquireLock(projectRoot: string): boolean {
  const dir = lockDirPath(projectRoot);

  if (tryCreateLock(dir)) return true;

  const meta = readLockMeta(dir);
  const ageMs = meta ? Date.now() - Date.parse(meta.acquired_at) : Infinity;
  const isStale = !meta || !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS;
  if (!isStale) return false; // fresh lock, real holder — bail cleanly.

  console.error(
    `[write-and-sync] Attempting steal of stale lock (age ${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + "s" : "unknown"}, pid ${meta?.pid ?? "?"})`,
  );

  const victim = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, victim); // atomic; only one stealer can win this move.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("[write-and-sync] Stale-lock rename failed (falling back to create):", err);
    }
    return tryCreateLock(dir);
  }

  // CAS check: confirm what we moved is the SAME stale instance we observed.
  const moved = readLockMeta(victim);
  const stillSameStale =
    (!meta && !moved) ||
    (!!meta && !!moved && moved.acquired_at === meta.acquired_at);
  if (!stillSameStale) {
    console.error("[write-and-sync] Lock changed under steal — restoring and bailing.");
    try {
      renameSync(victim, dir);
    } catch {
      try {
        rmSync(victim, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return false;
  }

  try {
    rmSync(victim, { recursive: true, force: true });
  } catch (err) {
    console.error("[write-and-sync] Could not delete stolen stale lock (continuing):", err);
  }
  return tryCreateLock(dir);
}

/** Release the lock we hold. Best-effort + idempotent — never throws. */
function releaseLock(projectRoot: string): void {
  try {
    rmSync(lockDirPath(projectRoot), { recursive: true, force: true });
  } catch (err) {
    console.error("[write-and-sync] WARNING: could not release lock (stale-steal will recover):", err);
  }
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

  // 0. Single-flight lock (write path). If another live carrier (this script,
  //    process-pair-log.ts, or consolidate-memory.ts) holds it, exit 0 cleanly:
  //    the outbox file is durable, so re-running later loses nothing, and we
  //    must NOT race them on the shared SQLite DB + Turso forceSync.
  if (!acquireLock(projectRoot)) {
    console.log(JSON.stringify({ skipped: "lock-held" }));
    return;
  }

  // Everything below mutates shared state (SQLite DB, Turso) and MUST run under
  // the lock. try/finally guarantees release even on throw; a hard crash that
  // skips finally is covered by the 120s stale-steal in acquireLock().
  try {
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

    // 3. Read and process outbox entries.
    //    NOTE: we THROW (not process.exit) on bad input here — process.exit
    //    skips the finally{} block, which would orphan the lock dir until the
    //    120s stale-steal. Throwing propagates through finally (lock released)
    //    to the top-level .catch, which exits non-zero.
    let entries: OutboxEntry[];
    try {
      entries = JSON.parse(readFileSync(inputPath, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse ${inputPath}: ${String((err as Error)?.message ?? err)}`);
    }

    if (!Array.isArray(entries)) {
      throw new Error("Expected JSON array of outbox entries");
    }

    // source_file provenance: stamp every finding/gotcha with the outbox path so
    // the findings UNIQUE(title, source_file) constraint dedupes re-runs of the
    // same outbox. An explicit per-entry `source_file` wins over this default.
    const defaultSourceFile = inputPath;

    const results = { facts: 0, pheromones: 0, gotchas: 0, contradictions: 0, reinforced: 0, released: 0, skipped: 0, errors: 0 };

    for (const entry of entries) {
      try {
        switch (entry.type) {
          case "fact": {
            const factTitle = entry.title as string;
            const factContent = entry.content as string;
            const factResult = db.prepare(
              `INSERT INTO findings (title, content, type, confidence, importance, source_pair, source_file, tags)
               VALUES (?, ?, 'fact', ?, 0.6, ?, ?, ?)`
            ).run(
              factTitle,
              factContent,
              (entry.confidence as string) ?? "high",
              (entry.pair as string) ?? null,
              (entry.source_file as string) ?? defaultSourceFile,
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
              `INSERT INTO findings (title, content, type, confidence, importance, source_file, tags)
               VALUES (?, ?, 'gotcha', 'high', 0.7, ?, ?)`
            ).run(
              gotchaTitle,
              gotchaContent,
              (entry.source_file as string) ?? defaultSourceFile,
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

          case "reinforced": {
            // Use the SAME +20%-capped bump as decay.ts::reinforce() — a hard
            // confidence_score=1.0 reset over-credits a single re-confirmation
            // (a fact reinforced once would jump straight to max). COALESCE
            // fallback 0.5 matches decay.ts so a NULL score behaves identically.
            // A NULL/absent id is a no-op UPDATE; it must NOT be counted as
            // reinforced — record it as skipped so the report is honest.
            const id = (entry.finding_id as number) ?? (entry.fact_id as number);
            if (id == null) {
              results.skipped++;
              break;
            }
            const reinforceResult = db.prepare(
              `UPDATE findings SET confidence_score = MIN(1.0, COALESCE(confidence_score, 0.5) + 0.2),
                 last_reinforced = datetime('now'), updated_at = datetime('now') WHERE id = ?`
            ).run(id);
            // A non-existent id changes 0 rows — also a no-op, not a reinforce.
            if (reinforceResult.changes > 0) results.reinforced++;
            else results.skipped++;
            break;
          }

          case "release_files": {
            // File-scoped release. The pair-wide UPDATE (no file filter) marks
            // EVERY one of a pair's open claims merged, even files still being
            // edited by a concurrent round, and ignores the files[] payload.
            // Scope the release to the files[] when present; fall back to
            // pair-wide only when no files[] is supplied (back-compat with the
            // release_file MCP tool, which has no files param).
            const pairId = entry.pair_id as string;
            const files = Array.isArray(entry.files) ? (entry.files as unknown[]).filter((f): f is string => typeof f === "string") : [];
            let releaseResult: { changes: number };
            if (files.length > 0) {
              const placeholders = files.map(() => "?").join(", ");
              releaseResult = db.prepare(
                `UPDATE active_edits SET released_at = datetime('now'), status = 'merged'
                 WHERE pair_id = ? AND released_at IS NULL AND file_path IN (${placeholders})`
              ).run(pairId, ...files);
            } else {
              releaseResult = db.prepare(
                `UPDATE active_edits SET released_at = datetime('now'), status = 'merged' WHERE pair_id = ? AND released_at IS NULL`
              ).run(pairId);
            }
            // Count actual rows released so a stale/no-op release isn't reported
            // as work done.
            if (releaseResult.changes > 0) results.released++;
            else results.skipped++;
            break;
          }

          default:
            console.error(`[write-and-sync] Unknown entry type: ${entry.type}`);
            results.errors++;
        }
      } catch (err) {
        // UNIQUE(title, source_file) collisions (idempotent re-writes of the
        // same fact/gotcha) are expected on re-run — count as skipped, not error.
        const msg = String((err as Error)?.message ?? err);
        if (/UNIQUE constraint failed/i.test(msg)) {
          results.skipped++;
        } else {
          console.error(`[write-and-sync] Error processing ${entry.type} entry:`, err);
          results.errors++;
        }
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
  } finally {
    releaseLock(projectRoot);
  }
}

main().catch((err) => {
  console.error("[write-and-sync] Fatal:", err);
  process.exit(1);
});
