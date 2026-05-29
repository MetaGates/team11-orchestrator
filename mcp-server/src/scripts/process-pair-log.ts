/**
 * process-pair-log.ts — The Secretary carrier (Team11 defect D4, Mode A).
 *
 * Reads Team11 pair logs, extracts NEW `[OUTBOX:*]` markers (plus the
 * `[FACT]` / `[GOTCHA]` / `[REINFORCED]` / `[CONTRADICTION]` line prefixes and
 * `QUESTION FOR HUMAN`), and writes them into the memory DB — reusing the
 * existing write primitives (`initDb`, `storeEmbedding`) and Turso sync. It is
 * a ONE-SHOT, idempotent processor: it is NOT a poll/sleep loop.
 *
 * Trigger models (it is correct under BOTH):
 *   1. Event-driven SubagentStop hook (WIRED + VERIFIED 2026-05-29): a
 *      `.claude/settings.local.json` hook on matcher "team11-coder-auditor" runs
 *      this on every pair completion. The hook passes only the project root on
 *      stdin (no pair identity), so the default "scan all logs" behaviour is what
 *      it needs. It NO LONGER needs `--all-history`: a freshly-created (live) pair
 *      log is now recognised by its filesystem mtime (within
 *      BACKLOG_MTIME_WINDOW_MS, default 48h) and processed in full, while an old
 *      historical log is still baseline-skipped (see the backlog guard + the
 *      `--all-history` flag below). The single-flight lock makes concurrent
 *      firings (multiple pairs finishing at once) safe.
 *   2. CEO-driven (fallback / manual): the CEO runs this between dispatches.
 *
 *   HARNESS NOTE — VERIFIED 2026-05-29 (CC 2.1.156, live SubagentStop probe +
 *   end-to-end test): Stop/SubagentStop DO fire for subagents spawned with
 *   run_in_background=true. The older issue #25147 ("background agents bypass
 *   Stop hooks", CLOSED not-planned) was superseded by #33049 + #58637 (both
 *   COMPLETED). The payload carries agent_id/agent_type/background_tasks/
 *   stop_hook_active but NO pair-log path — hence scan-all + mtime-based
 *   live-log detection (no `--all-history` needed). High-concurrency foot-gun:
 *   see #58637; the single-flight lock + scan-all idempotency cover it.
 *
 * Idempotency: a per-log high-water mark (line count) is persisted in
 * `.team11/_secretary_state.json`. Re-running only processes lines added since
 * the last successful run, so double-writes do not happen. A
 * `[SECRETARY:PROCESSED ...]` marker is also appended to each log it advances.
 *
 * Usage:
 *   node dist/scripts/process-pair-log.js [projectRoot] [options]
 *   node dist/scripts/process-pair-log.js [path/to/.team11/logs/pair-N.md] [options]
 *
 * Options:
 *   --pair <id>        Process only logs/pair-<id>.md (e.g. --pair 3).
 *   --log <path>       Process exactly this log file (must live under .team11/logs/).
 *   --project <path>   Project root (default: PROJECT_ROOT env, then walk up from script).
 *   --all-history      Explicit override: process the ENTIRE log even with no prior
 *                      high-water mark, REGARDLESS of the log's mtime. Rarely needed
 *                      now — a never-processed log is auto-classified by its file
 *                      mtime: if it was modified within BACKLOG_MTIME_WINDOW_MS
 *                      (default 48h, overridable via TEAM11_BACKLOG_WINDOW_HOURS) it
 *                      is a LIVE pair log and is ingested from line 0 automatically;
 *                      only an OLDER, never-processed log with no [SECRETARY:PROCESSED]
 *                      marker is treated as historical backlog and SKIPPED (a marker
 *                      is written at the current end so future entries are picked up).
 *                      Use this flag to force-ingest a stale/historical log on demand.
 *   --dry-run          Parse + report, but do not write to the DB, advance the
 *                      high-water mark, or append markers.
 *
 * Exit code 0 on success (even with per-entry parse errors, which are reported).
 * Non-zero only on fatal setup errors (bad path, DB init failure).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../db.js";
import { storeEmbedding } from "../tools/store.js";
import { initEmbeddings } from "../embeddings.js";
import { loadSyncConfig, initSync, forceSync, shutdownSync } from "../sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- backlog recency window ----------------------------------------------
//
// A pair log that has never been processed (no high-water mark) AND has no
// [SECRETARY:PROCESSED] marker is ambiguous: it could be a freshly-created LIVE
// pair log (its first markers waiting to be ingested) or an OLD historical log
// from a past session (mass-ingest hazard). We disambiguate by the file's
// MODIFICATION TIME (fs.statSync().mtimeMs):
//   - mtime within the window  => LIVE  => process from line 0 (like --all-history)
//   - mtime older than window  => stale => baseline-skip (just set the mark)
// This removes the carrier's one fragile dependency: the SubagentStop hook no
// longer needs --all-history, and deleting _secretary_state.json no longer
// re-ingests every old log — only logs touched within the window come back.
//
// Default 48h. Tunable at runtime via TEAM11_BACKLOG_WINDOW_HOURS (a positive
// finite number of hours); anything missing/invalid falls back to the default.
const DEFAULT_BACKLOG_WINDOW_HOURS = 48;

function resolveBacklogWindowMs(): number {
  const raw = process.env.TEAM11_BACKLOG_WINDOW_HOURS;
  if (raw !== undefined && raw.trim() !== "") {
    const hours = Number(raw);
    if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
    console.error(
      `[process-pair-log] WARNING: ignoring invalid TEAM11_BACKLOG_WINDOW_HOURS=${raw} (want a positive number); using default ${DEFAULT_BACKLOG_WINDOW_HOURS}h`,
    );
  }
  return DEFAULT_BACKLOG_WINDOW_HOURS * 60 * 60 * 1000;
}

const BACKLOG_MTIME_WINDOW_MS = resolveBacklogWindowMs();

// --- types ---------------------------------------------------------------

interface OutboxEntry {
  type: string;
  [key: string]: unknown;
}

interface WriteResults {
  facts: number;
  pheromones: number;
  gotchas: number;
  contradictions: number;
  reinforced: number;
  released: number;
  questions: number;
  skipped: number;
  errors: number;
}

interface LogResult {
  log: string;
  linesScanned: number;
  fromLine: number;
  processed: boolean;
  reason?: string;
  results: WriteResults;
}

// Per-log high-water mark state. Keyed by log path RELATIVE to project root
// (posix-normalised) so the state file is portable across machines/operators.
type SecretaryState = Record<string, { lines: number; updated_at: string }>;

function emptyResults(): WriteResults {
  return {
    facts: 0,
    pheromones: 0,
    gotchas: 0,
    contradictions: 0,
    reinforced: 0,
    released: 0,
    questions: 0,
    skipped: 0,
    errors: 0,
  };
}

// --- project root / paths ------------------------------------------------

function findProjectRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.PROJECT_ROOT) return resolve(process.env.PROJECT_ROOT);
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team11"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find project root (no .team11/ directory found)");
}

/** Posix-normalised path relative to project root (state-file key + marker text). */
function relKey(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).split("\\").join("/");
}

/**
 * Resolve and validate a log path. SECURITY: the resolved path MUST live inside
 * `<projectRoot>/.team11/logs/`. Anything else (path traversal, absolute escape)
 * is rejected. No shell interpolation anywhere — paths are used only with fs.
 */
function resolveLogPathSafe(projectRoot: string, candidate: string): string {
  const logsDir = resolve(join(projectRoot, ".team11", "logs"));
  const abs = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(join(projectRoot, candidate));
  const rel = relative(logsDir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to process log outside .team11/logs/: ${candidate} (resolved ${abs})`,
    );
  }
  return abs;
}

function discoverPairLogs(projectRoot: string): string[] {
  const logsDir = join(projectRoot, ".team11", "logs");
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((f) => f.startsWith("pair-") && f.endsWith(".md"))
    .sort()
    .map((f) => join(logsDir, f));
}

// --- state ---------------------------------------------------------------

function statePath(projectRoot: string): string {
  return join(projectRoot, ".team11", "_secretary_state.json");
}

function loadState(projectRoot: string): SecretaryState {
  const p = statePath(projectRoot);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SecretaryState) : {};
  } catch (err) {
    console.error(`[process-pair-log] WARNING: could not parse ${p}, treating as empty:`, err);
    return {};
  }
}

function saveState(projectRoot: string, state: SecretaryState): void {
  writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2) + "\n");
}

// --- single-flight lock --------------------------------------------------
//
// This carrier is about to be wired to a SubagentStop hook that fires once per
// pair completion. If 2+ pairs finish at the same instant, multiple copies run
// at once and would race on the shared SQLite DB (better-sqlite3), the pair
// logs, and the per-log high-water-mark state file. We serialise the WRITE path
// with a single-flight lock so only one copy mutates state at a time.
//
// Atomicity: the lock is a DIRECTORY created with mkdirSync. mkdir is atomic at
// the syscall level — it either creates the dir (we win) or throws EEXIST (held
// by someone else). There is NO check-then-act window (we never existsSync then
// mkdir), so there is no TOCTOU race between two racing processes.
//
// Because the holder scans ALL pair logs (default behaviour), a copy that fails
// to acquire loses NO work by bailing: the holder will pick up every marker the
// bailing copy would have. So lock-held is a clean exit-0, not an error.

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

/**
 * Read the lock owner metadata. Best-effort: a partially-written, missing, or
 * malformed meta file returns null (caller treats null as "unknown age").
 */
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
 * Try to atomically create the lock dir and stamp owner metadata into it.
 * Returns true on success. Throws only on EEXIST (already held) — every other
 * fs error propagates (a real failure we must not mask).
 */
function tryCreateLock(dir: string): boolean {
  try {
    mkdirSync(dir); // atomic; NO { recursive: true } — recursive makes EEXIST silent.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  // We own the dir. Stamp ownership. If this write fails the dir still exists,
  // so the finally-release path (rmSync recursive) still cleans it up.
  const meta: LockMeta = { pid: process.pid, acquired_at: new Date().toISOString() };
  writeFileSync(join(dir, LOCK_META_NAME), JSON.stringify(meta) + "\n");
  return true;
}

/**
 * Acquire the single-flight lock.
 *
 * Returns true if we now hold it, false if another live copy holds it (caller
 * should exit 0 cleanly).
 *
 * Stale-lock recovery uses a COMPARE-AND-SWAP via atomic rename, NOT a naive
 * "rmSync(dir) then mkdir(dir)". The naive form has a corrupting race: two
 * stealers, or a stealer + a just-arrived fresh holder, can interleave such that
 * one stealer rmSync's a lock another process just freshly created, leaving TWO
 * processes both believing they own the lock. We avoid that:
 *
 *   1. Atomically rename the stale dir aside to a unique victim path. renameSync
 *      is atomic, so at most ONE stealer can move a given dir; a racing stealer
 *      gets ENOENT and falls through to a plain create (where mkdir arbitrates).
 *   2. After winning the rename, re-read the meta we physically moved. If its
 *      acquired_at no longer matches what we observed as stale, a fresh holder
 *      had re-created the dir and we renamed a LIVE lock by mistake — so we
 *      restore it (rename back) and bail. This is the CAS check: we only proceed
 *      if the thing we stole is the exact stale instance we decided to steal.
 *   3. Only then drop the old dir and re-create. mkdir remains the sole owner-
 *      ship arbiter, so a third racer that created dir in the meantime makes our
 *      mkdir EEXIST and we bail cleanly.
 *
 * Net: mkdir(dir) success is the ONE-AND-ONLY ownership signal, and no process
 * ever removes a `dir` it did not first atomically rename-away, so double-
 * acquire is impossible.
 */
function acquireLock(projectRoot: string): boolean {
  const dir = lockDirPath(projectRoot);

  if (tryCreateLock(dir)) return true;

  // Held by someone. Decide if it's stale. A missing/malformed meta (null) is
  // treated as stale ENOUGH to attempt a steal — the CAS below still protects a
  // live holder that simply hasn't finished stamping its meta yet.
  const meta = readLockMeta(dir);
  const ageMs = meta ? Date.now() - Date.parse(meta.acquired_at) : Infinity;
  const isStale = !meta || !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS;
  if (!isStale) return false; // fresh lock, real holder — bail cleanly.

  console.error(
    `[process-pair-log] Attempting steal of stale lock (age ${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + "s" : "unknown"}, pid ${meta?.pid ?? "?"})`,
  );

  const victim = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, victim); // atomic; only one stealer can win this move.
  } catch (err) {
    // ENOENT => another stealer already moved/removed it, or the holder released
    // it. Either way the dir slot may now be free or freshly taken; let mkdir
    // arbitrate. Any non-ENOENT error also falls through to the safe create.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("[process-pair-log] Stale-lock rename failed (falling back to create):", err);
    }
    return tryCreateLock(dir);
  }

  // CAS check: confirm what we moved is the SAME stale instance we observed. If
  // a fresh holder re-created `dir` between our staleness read and our rename, we
  // just moved their LIVE lock — restore it and bail rather than corrupt.
  const moved = readLockMeta(victim);
  const stillSameStale =
    // both null-meta: nothing changed underneath us (still the meta-less lock).
    (!meta && !moved) ||
    // both present and acquired_at identical: same instance we decided to steal.
    (!!meta && !!moved && moved.acquired_at === meta.acquired_at);
  if (!stillSameStale) {
    console.error("[process-pair-log] Lock changed under steal — restoring and bailing.");
    try {
      renameSync(victim, dir); // put it back for the rightful (fresh) holder.
    } catch {
      // Couldn't restore (a third party already re-created dir). Drop our copy.
      try {
        rmSync(victim, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return false;
  }

  // Confirmed stale. Discard the dead dir and re-create. mkdir is still the sole
  // arbiter: if a racer created `dir` after our rename, we EEXIST and bail.
  try {
    rmSync(victim, { recursive: true, force: true });
  } catch (err) {
    console.error("[process-pair-log] Could not delete stolen stale lock (continuing):", err);
  }
  return tryCreateLock(dir);
}

/** Release the lock we hold. Best-effort + idempotent — never throws. */
function releaseLock(projectRoot: string): void {
  try {
    rmSync(lockDirPath(projectRoot), { recursive: true, force: true });
  } catch (err) {
    console.error("[process-pair-log] WARNING: could not release lock (stale-steal will recover):", err);
  }
}

// --- parsing -------------------------------------------------------------

const OUTBOX_TYPE_BY_TAG: Record<string, string> = {
  FACT: "fact",
  PHEROMONE: "pheromone",
  GOTCHA: "gotcha",
  CONTRADICTION: "contradiction",
  RELEASE_FILES: "release_files",
  REINFORCED: "reinforced",
};

// `[OUTBOX:FACT] { ...json... }` — tag, then a JSON object on the same line.
const OUTBOX_RE = /\[OUTBOX:([A-Z_]+)\]\s*(\{.*\})\s*$/;
// Plain prose prefixes (per coder-auditor.md "Communication Rules"). These are
// best-effort: free text, not JSON. We map them to findings/contradictions.
const FACT_PREFIX_RE = /\[FACT\]\s*(.+)$/;
const GOTCHA_PREFIX_RE = /\[GOTCHA\]\s*(.+)$/;
const REINFORCED_PREFIX_RE = /\[REINFORCED\]\s*(.+)$/;
const CONTRADICTION_PREFIX_RE = /\[CONTRADICTION\]\s*(.+)$/;
const QUESTION_RE = /QUESTION FOR HUMAN:?\s*(.*)$/;
const PROCESSED_MARKER = "[SECRETARY:PROCESSED";

/** A parsed entry, tagged with its source log (source_file provenance + dedupe). */
interface ParsedLine {
  entry: OutboxEntry;
}

/**
 * Extract structured entries from a slice of log lines.
 * `sourceRel` is the relative log path, stamped as source_file so the
 * findings UNIQUE(title, source_file) constraint dedupes across re-runs.
 */
function parseLines(lines: string[], sourceRel: string): {
  parsed: ParsedLine[];
  parseErrors: number;
} {
  const parsed: ParsedLine[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. Structured [OUTBOX:*] {json}
    const ob = OUTBOX_RE.exec(trimmed);
    if (ob) {
      const tag = ob[1];
      const type = OUTBOX_TYPE_BY_TAG[tag];
      if (!type) {
        console.error(`[process-pair-log] Unknown OUTBOX tag: ${tag} — skipping`);
        parseErrors++;
        continue;
      }
      try {
        const obj = JSON.parse(ob[2]) as Record<string, unknown>;
        parsed.push({ entry: { type, source_file: sourceRel, ...obj } });
      } catch (err) {
        console.error(`[process-pair-log] Malformed OUTBOX JSON, skipping: ${trimmed.slice(0, 120)}`, err);
        parseErrors++;
      }
      continue;
    }

    // 2. Prose [FACT]/[GOTCHA]/[REINFORCED]/[CONTRADICTION]/QUESTION prefixes.
    //    These do NOT duplicate an [OUTBOX:*] line (an OUTBOX line is matched
    //    above and `continue`d), so the same fact written both ways on the same
    //    line is impossible. Different lines for the same fact dedupe via the
    //    UNIQUE(title, source_file) constraint at insert time.
    const reinforced = REINFORCED_PREFIX_RE.exec(trimmed);
    if (reinforced) {
      // Prose reinforce has no finding_id — record as a low-importance note so
      // the signal isn't lost, but it cannot UPDATE a row (needs an id).
      parsed.push({
        entry: {
          type: "reinforced_note",
          source_file: sourceRel,
          content: reinforced[1].trim(),
        },
      });
      continue;
    }
    const contradiction = CONTRADICTION_PREFIX_RE.exec(trimmed);
    if (contradiction) {
      parsed.push({
        entry: {
          type: "contradiction_note",
          source_file: sourceRel,
          content: contradiction[1].trim(),
        },
      });
      continue;
    }
    const fact = FACT_PREFIX_RE.exec(trimmed);
    if (fact) {
      parsed.push({
        entry: {
          type: "fact",
          source_file: sourceRel,
          title: deriveTitle(fact[1]),
          content: fact[1].trim(),
          confidence: "medium",
        },
      });
      continue;
    }
    const gotcha = GOTCHA_PREFIX_RE.exec(trimmed);
    if (gotcha) {
      parsed.push({
        entry: {
          type: "gotcha",
          source_file: sourceRel,
          title: deriveTitle(gotcha[1]),
          content: gotcha[1].trim(),
        },
      });
      continue;
    }
    const question = QUESTION_RE.exec(trimmed);
    if (question) {
      parsed.push({
        entry: { type: "question", source_file: sourceRel, content: trimmed },
      });
      continue;
    }
  }

  return { parsed, parseErrors };
}

/** Short title from a free-text prose line (first sentence/clause, capped). */
function deriveTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const cut = cleaned.split(/[.:—–-]/)[0].trim() || cleaned;
  return cut.length > 80 ? cut.slice(0, 77) + "..." : cut;
}

// --- DB writes (reusing initDb + storeEmbedding) -------------------------

interface DbHandle {
  // Minimal structural shape of the better-sqlite3 Database we rely on.
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
  };
  close(): void;
}

/**
 * Write one parsed entry. Mirrors the table contracts in write-and-sync.ts /
 * store.ts, and — unlike write-and-sync.ts — calls storeEmbedding() after each
 * finding/gotcha insert so semantic (vector) search stays consistent. Surfacing
 * (questions, prose-only contradictions/reinforces) is logged for the CEO, not
 * silently dropped. Returns the type key incremented (or "errors"/"skipped").
 */
async function writeEntry(
  db: DbHandle,
  entry: OutboxEntry,
  surfaced: string[],
): Promise<keyof WriteResults> {
  switch (entry.type) {
    case "fact": {
      const res = db
        .prepare(
          `INSERT INTO findings (title, content, type, confidence, importance, source_pair, source_file, tags)
           VALUES (?, ?, 'fact', ?, 0.6, ?, ?, ?)`,
        )
        .run(
          entry.title as string,
          entry.content as string,
          (entry.confidence as string) ?? "high",
          (entry.pair as string) ?? null,
          (entry.source_file as string) ?? null,
          entry.tags ? JSON.stringify(entry.tags) : null,
        );
      await storeEmbedding(db as never, res.lastInsertRowid, `${entry.title} ${entry.content}`);
      return "facts";
    }

    case "pheromone": {
      db.prepare(
        `INSERT INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, estimated_duration_minutes, rounds, findings_count, verdict_breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.verdict_breakdown ? JSON.stringify(entry.verdict_breakdown) : null,
      );
      return "pheromones";
    }

    case "gotcha": {
      const content = entry.evidence
        ? `${entry.content}\n\nEvidence: ${entry.evidence}`
        : (entry.content as string);
      const res = db
        .prepare(
          `INSERT INTO findings (title, content, type, confidence, importance, source_pair, source_file, tags)
           VALUES (?, ?, 'gotcha', 'high', 0.7, ?, ?, ?)`,
        )
        .run(
          entry.title as string,
          content,
          (entry.pair as string) ?? null,
          (entry.source_file as string) ?? null,
          entry.tags ? JSON.stringify(entry.tags) : null,
        );
      await storeEmbedding(db as never, res.lastInsertRowid, `${entry.title} ${content}`);
      return "gotchas";
    }

    case "contradiction": {
      db.prepare(
        `INSERT INTO contradictions (claim_a, source_a, claim_b, source_b, status)
         VALUES (?, ?, ?, ?, 'OPEN')`,
      ).run(
        entry.claim_a as string,
        entry.source_a as string,
        entry.claim_b as string,
        entry.source_b as string,
      );
      return "contradictions";
    }

    case "reinforced": {
      // Structured reinforce carries an explicit finding id (fact_id|finding_id).
      const id = (entry.finding_id as number) ?? (entry.fact_id as number);
      if (id == null) {
        surfaced.push(`reinforced (no id): ${JSON.stringify(entry).slice(0, 120)}`);
        return "skipped";
      }
      db.prepare(
        `UPDATE findings SET confidence_score = MIN(1.0, COALESCE(confidence_score,1.0) + 0.2),
           last_reinforced = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(id);
      return "reinforced";
    }

    case "release_files": {
      db.prepare(
        `UPDATE active_edits SET released_at = datetime('now'), status = 'merged'
         WHERE pair_id = ? AND released_at IS NULL`,
      ).run(entry.pair_id as string);
      return "released";
    }

    // Prose-only signals — surfaced to the CEO, never silently dropped, but not
    // structurally written (they lack the fields the structured forms require).
    case "reinforced_note":
    case "contradiction_note":
    case "question": {
      surfaced.push(`${entry.type}: ${String(entry.content).slice(0, 160)}`);
      return entry.type === "question" ? "questions" : "skipped";
    }

    default:
      console.error(`[process-pair-log] Unknown entry type: ${entry.type}`);
      return "errors";
  }
}

// --- per-log processing --------------------------------------------------

async function processLog(
  db: DbHandle,
  projectRoot: string,
  logPath: string,
  state: SecretaryState,
  opts: { allHistory: boolean; dryRun: boolean },
  surfaced: string[],
): Promise<LogResult> {
  const rel = relKey(projectRoot, logPath);
  const results = emptyResults();

  if (!existsSync(logPath)) {
    return { log: rel, linesScanned: 0, fromLine: 0, processed: false, reason: "missing", results };
  }

  const allLines = readFileSync(logPath, "utf8").split(/\r?\n/);
  const total = allLines.length;
  const prior = state[rel]?.lines ?? 0;

  // First-run backlog guard: a log we've never processed AND that has no
  // PROCESSED marker is AMBIGUOUS — it is either a freshly-created LIVE pair log
  // (whose first markers we DO want) or an OLD historical log (mass-ingest
  // hazard). We disambiguate by the file's mtime instead of forcing the caller
  // to pass --all-history:
  //   - mtime within BACKLOG_MTIME_WINDOW_MS  => LIVE  => fall through, ingest
  //     from line 0 (prior === 0), exactly as --all-history would for this log.
  //   - mtime older than the window           => stale => baseline-skip (set the
  //     mark at the current end so future entries are picked up).
  // --all-history remains an explicit override that forces full ingest here
  // regardless of mtime (it short-circuits this whole guard via the condition).
  const hasMarker = allLines.some((l) => l.includes(PROCESSED_MARKER));
  if (prior === 0 && !hasMarker && !opts.allHistory) {
    // mtimeMs via statSync. A stat failure (e.g. the file was deleted in the
    // race between existsSync above and here) is treated as "not recent" — the
    // conservative choice: never mass-ingest on an unreadable mtime. ageMs is
    // clamped at >= 0 so a clock-skewed future mtime still counts as recent.
    let ageMs = Infinity;
    try {
      ageMs = Math.max(0, Date.now() - statSync(logPath).mtimeMs);
    } catch (err) {
      console.error(`[process-pair-log] WARNING: statSync failed for ${rel}, treating as backlog:`, err);
    }
    // Boundary is inclusive (ageMs === window => LIVE) so "exactly at the
    // window" is deterministic: a log right on the edge is still processed.
    const isRecent = ageMs <= BACKLOG_MTIME_WINDOW_MS;
    if (!isRecent) {
      if (!opts.dryRun) {
        state[rel] = { lines: total, updated_at: new Date().toISOString() };
      }
      return {
        log: rel,
        linesScanned: 0,
        fromLine: 0,
        processed: false,
        reason: `backlog-skipped (no prior mark, no marker, mtime age ${Math.round(ageMs / 3600000)}h > window ${Math.round(BACKLOG_MTIME_WINDOW_MS / 3600000)}h; pass --all-history to force-ingest)`,
        results,
      };
    }
    // Recent => LIVE pair log: fall through and ingest from line 0.
  }

  const fromLine = prior;
  const slice = allLines.slice(fromLine);
  if (slice.length === 0) {
    return { log: rel, linesScanned: 0, fromLine, processed: true, reason: "up-to-date", results };
  }

  const { parsed, parseErrors } = parseLines(slice, rel);
  results.errors += parseErrors;

  if (opts.dryRun) {
    for (const p of parsed) tallyDry(p.entry, results, surfaced);
    return { log: rel, linesScanned: slice.length, fromLine, processed: false, reason: "dry-run", results };
  }

  for (const p of parsed) {
    try {
      const key = await writeEntry(db, p.entry, surfaced);
      results[key]++;
    } catch (err) {
      // UNIQUE(title, source_file) collisions (idempotent re-writes of the same
      // fact/gotcha) land here and are counted as skipped, not errors.
      const msg = String((err as Error)?.message ?? err);
      if (/UNIQUE constraint failed/i.test(msg)) {
        results.skipped++;
      } else {
        console.error(`[process-pair-log] Error writing ${p.entry.type} from ${rel}:`, err);
        results.errors++;
      }
    }
  }

  // Always advance the high-water mark past the lines we scanned, so the same
  // lines are never re-processed. Only APPEND a PROCESSED marker when there was
  // something to process — a no-op scan (e.g. lines added by a previous marker,
  // or non-OUTBOX prose) must not litter the log with "0 entries" markers or
  // make the mark oscillate. When we do append, the marker adds 2 lines
  // (leading "\n" + the marker line); account for them so the next run starts
  // clean past the marker. (append-only; never mutate existing log content.)
  if (parsed.length > 0) {
    const counted =
      results.facts + results.pheromones + results.gotchas + results.contradictions + results.reinforced + results.released;
    appendFileSync(
      logPath,
      `\n[SECRETARY:PROCESSED] ${counted} entries (lines ${fromLine + 1}-${total}) at ${new Date().toISOString()}\n`,
    );
    // total lines after append: original `total` + the "\n" split boundary +
    // marker line. readFileSync(...).split adds one element per newline; the
    // appended "\n...marker...\n" contributes 2 new array elements.
    state[rel] = { lines: total + 2, updated_at: new Date().toISOString() };
  } else {
    state[rel] = { lines: total, updated_at: new Date().toISOString() };
  }

  return { log: rel, linesScanned: slice.length, fromLine, processed: true, results };
}

function tallyDry(entry: OutboxEntry, results: WriteResults, surfaced: string[]): void {
  switch (entry.type) {
    case "fact": results.facts++; break;
    case "pheromone": results.pheromones++; break;
    case "gotcha": results.gotchas++; break;
    case "contradiction": results.contradictions++; break;
    case "reinforced":
      if ((entry.finding_id ?? entry.fact_id) == null) results.skipped++;
      else results.reinforced++;
      break;
    case "release_files": results.released++; break;
    case "question": results.questions++; surfaced.push(`question: ${String(entry.content).slice(0, 160)}`); break;
    case "reinforced_note":
    case "contradiction_note": results.skipped++; surfaced.push(`${entry.type}: ${String(entry.content).slice(0, 160)}`); break;
    default: results.errors++;
  }
}

// --- arg parsing ---------------------------------------------------------

interface CliArgs {
  projectRoot?: string;
  pair?: string;
  log?: string;
  positional?: string;
  allHistory: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { allHistory: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pair") {
      // Validate eagerly: a bare `--pair` (missing value), `--pair ""`, or
      // `--pair --dry-run` (value swallows the next flag) would otherwise build
      // `pair-undefined.md` / `pair-.md` / `pair---dry-run.md` and then fail
      // opaquely in resolveLogPathSafe. Fail fast with a clear message instead.
      const val = argv[++i];
      if (val === undefined || val.trim() === "" || val.startsWith("--")) {
        throw new Error(
          `--pair requires a non-empty pair id (e.g. --pair 3); got ${val === undefined ? "no value" : JSON.stringify(val)}`,
        );
      }
      args.pair = val;
    } else if (a === "--log") args.log = argv[++i];
    else if (a === "--project") args.projectRoot = argv[++i];
    else if (a === "--all-history") args.allHistory = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (!a.startsWith("--") && args.positional === undefined) args.positional = a;
  }
  return args;
}

/**
 * Decide which logs to process from CLI args. A positional arg is either the
 * project root (a directory / contains .team11) or a single log file.
 */
function resolveTargets(args: CliArgs): { projectRoot: string; logs: string[] } {
  // A positional that points at a .md file is a single-log target; otherwise
  // it's the project root (matches the secretary.md hook command shape, which
  // passes ${CLAUDE_PROJECT_DIR}).
  let projectRootHint = args.projectRoot;
  let singleLog = args.log;

  if (args.positional) {
    if (args.positional.endsWith(".md")) {
      singleLog = singleLog ?? args.positional;
    } else {
      projectRootHint = projectRootHint ?? args.positional;
    }
  }

  const projectRoot = findProjectRoot(projectRootHint);

  if (singleLog) {
    return { projectRoot, logs: [resolveLogPathSafe(projectRoot, singleLog)] };
  }
  if (args.pair) {
    // ".team11" — plain segment, NOT an escape. The previous "\.team11" read as
    // a backslash-escape; `\.` is an unknown JS escape that collapses to ".", so
    // the resolved path was unchanged but the source was misleading. Use the
    // posix separator-free segment and let join() insert the platform separator.
    const candidate = join(".team11", "logs", `pair-${args.pair}.md`);
    return { projectRoot, logs: [resolveLogPathSafe(projectRoot, candidate)] };
  }
  return { projectRoot, logs: discoverPairLogs(projectRoot) };
}

// --- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { projectRoot, logs } = resolveTargets(args);
  const dbPath = join(projectRoot, ".team11", "memory.db");

  // 0. Single-flight lock (write path only). --dry-run is read-only: it never
  //    takes the lock, so it can never block a real run nor be blocked by one.
  //    If another live copy holds the lock we exit 0 cleanly (NOT an error): the
  //    holder scans every log, so this copy bailing loses no markers. The hook
  //    that fires us must see exit 0 here, not a spurious failure.
  if (!args.dryRun && !acquireLock(projectRoot)) {
    console.log(JSON.stringify({ skipped: "lock-held" }));
    return;
  }

  // Everything below mutates shared state (SQLite DB, logs, high-water mark) and
  // MUST run under the lock. try/finally guarantees the lock is released even if
  // processing throws; a hard crash that skips finally is covered by the 120s
  // stale-steal in acquireLock(). --dry-run never acquired, so it never releases.
  try {
    // 1. Init DB (ensures ALL tables exist) — reused from db.ts.
    const db = initDb(dbPath) as unknown as DbHandle;
    console.error(`[process-pair-log] DB: ${dbPath}`);

    // 2. Embeddings + Turso sync (best-effort; carrier still works without them).
    //    initEmbeddings lets storeEmbedding actually populate the vector index;
    //    write-and-sync.ts omits this, which is why findings written there are not
    //    vector-searchable until the next seed run.
    if (!args.dryRun) {
      await initEmbeddings();
    }
    const syncConfig = args.dryRun ? null : loadSyncConfig(projectRoot);
    if (syncConfig) {
      await initSync(dbPath, syncConfig);
      console.error("[process-pair-log] Turso sync connected");
    }

    // 3. Process each target log.
    const state = loadState(projectRoot);
    const surfaced: string[] = [];
    const perLog: LogResult[] = [];
    for (const logPath of logs) {
      try {
        perLog.push(await processLog(db, projectRoot, logPath, state, args, surfaced));
      } catch (err) {
        console.error(`[process-pair-log] Failed on ${logPath}:`, err);
        perLog.push({
          log: relKey(projectRoot, logPath),
          linesScanned: 0,
          fromLine: 0,
          processed: false,
          reason: `error: ${String((err as Error)?.message ?? err)}`,
          results: emptyResults(),
        });
      }
    }

    // 4. Persist state + push sync.
    if (!args.dryRun) {
      saveState(projectRoot, state);
      if (syncConfig) {
        await forceSync();
        console.error("[process-pair-log] Turso sync pushed");
      }
    }

    // 5. Aggregate + report (stdout = machine-readable JSON; stderr = human log).
    const totals = emptyResults();
    for (const r of perLog) {
      for (const k of Object.keys(totals) as (keyof WriteResults)[]) totals[k] += r.results[k];
    }
    console.log(
      JSON.stringify({
        dryRun: args.dryRun,
        logsTargeted: logs.length,
        logsProcessed: perLog.filter((r) => r.processed).length,
        totals,
        surfaced, // QUESTION FOR HUMAN / prose contradictions/reinforces for CEO
        perLog,
      }),
    );

    // 6. Clean up.
    if (!args.dryRun) shutdownSync();
    db.close();
  } finally {
    if (!args.dryRun) releaseLock(projectRoot);
  }
}

main().catch((err) => {
  console.error("[process-pair-log] Fatal:", err);
  process.exit(1);
});
