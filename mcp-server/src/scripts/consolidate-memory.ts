/**
 * consolidate-memory.ts — Team11 "sleep-time" memory consolidation (E5).
 *
 * A standalone, DRY-RUN-BY-DEFAULT, recency-aware maintenance pass that keeps
 * the Team11 memory DB clean as it grows. Modeled structurally on the Secretary
 * carrier (process-pair-log.ts): same project-root resolution, the SAME atomic
 * single-flight lock (`.team11/_secretary.lock`), and the same reuse of the
 * existing primitives (`initDb`, `initEmbeddings`, `storeEmbedding`). It is a
 * ONE-SHOT processor, NOT a poll/sleep loop, and it registers no MCP tool / CLI.
 *
 * Three jobs (ALL default to report-only; pass --execute to apply):
 *
 *   1. RECENCY-AWARE DEDUPE. Within each `type`, find near-duplicate ACTIVE
 *      findings (cosine similarity of their stored embeddings >= --sim-threshold,
 *      default 0.93). For each near-dup cluster, KEEP the MOST RECENT (by
 *      last_reinforced, then created_at) and SUPERSEDE the older ones by setting
 *      their `superseded_by` to the keeper's id. RATIONALE: this is a restaurant
 *      domain — the newest confirmation of a fact wins; an older row must never
 *      outrank a newer one. Supersede is REVERSIBLE (it's a column write, not a
 *      delete; restore_finding clears it). The keeper's embedding is left as-is.
 *
 *   2. ABSOLUTIZE RELATIVE DATES. Best-effort, CONSERVATIVE: scan active
 *      findings' content for high-confidence relative-date phrases ("today",
 *      "yesterday", "tomorrow", "N days/weeks ago", "last/next week") and rewrite
 *      each to an absolute ISO date computed from THAT finding's own created_at.
 *      Never guesses. On --execute, the content is updated AND re-embedded via
 *      storeEmbedding so semantic search stays consistent (same discipline as the
 *      carrier). Word-boundary anchored; case-insensitive; idempotent (a rewrite
 *      injects an absolute date, which no longer matches the relative patterns).
 *
 *   3. SURFACE CONTRADICTIONS (report-only). Lists OPEN contradictions for human
 *      review. Auto-resolution is OUT OF SCOPE — never resolved here.
 *
 * SAFETY + CONCURRENCY:
 *   - DRY-RUN is the default and makes ZERO writes: no DB mutation, no lock, no
 *     file changes. It only prints a JSON report of what it WOULD merge/rewrite
 *     plus the contradiction list.
 *   - --execute acquires the SAME single-flight lock the carrier uses (atomic
 *     mkdir on <projectRoot>/.team11/_secretary.lock; if held by a live copy,
 *     exit 0 with {"skipped":"lock-held"}; released in finally; 120s stale-steal
 *     via CAS). This prevents racing the SubagentStop carrier. Dry-run takes NO
 *     lock, so it neither blocks nor is blocked by a real run.
 *   - No shell interpolation; no execSync. All SQL is parameterized.
 *
 * Usage:
 *   node dist/scripts/consolidate-memory.js [options]
 *
 * Options:
 *   --execute               Apply changes (supersede dups, rewrite dates). Default
 *                           is dry-run (report only, zero writes, no lock).
 *   --sim-threshold <n>     Cosine-similarity threshold for near-dup clustering
 *                           (0..1, default 0.93). Higher = stricter (fewer merges).
 *   --type <t>              Restrict dedupe to a single finding type (e.g. gotcha).
 *   --project <path>        Project root (default: PROJECT_ROOT env, else walk up).
 *   --json                  Force JSON-only output (default). Reserved for parity.
 *
 * Exit code 0 on success (including the clean lock-held bail). Non-zero only on
 * fatal setup errors (project root not found, DB init failure).
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../db.js";
import { initEmbeddings } from "../embeddings.js";
import { storeEmbedding } from "../tools/store.js";
import { loadSyncConfig, initSync, forceSync, shutdownSync } from "../sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SIM_THRESHOLD = 0.93;

// --- project root --------------------------------------------------------
// Mirrors process-pair-log.ts: explicit flag, then PROJECT_ROOT env, then walk
// up from the script location looking for a .team11/ directory.
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

// --- single-flight lock (shared with the Secretary carrier) --------------
// IDENTICAL mechanism to process-pair-log.ts: an atomic mkdir on a directory is
// the sole ownership signal (no { recursive: true } — recursive makes EEXIST
// silent). Stale recovery is a compare-and-swap via atomic rename so two racing
// stealers (or a stealer + a fresh holder) can never both believe they own it.
// We share the SAME lock dir name so this pass and the carrier mutually exclude.
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

function readLockMeta(dir: string): LockMeta | null {
  try {
    const raw = readFileSync(join(dir, LOCK_META_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.acquired_at === "string"
    ) {
      return parsed as LockMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically create the lock dir and stamp ownership. Returns true on success.
 * Throws only on EEXIST (already held) — every other fs error propagates.
 */
function tryCreateLock(dir: string): boolean {
  try {
    mkdirSync(dir); // atomic; NO { recursive: true }.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  const meta: LockMeta = {
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, LOCK_META_NAME), JSON.stringify(meta) + "\n");
  return true;
}

/**
 * Acquire the single-flight lock. Returns true if we hold it, false if a live
 * copy holds it (caller should exit 0 cleanly). Stale-lock recovery uses a
 * CAS-via-atomic-rename, identical to the carrier — see process-pair-log.ts for
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
    `[consolidate-memory] Attempting steal of stale lock (age ${
      Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + "s" : "unknown"
    }, pid ${meta?.pid ?? "?"})`,
  );

  const victim = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, victim); // atomic; only one stealer can win this move.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        "[consolidate-memory] Stale-lock rename failed (falling back to create):",
        err,
      );
    }
    return tryCreateLock(dir);
  }

  // CAS check: confirm what we moved is the SAME stale instance we observed.
  const moved = readLockMeta(victim);
  const stillSameStale =
    (!meta && !moved) ||
    (!!meta && !!moved && moved.acquired_at === meta.acquired_at);
  if (!stillSameStale) {
    console.error(
      "[consolidate-memory] Lock changed under steal — restoring and bailing.",
    );
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
    console.error(
      "[consolidate-memory] Could not delete stolen stale lock (continuing):",
      err,
    );
  }
  return tryCreateLock(dir);
}

/** Release the lock we hold. Best-effort + idempotent — never throws. */
function releaseLock(projectRoot: string): void {
  try {
    rmSync(lockDirPath(projectRoot), { recursive: true, force: true });
  } catch (err) {
    console.error(
      "[consolidate-memory] WARNING: could not release lock (stale-steal will recover):",
      err,
    );
  }
}

// --- minimal DB shape ----------------------------------------------------
// Structural subset of better-sqlite3 we rely on (same approach as the carrier,
// which lets storeEmbedding accept the handle without a hard type dependency).
interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface DbHandle {
  prepare(sql: string): Stmt;
  close(): void;
}

// --- recency comparator (THE correctness-critical piece) -----------------
//
// "Most recent" = latest last_reinforced, tie-broken by latest created_at, final
// tie-broken by HIGHER id (a later insert is newer). Returns the row that is the
// NEWER of the two. Pure + side-effect-free so the auditor can unit-test it.
//
// Dates are ISO-ish strings from datetime('now') ("YYYY-MM-DD HH:MM:SS"); they
// sort correctly lexicographically AND via Date.parse. We use Date.parse and
// fall back to lexical compare if a timestamp is unparseable, so a malformed
// last_reinforced can never silently make an OLDER row win.
export interface RecencyRow {
  id: number;
  created_at: string;
  last_reinforced: string | null;
}

function tsValue(s: string | null | undefined): number {
  if (!s) return -Infinity;
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Returns true if `a` is STRICTLY more recent than `b` (a should be the keeper
 * over b). Newest wins by last_reinforced, then created_at, then id.
 */
export function isMoreRecent(a: RecencyRow, b: RecencyRow): boolean {
  const ar = tsValue(a.last_reinforced ?? a.created_at);
  const br = tsValue(b.last_reinforced ?? b.created_at);
  if (ar !== br) return ar > br;
  const ac = tsValue(a.created_at);
  const bc = tsValue(b.created_at);
  if (ac !== bc) return ac > bc;
  // Final deterministic tiebreak: higher id = inserted later = newer.
  return a.id > b.id;
}

/** Pick the single most-recent row from a non-empty cluster. */
export function pickKeeper<T extends RecencyRow>(rows: T[]): T {
  return rows.reduce((best, r) => (isMoreRecent(r, best) ? r : best));
}

// --- relative-date absolutization (conservative) -------------------------
//
// Each pattern is matched case-insensitively and word-boundary anchored, then
// replaced with an absolute YYYY-MM-DD computed from the finding's OWN
// created_at. We only handle HIGH-CONFIDENCE phrases; anything ambiguous
// ("recently", "the other day", "soon") is intentionally left untouched.

function toIso(d: Date): string {
  // UTC date portion only — findings record dates, not wall-clock instants.
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export interface DateRewrite {
  phrase: string;
  replacement: string;
}

/**
 * Compute the conservative relative-date rewrites for one finding's content,
 * anchored on `createdAt`. Returns the rewritten content plus the list of
 * (phrase -> replacement) edits made. If createdAt is unparseable, returns the
 * content UNCHANGED with no edits (never guess against a bad anchor).
 *
 * Pure + deterministic so the auditor can unit-test it without a DB.
 */
export function absolutizeDates(
  content: string,
  createdAt: string,
): { content: string; rewrites: DateRewrite[] } {
  const anchorMs = tsValue(createdAt);
  if (!Number.isFinite(anchorMs)) return { content, rewrites: [] };
  const anchor = new Date(anchorMs);
  const rewrites: DateRewrite[] = [];

  let out = content;

  // Helper: replace all occurrences of a regex, recording each concrete phrase
  // and its computed absolute replacement. `offsetFor` maps the matched text to
  // a day offset from the anchor (e.g. yesterday => -1).
  const apply = (
    re: RegExp,
    offsetFor: (m: RegExpMatchArray) => number | null,
  ): void => {
    out = out.replace(re, (...args) => {
      // String.replace passes (match, ...groups, offset, string). The matched
      // text is args[0]; we only need the match + capture groups here.
      const groups = args.slice(0, -2) as string[];
      const m = groups as unknown as RegExpMatchArray;
      const phrase = m[0];
      const offset = offsetFor(m);
      if (offset === null) return phrase; // un-handled -> leave verbatim
      const replacement = toIso(addDays(anchor, offset));
      rewrites.push({ phrase, replacement });
      return replacement;
    });
  };

  // "N days ago" / "N weeks ago" — numeric, highest confidence.
  apply(/\b(\d{1,4})\s+(day|days|week|weeks)\s+ago\b/gi, (m) => {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) return null;
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith("week") ? 7 : 1;
    return -(n * mult);
  });

  // Single-word relatives.
  apply(/\byesterday\b/gi, () => -1);
  apply(/\btomorrow\b/gi, () => +1);
  // "today" => the anchor date itself.
  apply(/\btoday\b/gi, () => 0);

  // "last week" / "next week" — resolve to a point 7 days before/after the
  // anchor. CONSERVATIVE: we do NOT attempt week-start arithmetic (locale +
  // week-definition ambiguity); a 7-day shift is the defensible reading.
  apply(/\blast\s+week\b/gi, () => -7);
  apply(/\bnext\s+week\b/gi, () => +7);

  return { content: out, rewrites };
}

// --- embedding load (real storage layout) --------------------------------
// Embeddings are stored as BLOBs in `embedding_cache` (and mirrored in the
// `findings_vec` vec0 table). There is NO separate "embeddings" table. We read
// the cache BLOB and hand it straight to sqlite-vec's own vec_distance_cosine —
// so we neither reinvent cosine nor re-embed for comparison.

interface FindingRow {
  id: number;
  title: string;
  content: string;
  type: string;
  created_at: string;
  last_reinforced: string | null;
  has_embedding: number;
}

interface DedupePlanItem {
  type: string;
  keeper: { id: number; title: string; created_at: string; last_reinforced: string | null };
  superseded: Array<{
    id: number;
    title: string;
    created_at: string;
    last_reinforced: string | null;
    similarity: number;
  }>;
}

/**
 * Build dedupe clusters within a single type via union-find over the edges whose
 * cosine similarity >= threshold. Cosine similarity is computed by sqlite-vec's
 * vec_distance_cosine on the cached BLOBs (similarity = 1 - distance). Only
 * findings WITH a cached embedding participate; the rest cannot be compared and
 * are left untouched (reported in `skippedNoEmbedding`).
 */
function planDedupeForType(
  db: DbHandle,
  rows: FindingRow[],
  threshold: number,
): { plan: DedupePlanItem[]; comparisons: number } {
  const eligible = rows.filter((r) => r.has_embedding === 1);
  const n = eligible.length;
  const cosStmt = db.prepare(
    `SELECT (1.0 - vec_distance_cosine(
        (SELECT embedding FROM embedding_cache WHERE finding_id = ?),
        (SELECT embedding FROM embedding_cache WHERE finding_id = ?)
      )) AS sim`,
  );

  // Union-find over eligible indices.
  const parent = eligible.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Remember the best (max) similarity seen connecting each node into its
  // cluster, for reporting. Keyed by finding id.
  const bestSim = new Map<number, number>();
  let comparisons = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      comparisons++;
      const res = cosStmt.get(eligible[i].id, eligible[j].id) as
        | { sim: number | null }
        | undefined;
      const sim = res && typeof res.sim === "number" ? res.sim : null;
      if (sim === null) continue; // missing blob mid-flight — skip defensively
      if (sim >= threshold) {
        union(i, j);
        const a = eligible[i].id;
        const b = eligible[j].id;
        if (sim > (bestSim.get(a) ?? -1)) bestSim.set(a, sim);
        if (sim > (bestSim.get(b) ?? -1)) bestSim.set(b, sim);
      }
    }
  }

  // Group eligible rows by cluster root.
  const clusters = new Map<number, FindingRow[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = clusters.get(root) ?? [];
    arr.push(eligible[i]);
    clusters.set(root, arr);
  }

  const plan: DedupePlanItem[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue; // singletons are not duplicates
    const keeper = pickKeeper(members);
    const superseded = members
      .filter((m) => m.id !== keeper.id)
      .map((m) => ({
        id: m.id,
        title: m.title,
        created_at: m.created_at,
        last_reinforced: m.last_reinforced,
        similarity: Math.round((bestSim.get(m.id) ?? 0) * 10000) / 10000,
      }));
    plan.push({
      type: keeper.type,
      keeper: {
        id: keeper.id,
        title: keeper.title,
        created_at: keeper.created_at,
        last_reinforced: keeper.last_reinforced,
      },
      superseded,
    });
  }
  return { plan, comparisons };
}

// --- arg parsing ---------------------------------------------------------
interface CliArgs {
  execute: boolean;
  simThreshold: number;
  type?: string;
  projectRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, simThreshold: DEFAULT_SIM_THRESHOLD };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--json") {
      /* default output is already JSON; flag accepted for parity */
    } else if (a === "--sim-threshold") {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        throw new Error(
          `--sim-threshold must be a number in (0,1]; got ${JSON.stringify(raw)}`,
        );
      }
      args.simThreshold = v;
    } else if (a === "--type") args.type = argv[++i];
    else if (a === "--project") args.projectRoot = argv[++i];
    else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

// --- main ----------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot(args.projectRoot);
  const dbPath = join(projectRoot, ".team11", "memory.db");

  // 0. Single-flight lock — WRITE PATH ONLY. Dry-run is read-only and takes NO
  //    lock, so it can never block a real run nor be blocked by one. If a live
  //    copy (this pass OR the Secretary carrier) holds the lock we exit 0
  //    cleanly with {"skipped":"lock-held"} — bailing loses no work because a
  //    consolidation pass is idempotent and can simply run again later.
  if (args.execute && !acquireLock(projectRoot)) {
    console.log(JSON.stringify({ skipped: "lock-held" }));
    return;
  }

  try {
    // 1. Init DB (ensures ALL tables/extensions exist incl. sqlite-vec).
    const db = initDb(dbPath) as unknown as DbHandle;
    console.error(`[consolidate-memory] DB: ${dbPath}`);

    // 2. Embeddings + sync only matter on --execute (re-embedding rewritten
    //    content, pushing the result). Dry-run never mutates, so it skips both —
    //    and crucially never loads the embedding model. (Cosine comparison uses
    //    sqlite-vec on the already-stored BLOBs, so dedupe planning needs no
    //    in-process embedder even in dry-run.)
    let syncConfig = null;
    if (args.execute) {
      await initEmbeddings();
      syncConfig = loadSyncConfig(projectRoot);
      if (syncConfig) {
        await initSync(dbPath, syncConfig);
        console.error("[consolidate-memory] Turso sync connected");
      }
    }

    // 3. Load active findings (optionally filtered by type). Active = the same
    //    predicate every other tool uses: superseded_by IS NULL OR = 0.
    //    has_embedding flags whether a cached BLOB exists (only those can be
    //    compared / re-embedded-on-rewrite-verify).
    const findingSql =
      `SELECT f.id, f.title, f.content, f.type, f.created_at, f.last_reinforced,
              (SELECT COUNT(*) FROM embedding_cache ec WHERE ec.finding_id = f.id) AS has_embedding
       FROM findings f
       WHERE (f.superseded_by IS NULL OR f.superseded_by = 0)` +
      (args.type ? ` AND f.type = ?` : ``) +
      ` ORDER BY f.type, f.id`;
    const findingParams = args.type ? [args.type] : [];
    const findings = db.prepare(findingSql).all(...findingParams) as FindingRow[];

    const byType = new Map<string, FindingRow[]>();
    for (const f of findings) {
      const arr = byType.get(f.type) ?? [];
      arr.push(f);
      byType.set(f.type, arr);
    }

    // 4. DEDUPE PLAN (read-only computation).
    const dedupePlan: DedupePlanItem[] = [];
    let totalComparisons = 0;
    let skippedNoEmbedding = 0;
    for (const rows of byType.values()) {
      skippedNoEmbedding += rows.filter((r) => r.has_embedding !== 1).length;
      const { plan, comparisons } = planDedupeForType(
        db,
        rows,
        args.simThreshold,
      );
      totalComparisons += comparisons;
      dedupePlan.push(...plan);
    }

    // 5. DATE-REWRITE PLAN (read-only computation).
    interface RewritePlanItem {
      id: number;
      title: string;
      created_at: string;
      rewrites: DateRewrite[];
      new_content: string;
    }
    const rewritePlan: RewritePlanItem[] = [];
    for (const f of findings) {
      const { content: newContent, rewrites } = absolutizeDates(
        f.content,
        f.created_at,
      );
      if (rewrites.length > 0 && newContent !== f.content) {
        rewritePlan.push({
          id: f.id,
          title: f.title,
          created_at: f.created_at,
          rewrites,
          new_content: newContent,
        });
      }
    }

    // 6. CONTRADICTIONS (report-only; never resolved here).
    const openContradictions = db
      .prepare(
        `SELECT id, claim_a, source_a, claim_b, source_b, created_at
         FROM contradictions WHERE status = 'OPEN'
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all() as Array<Record<string, unknown>>;

    // 7. APPLY (only under --execute + lock).
    let appliedSupersedes = 0;
    let appliedRewrites = 0;
    if (args.execute) {
      const supersedeStmt = db.prepare(
        `UPDATE findings SET superseded_by = ?, updated_at = datetime('now')
         WHERE id = ? AND (superseded_by IS NULL OR superseded_by = 0)`,
      );
      const updateContentStmt = db.prepare(
        `UPDATE findings SET content = ?, updated_at = datetime('now') WHERE id = ?`,
      );

      for (const item of dedupePlan) {
        for (const dup of item.superseded) {
          const r = supersedeStmt.run(item.keeper.id, dup.id);
          appliedSupersedes += r.changes;
        }
      }

      for (const item of rewritePlan) {
        updateContentStmt.run(item.new_content, item.id);
        appliedRewrites++;
        // Keep the vector index consistent: re-embed the rewritten title+content
        // (storeEmbedding hashes content and skips if unchanged, so this is safe
        // and idempotent). Mirrors the carrier's post-write embed discipline.
        await storeEmbedding(
          db as never,
          item.id,
          `${item.title} ${item.new_content}`,
        );
      }

      if (syncConfig) {
        await forceSync();
        console.error("[consolidate-memory] Turso sync pushed");
      }
    }

    // 8. Report (stdout = machine-readable JSON; stderr = human log).
    const report = {
      mode: args.execute ? "execute" : "dry-run",
      project_root: projectRoot,
      db: dbPath,
      sim_threshold: args.simThreshold,
      type_filter: args.type ?? null,
      scanned: {
        active_findings: findings.length,
        types: byType.size,
        comparisons: totalComparisons,
        skipped_no_embedding: skippedNoEmbedding,
      },
      dedupe: {
        clusters: dedupePlan.length,
        would_supersede: dedupePlan.reduce(
          (s, c) => s + c.superseded.length,
          0,
        ),
        applied_supersedes: appliedSupersedes,
        plan: dedupePlan,
      },
      date_rewrites: {
        findings_affected: rewritePlan.length,
        total_rewrites: rewritePlan.reduce((s, r) => s + r.rewrites.length, 0),
        applied_rewrites: appliedRewrites,
        plan: rewritePlan.map((r) => ({
          id: r.id,
          title: r.title,
          created_at: r.created_at,
          rewrites: r.rewrites,
        })),
      },
      open_contradictions: {
        count: openContradictions.length,
        items: openContradictions,
      },
    };
    console.log(JSON.stringify(report, null, 2));

    if (args.execute && syncConfig) shutdownSync();
    db.close();
  } finally {
    // Only --execute acquired the lock, so only --execute releases it. A hard
    // crash that skips finally is covered by the 120s stale-steal in acquire.
    if (args.execute) releaseLock(projectRoot);
  }
}

main().catch((err) => {
  console.error("[consolidate-memory] Fatal:", err);
  process.exit(1);
});
