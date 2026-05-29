import type Database from "better-sqlite3";
import { parseSqliteUtc } from "./scoring.js";

/**
 * Confidence decay engine for Team11 Memory — v2 (2026-04-22).
 *
 * Upgrades over v1 flat 5%/week:
 * - 14-day grace period: recently-reinforced entries don't decay at all
 * - Usage-weighted: reinforce() adds +20% confidence (capped at 1.0) instead of resetting the timer
 * - Contradiction-aware: the contradictions table flags conflicts; decay does NOT overwrite
 *
 * Still below 50% => flagged stale. Below 25% => archived (superseded_by = -1).
 */

const DECAY_RATE = 0.05; // 5% per week after grace period
const STALE_THRESHOLD = 0.5; // Flag at 50%
const ARCHIVE_THRESHOLD = 0.25; // Archive at 25%
const GRACE_PERIOD_DAYS = 14; // Entries touched within N days don't decay
const REINFORCE_BUMP = 0.2; // Each reinforcement adds 20% (capped at 1.0)

export interface DecayResult {
  updated: number;
  flagged: number;
  archived: number;
  skipped_grace: number;
  flaggedEntries: Array<{ id: number; title: string; confidence: number }>;
  archivedEntries: Array<{ id: number; title: string; confidence: number }>;
}

/**
 * Calculate current confidence based on time since last reinforcement.
 *
 * - Within GRACE_PERIOD_DAYS of last_reinforced: no decay (returns null).
 * - After grace: exponential decay at DECAY_RATE per week measured from the
 *   grace-period boundary, computed from a STABLE base of 1.0 — NOT from the
 *   row's current (possibly already-decayed) confidence.
 *
 * Decaying from a stable base makes runDecay idempotent: for a fixed
 * last_reinforced, re-running yields the same target confidence
 * (1.0 * 0.95^weeksAfterGrace) instead of compounding the prior run's result
 * (the old `currentConfidence * 0.95^weeks` re-fed the persisted decayed score
 * back in while weeksAfterGrace was re-measured from the same fixed boundary,
 * so day-28-twice gave 0.95^2*... = 0.814 instead of the intended 0.9025).
 * reinforce() / touchOnRead() advance last_reinforced, which is what actually
 * resets the decay clock.
 *
 * `currentConfidence` is retained in the signature for call-site compatibility
 * but is intentionally NOT used in the decay math (see above).
 *
 * Returns null if the entry is in grace period (caller preserves existing confidence).
 */
export function calculateConfidence(
  lastReinforced: string,
  currentConfidence: number,
): number | null {
  void currentConfidence; // intentionally unused — decay is from a stable base
  const now = new Date();
  const reinforced = new Date(parseSqliteUtc(lastReinforced));
  const daysSince =
    (now.getTime() - reinforced.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < GRACE_PERIOD_DAYS) {
    return null; // Grace — do not decay
  }
  const weeksAfterGrace = (daysSince - GRACE_PERIOD_DAYS) / 7;
  const decayed = 1.0 * Math.pow(1 - DECAY_RATE, weeksAfterGrace);
  return Math.max(0, decayed);
}

/**
 * Run confidence decay across all active findings.
 *
 * Respects the 14-day grace period — recently-reinforced entries are skipped.
 * Only decays entries that have been untouched for >= GRACE_PERIOD_DAYS.
 */
export function runDecay(db: Database.Database): DecayResult {
  const findings = db
    .prepare(
      `SELECT id, title, type, confidence_score, last_reinforced, created_at, superseded_by
       FROM findings
       WHERE superseded_by IS NULL OR superseded_by = 0`,
    )
    .all() as any[];

  let updated = 0;
  let flagged = 0;
  let archived = 0;
  let skipped_grace = 0;
  const flaggedEntries: DecayResult["flaggedEntries"] = [];
  const archivedEntries: DecayResult["archivedEntries"] = [];

  const updateStmt = db.prepare(
    `UPDATE findings SET confidence_score = ? WHERE id = ?`,
  );
  const archiveStmt = db.prepare(
    `UPDATE findings SET superseded_by = -1 WHERE id = ?`,
  );

  for (const f of findings) {
    const currentConfidence = f.confidence_score ?? 1.0;
    const newConfidence = calculateConfidence(
      f.last_reinforced || f.created_at,
      currentConfidence,
    );
    if (newConfidence === null) {
      skipped_grace++;
      continue; // Still in grace period — don't touch
    }
    // Only act when the score actually moved this run. A row whose computed
    // confidence is unchanged (delta <= 0.01) is in steady-state: it was
    // written AND classified on the earlier run that crossed the threshold, so
    // re-flagging it here would double-count the same untouched row every run.
    // (Archived rows can't reach this point — the SELECT above already excludes
    // superseded_by = -1, which is why the old `superseded_by !== -1` guard was
    // dead and has been removed.)
    const changed = Math.abs(newConfidence - currentConfidence) > 0.01;
    if (!changed) {
      continue;
    }
    updateStmt.run(newConfidence, f.id);
    updated++;
    if (newConfidence < ARCHIVE_THRESHOLD) {
      archiveStmt.run(f.id);
      archived++;
      archivedEntries.push({
        id: f.id,
        title: f.title,
        confidence: newConfidence,
      });
    } else if (newConfidence < STALE_THRESHOLD) {
      flagged++;
      flaggedEntries.push({
        id: f.id,
        title: f.title,
        confidence: newConfidence,
      });
    }
  }

  return { updated, flagged, archived, skipped_grace, flaggedEntries, archivedEntries };
}

/**
 * Reinforce a finding.
 *
 * Adds REINFORCE_BUMP (20%) to current confidence, capped at 1.0.
 * Resets last_reinforced to now — entry re-enters grace period.
 *
 * Called when an agent re-confirms a fact (via [REINFORCED] marker) OR
 * when memory tools like recall_context/search_memory return the entry
 * (usage-weighted reinforcement — access IS confirmation).
 */
export function reinforce(db: Database.Database, findingId: number): void {
  db.prepare(
    `UPDATE findings SET
       confidence_score = MIN(1.0, COALESCE(confidence_score, 1.0) + ?),
       last_reinforced = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(REINFORCE_BUMP, findingId);
}

/**
 * Touch a finding on read — lighter than full reinforce.
 *
 * Used by recall_context / search_memory / get_file_summary when they
 * return an entry. Updates last_reinforced so the entry re-enters grace
 * period, but does NOT bump confidence_score — read access is a weaker
 * signal than an explicit [REINFORCED] marker.
 *
 * DESIGN NOTE (grace-timer immortality, decay audit 2026-05-29):
 * Because this resets last_reinforced on EVERY read, any entry that keeps
 * getting returned by search/recall re-enters the 14-day grace window forever
 * and can never decay — i.e. frequently-read entries are effectively immortal.
 * This is PARTLY BY DESIGN ("access IS reinforcement" — a fact the team keeps
 * looking up is presumably still relevant). The tension: last_reinforced is
 * doing double duty as both the ranking-recency signal AND the decay clock, so
 * we can't suppress the immortality here without also degrading recency ranking
 * or weakening the intended reinforcement semantics. The real fix is a SCHEMA
 * change — split last_accessed (drives recency in scoring.ts) from
 * last_reinforced (drives decay here) and only let explicit reinforce() / the
 * [REINFORCED] marker move the decay clock. That is intentionally DEFERRED (no
 * migration in this pass); a throttle in-file would be a risky behavior change
 * to a by-design path, so it is not applied here.
 */
export function touchOnRead(db: Database.Database, findingId: number): void {
  db.prepare(
    `UPDATE findings SET
       last_reinforced = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(findingId);
}

/**
 * Bulk touch — same as touchOnRead but for a list of ids in one transaction.
 * Tools returning multiple entries should use this.
 */
export function touchManyOnRead(
  db: Database.Database,
  findingIds: number[],
): void {
  if (findingIds.length === 0) return;
  const stmt = db.prepare(`UPDATE findings SET
       last_reinforced = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`);
  const txn = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(id);
  });
  txn(findingIds);
}

/**
 * Restore an archived finding (un-archive).
 * Resets confidence to 1.0 and clears the archive marker.
 */
export function restore(db: Database.Database, findingId: number): void {
  db.prepare(
    `UPDATE findings SET
       superseded_by = NULL,
       confidence_score = 1.0,
       last_reinforced = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(findingId);
}

/**
 * Garbage-collect stale file summaries.
 * Deletes entries not generated or accessed in the last 7 days.
 */
export function gcSummaries(db: Database.Database): { deleted: number } {
  const result = db.prepare(`
    DELETE FROM file_summaries
    WHERE generated_at < datetime('now', '-7 days')
      AND accessed_at < datetime('now', '-7 days')
  `).run();
  return { deleted: result.changes };
}
