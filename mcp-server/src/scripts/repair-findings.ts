/**
 * repair-findings.ts — one-off backfill of the memory DB (Team11 plan
 * 2026-08-23 P0.2 + P0.3, operator decision D9).
 *
 * Two repairs over EXISTING `findings` rows (the carrier fix in
 * process-pair-log.ts only stops the bleeding for new rows):
 *
 *   (a) TITLES. The old `deriveTitle` split on the character class
 *       `[.:—–-]`, so any hyphen/colon/dot INSIDE a token cut the title mid-
 *       word ("Text-containment…" → "Text", "hive.md is stale" → "hive").
 *       Candidate rows are: `length(title) < 12`, OR a title that is a prefix
 *       of its own content and is immediately followed there by a separator
 *       glued to the next token (`-x` `.x` `:x`) — the exact signature of the
 *       bug at any length, OR a title with an odd number of backticks (cut
 *       inside a code span). The title is regenerated from the row's own
 *       `content` with the NEW shared `deriveTitle` (src/log-derive.ts); a row
 *       whose regenerated title equals the stored one is reported as
 *       "unchanged" and is NOT counted as a candidate.
 *   (b) PROVENANCE. `source_pair` is NULL on 99% of rows because the carrier
 *       only ever stamped the `pair` field of structured [OUTBOX:*] JSON.
 *       Rows with a NULL `source_pair` and a `.team11/logs/<name>.md`
 *       `source_file` get `<name>` (pair-occdiet.md → pair-occdiet,
 *       audit-harness-r1.md → audit-harness-r1) via the shared
 *       `pairIdFromLogPath`. Other `source_file` shapes are reported as
 *       "unmapped" and left alone.
 *
 * Constraints handled:
 *   - UNIQUE(title, source_file): a regenerated title that would collide with
 *     another row (in the DB or earlier in this batch) gets " (#<id>)" appended.
 *   - findings_fts: the live DB has the `findings_au` AFTER UPDATE trigger
 *     (external-content fts5 `content=findings`), so a plain UPDATE keeps the
 *     FTS index in step. Verified after --execute with fts5's
 *     'integrity-check' command, which THROWS on any index/content mismatch.
 *   - Embeddings are RESUMABLE (audit round 1, major 2). Vectors were built
 *     from `${title} ${content}` at insert and `embedding_cache.content_hash`
 *     records which text each vector encodes. After the write transaction the
 *     script selects every findings row whose cache hash differs from
 *     sha256(`${title} ${content}`) (or has no cache row) — that set is exactly
 *     "rows whose vector is stale", whatever left them stale: this run's
 *     re-titling, a previous run aborted mid-loop, or the model failing — and
 *     regenerates those. A rerun therefore finishes the vectors instead of
 *     reporting `to_update 0`; a further rerun is a no-op. `--no-embeddings`
 *     skips the pass (the stale count is still reported so nothing is silent).
 *     NOTE: this exposed a latent bug in tools/store.ts — vec0 rejects
 *     `INSERT OR REPLACE` on an existing finding_id — fixed there 2026-08-24.
 *   - Concurrency: `--execute` takes the carrier's single-flight lock
 *     (`.team11/_secretary.lock`, same atomic-mkdir protocol as
 *     process-pair-log.ts) so a SubagentStop-triggered carrier cannot write the
 *     same WAL DB mid-repair, and re-stamps the lock every 200 embeddings so
 *     the carrier's 120 s stale-steal never fires during a long pass. If the
 *     lock is held the script refuses and says so — retry when no pair is
 *     finishing.
 *   - `updated_at` / `last_reinforced` are NOT touched: scoring.ts ranks
 *     recency on `updated_at ?? created_at`, so bumping ~2,500 old rows would
 *     push them to the top of every recall. A title/provenance fix is not
 *     new knowledge.
 *
 * Usage:
 *   node dist/scripts/repair-findings.js [--project <root>] [--sample N]        # DRY RUN (default)
 *   node dist/scripts/repair-findings.js --execute [--no-embeddings]            # write
 *
 * stdout: one JSON report (counts per category + sample before/after titles +
 * embeddings stale/regenerated counts). stderr: progress. Exit 0 on success,
 * 1 on fatal error (the write transaction is all-or-nothing; the embeddings
 * pass resumes on the next run).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { initDb } from "../db.js";
import { storeEmbedding } from "../tools/store.js";
import { initEmbeddings, embeddingsAvailable } from "../embeddings.js";
import { deriveTitle, pairIdFromLogPath } from "../log-derive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The audit's garbage-title predicate: `length(title) < 12`. */
const SHORT_TITLE_MAX = 12;
/** Only log-derived provenance is backfilled; anything else is reported as unmapped. */
const LOG_SOURCE_RE = /(^|\/)\.team11\/logs\/[^/]+\.md$/;
/** Carrier lock (must match process-pair-log.ts). */
const LOCK_DIR_NAME = "_secretary.lock";
const LOCK_META_NAME = "owner.json";
const LOCK_HEARTBEAT_EVERY = 200;

interface Args {
  projectRoot?: string;
  execute: boolean;
  embeddings: boolean;
  sample: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, embeddings: true, sample: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--dry-run") args.execute = false;
    else if (a === "--no-embeddings") args.embeddings = false;
    else if (a === "--project") args.projectRoot = argv[++i];
    else if (a === "--sample") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--sample wants a non-negative integer, got ${argv[i]}`);
      args.sample = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

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

// --- carrier lock (mirror of process-pair-log.ts, refuse-instead-of-steal) ---

function lockDir(projectRoot: string): string {
  return join(projectRoot, ".team11", LOCK_DIR_NAME);
}

function stampLock(dir: string): void {
  writeFileSync(
    join(dir, LOCK_META_NAME),
    JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), holder: "repair-findings" }) + "\n",
  );
}

function acquireCarrierLock(projectRoot: string): void {
  const dir = lockDir(projectRoot);
  try {
    mkdirSync(dir); // atomic; NO { recursive: true } — recursive makes EEXIST silent.
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    let who = "unknown holder";
    try {
      const meta = JSON.parse(readFileSync(join(dir, LOCK_META_NAME), "utf8"));
      const age = Math.round((Date.now() - Date.parse(meta.acquired_at)) / 1000);
      who = `pid ${meta.pid}, ${meta.holder ?? "carrier"}, age ${Number.isFinite(age) ? age + "s" : "?"}`;
    } catch {
      /* meta missing or partial */
    }
    throw new Error(
      `${LOCK_DIR_NAME} is held (${who}) — the Secretary carrier (or another repair) is writing the DB. ` +
        `Retry when no pair is finishing; if the holder is dead and the age is well past 120s, remove .team11/${LOCK_DIR_NAME} by hand.`,
    );
  }
  stampLock(dir);
}

function releaseCarrierLock(projectRoot: string): void {
  try {
    rmSync(lockDir(projectRoot), { recursive: true, force: true });
  } catch (err) {
    console.error("[repair-findings] WARNING: could not release the carrier lock:", err);
  }
}

// --- plans -----------------------------------------------------------------

interface Row {
  id: number;
  title: string;
  content: string;
  source_file: string | null;
  source_pair: string | null;
}

type TitleReason = "short" | "mid-token-truncation" | "unbalanced-backticks";

/** Why a title is in the repair set (null = keep). Cheapest check first. */
function titleReason(title: string, content: string): TitleReason | null {
  if (title.length < SHORT_TITLE_MAX) return "short";
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (
    cleaned.startsWith(title) &&
    /^[.:\-—–][^\s]/.test(cleaned.slice(title.length, title.length + 2))
  ) {
    return "mid-token-truncation";
  }
  if ((title.match(/`/g) ?? []).length % 2 === 1) return "unbalanced-backticks";
  return null;
}

interface TitlePlan {
  id: number;
  reason: TitleReason;
  before: string;
  after: string; // final title, collision suffix included
  collided: boolean;
  source_file: string | null;
}

interface PairPlan {
  id: number;
  source_file: string;
  source_pair: string;
}

/** Evenly spaced sample so the report shows the spread, not just the first ids. */
function spread<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return items;
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function emptyReasonCounts(): Record<TitleReason, number> {
  return { short: 0, "mid-token-truncation": 0, "unbalanced-backticks": 0 };
}

// --- stale embeddings ------------------------------------------------------

function embeddingText(title: string, content: string): string {
  return `${title} ${content}`; // must match every storeEmbedding call-site
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface StaleRow {
  id: number;
  title: string;
  content: string;
}

/**
 * Every findings row whose stored vector does not encode its CURRENT
 * `${title} ${content}` — cache hash differs or no cache row at all. This is
 * the resume set: it is empty after a clean pass and exactly "what is left"
 * after an aborted one.
 */
function staleEmbeddings(db: ReturnType<typeof initDb>): StaleRow[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.title, f.content, c.content_hash
         FROM findings f LEFT JOIN embedding_cache c ON c.finding_id = f.id`,
    )
    .all() as Array<StaleRow & { content_hash: string | null }>;
  return rows
    .filter((r) => r.content_hash !== sha256(embeddingText(r.title, r.content)))
    .map(({ id, title, content }) => ({ id, title, content }));
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot(args.projectRoot);
  const dbPath = join(projectRoot, ".team11", "memory.db");
  if (!existsSync(dbPath)) throw new Error(`No memory DB at ${dbPath}`);

  // Lock BEFORE opening the DB so a refused run touches nothing.
  if (args.execute) acquireCarrierLock(projectRoot);
  try {
    await run(args, projectRoot, dbPath);
  } finally {
    if (args.execute) releaseCarrierLock(projectRoot);
  }
}

async function run(args: Args, projectRoot: string, dbPath: string): Promise<void> {
  const db = initDb(dbPath);
  console.error(`[repair-findings] ${args.execute ? "EXECUTE" : "DRY RUN"} on ${dbPath}`);

  const rows = db
    .prepare(`SELECT id, title, content, source_file, source_pair FROM findings ORDER BY id`)
    .all() as Row[];

  // ---- (a) titles ---------------------------------------------------------
  const byReason = emptyReasonCounts(); // rows that WILL change, by reason
  const unchangedByReason = emptyReasonCounts(); // flagged but deriveTitle agrees with the stored title
  const titlePlan: TitlePlan[] = [];
  const existsStmt = db.prepare(
    `SELECT id FROM findings WHERE title = ? AND source_file IS ? AND id != ? LIMIT 1`,
  );
  // Titles already assigned in this batch, keyed (title, source_file), so two
  // regenerated rows in the same log cannot both claim one title.
  const claimed = new Set<string>();
  const key = (t: string, sf: string | null) => `${t}\u0000${sf ?? ""}`;
  let collisions = 0;

  for (const r of rows) {
    const reason = titleReason(r.title, r.content);
    if (!reason) continue;
    const regenerated = deriveTitle(r.content);
    if (!regenerated || regenerated === r.title) {
      unchangedByReason[reason]++;
      continue;
    }
    byReason[reason]++;
    let after = regenerated;
    let collided = false;
    if (claimed.has(key(after, r.source_file)) || existsStmt.get(after, r.source_file, r.id)) {
      after = `${after} (#${r.id})`;
      collided = true;
      collisions++;
    }
    claimed.add(key(after, r.source_file));
    titlePlan.push({ id: r.id, reason, before: r.title, after, collided, source_file: r.source_file });
  }

  // ---- (b) source_pair ----------------------------------------------------
  let nullBefore = 0;
  let noSourceFile = 0;
  let unmapped = 0;
  const pairPlan: PairPlan[] = [];
  for (const r of rows) {
    if (r.source_pair !== null) continue;
    nullBefore++;
    if (r.source_file === null) {
      noSourceFile++;
      continue;
    }
    const posix = r.source_file.split("\\").join("/");
    const pid = LOG_SOURCE_RE.test(posix) ? pairIdFromLogPath(posix) : null;
    if (!pid) {
      unmapped++;
      continue;
    }
    pairPlan.push({ id: r.id, source_file: r.source_file, source_pair: pid });
  }

  // ---- (c) embeddings: what is stale RIGHT NOW (before any write) ----------
  const staleBefore = staleEmbeddings(db).length;

  // ---- write --------------------------------------------------------------
  let regenerated = 0;
  let staleAfterCommit: number | null = null;
  let staleAfterPass: number | null = null;
  let embeddingsNote = "not run (dry run)";
  let post: Record<string, unknown> | null = null;

  if (args.execute) {
    const updTitle = db.prepare(`UPDATE findings SET title = ? WHERE id = ?`);
    const updPair = db.prepare(`UPDATE findings SET source_pair = ? WHERE id = ?`);
    const apply = db.transaction(() => {
      for (const t of titlePlan) updTitle.run(t.after, t.id);
      for (const p of pairPlan) updPair.run(p.source_pair, p.id);
    });
    apply(); // all-or-nothing: a UNIQUE violation the simulation missed rolls everything back
    console.error(`[repair-findings] committed ${titlePlan.length} title + ${pairPlan.length} source_pair updates`);

    // FTS index/content consistency — throws SQLITE_CORRUPT_VTAB on mismatch.
    db.prepare(`INSERT INTO findings_fts(findings_fts) VALUES ('integrity-check')`).run();

    // Resumable embeddings pass: driven by staleness, not by this run's plan.
    const stale = staleEmbeddings(db);
    staleAfterCommit = stale.length;
    if (!args.embeddings) {
      embeddingsNote = `--no-embeddings — ${stale.length} vector(s) left stale; rerun without the flag to finish`;
    } else if (stale.length === 0) {
      embeddingsNote = "nothing stale";
    } else {
      await initEmbeddings();
      if (!embeddingsAvailable()) {
        embeddingsNote = `model unavailable — ${stale.length} vector(s) left stale; rerun when the model loads`;
      } else {
        console.error(`[repair-findings] regenerating ${stale.length} stale embedding(s)`);
        for (const s of stale) {
          await storeEmbedding(db, s.id, embeddingText(s.title, s.content));
          regenerated++;
          if (regenerated % LOCK_HEARTBEAT_EVERY === 0) {
            stampLock(lockDir(projectRoot)); // keep the carrier's stale-steal at bay
            console.error(`[repair-findings] embeddings ${regenerated}/${stale.length}`);
          }
        }
        embeddingsNote = "regenerated every stale vector (this run's re-titles + any leftovers)";
      }
    }
    staleAfterPass = staleEmbeddings(db).length;

    post = {
      short_titles: (db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE length(title) < ?`).get(SHORT_TITLE_MAX) as { c: number }).c,
      source_pair_null: (db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE source_pair IS NULL`).get() as { c: number }).c,
      fts_integrity: "ok",
      fts_rows: (db.prepare(`SELECT COUNT(*) AS c FROM findings_fts`).get() as { c: number }).c,
      embeddings_stale: staleAfterPass,
    };
  }

  const report = {
    mode: args.execute ? "execute" : "dry-run",
    db: dbPath,
    findings_total: rows.length,
    titles: {
      to_update: titlePlan.length,
      by_reason: byReason,
      unchanged_by_reason: unchangedByReason,
      collisions_suffixed: collisions,
      samples: spread(titlePlan, args.sample).map((t) => ({
        id: t.id,
        reason: t.reason,
        before: t.before,
        after: t.after,
      })),
    },
    source_pair: {
      null_before: nullBefore,
      to_update: pairPlan.length,
      no_source_file: noSourceFile,
      unmapped_source_file: unmapped,
      samples: spread(pairPlan, Math.min(args.sample, 5)),
    },
    embeddings: {
      stale_before_run: staleBefore,
      stale_after_commit: staleAfterCommit,
      regenerated,
      stale_after_pass: staleAfterPass,
      note: embeddingsNote,
    },
    post,
  };
  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main().catch((err) => {
  console.error("[repair-findings] Fatal:", err);
  process.exit(1);
});
