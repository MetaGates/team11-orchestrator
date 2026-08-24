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
 *       `content` with the NEW shared `deriveTitle` (src/log-derive.ts).
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
 *   - Embeddings: vectors were built from `${title} ${content}` at insert.
 *     They are regenerated for every re-titled row after commit (storeEmbedding
 *     is a delete-then-insert upsert keyed by finding_id + a content hash — it
 *     is cheap and keeps the cache hash honest). NOTE: this exposed a latent bug
 *     in tools/store.ts — vec0 rejects `INSERT OR REPLACE` on an existing
 *     finding_id — fixed there 2026-08-24. `--no-embeddings` skips this step.
 *   - `updated_at` / `last_reinforced` are NOT touched: scoring.ts ranks
 *     recency on `updated_at ?? created_at`, so bumping ~1,000 old rows would
 *     push them to the top of every recall. A title/provenance fix is not
 *     new knowledge.
 *
 * Usage:
 *   node dist/scripts/repair-findings.js [--project <root>] [--sample N]        # DRY RUN (default)
 *   node dist/scripts/repair-findings.js --execute [--no-embeddings]            # write
 *
 * stdout: one JSON report (counts per category + sample before/after titles).
 * stderr: progress. Exit 0 on success, 1 on fatal error (the write transaction
 * is all-or-nothing).
 */

import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../db.js";
import { storeEmbedding } from "../tools/store.js";
import { initEmbeddings, embeddingsAvailable } from "../embeddings.js";
import { deriveTitle, pairIdFromLogPath } from "../log-derive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The audit's garbage-title predicate: `length(title) < 12`. */
const SHORT_TITLE_MAX = 12;
/** Only log-derived provenance is backfilled; anything else is reported as unmapped. */
const LOG_SOURCE_RE = /(^|\/)\.team11\/logs\/[^/]+\.md$/;

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
  content: string;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot(args.projectRoot);
  const dbPath = join(projectRoot, ".team11", "memory.db");
  if (!existsSync(dbPath)) throw new Error(`No memory DB at ${dbPath}`);
  const db = initDb(dbPath);
  console.error(`[repair-findings] ${args.execute ? "EXECUTE" : "DRY RUN"} on ${dbPath}`);

  const rows = db
    .prepare(`SELECT id, title, content, source_file, source_pair FROM findings ORDER BY id`)
    .all() as Row[];

  // ---- (a) titles ---------------------------------------------------------
  const byReason: Record<TitleReason, number> = {
    short: 0,
    "mid-token-truncation": 0,
    "unbalanced-backticks": 0,
  };
  let unchanged = 0;
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
    byReason[reason]++;
    const regenerated = deriveTitle(r.content);
    if (!regenerated || regenerated === r.title) {
      unchanged++;
      continue;
    }
    let after = regenerated;
    let collided = false;
    if (claimed.has(key(after, r.source_file)) || existsStmt.get(after, r.source_file, r.id)) {
      after = `${after} (#${r.id})`;
      collided = true;
      collisions++;
    }
    claimed.add(key(after, r.source_file));
    titlePlan.push({
      id: r.id,
      reason,
      before: r.title,
      after,
      collided,
      source_file: r.source_file,
      content: r.content,
    });
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

  // ---- write --------------------------------------------------------------
  let embeddingsRegenerated = 0;
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

    if (args.embeddings && titlePlan.length > 0) {
      await initEmbeddings();
      if (embeddingsAvailable()) {
        for (const t of titlePlan) {
          await storeEmbedding(db, t.id, `${t.after} ${t.content}`);
          embeddingsRegenerated++;
          if (embeddingsRegenerated % 200 === 0) {
            console.error(`[repair-findings] embeddings ${embeddingsRegenerated}/${titlePlan.length}`);
          }
        }
        embeddingsNote = "regenerated for every re-titled row";
      } else {
        embeddingsNote = "model unavailable — vectors left as built from the old titles (accepted staleness)";
      }
    } else if (!args.embeddings) {
      embeddingsNote = "--no-embeddings — vectors left as built from the old titles (accepted staleness)";
    } else {
      embeddingsNote = "nothing re-titled";
    }

    post = {
      short_titles: (db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE length(title) < ?`).get(SHORT_TITLE_MAX) as { c: number }).c,
      source_pair_null: (db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE source_pair IS NULL`).get() as { c: number }).c,
      fts_integrity: "ok",
      fts_rows: (db.prepare(`SELECT COUNT(*) AS c FROM findings_fts`).get() as { c: number }).c,
    };
  }

  const report = {
    mode: args.execute ? "execute" : "dry-run",
    db: dbPath,
    findings_total: rows.length,
    titles: {
      candidates: byReason.short + byReason["mid-token-truncation"] + byReason["unbalanced-backticks"],
      by_reason: byReason,
      unchanged_by_new_derive: unchanged,
      to_update: titlePlan.length,
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
    embeddings: { regenerated: embeddingsRegenerated, note: embeddingsNote },
    post,
  };
  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main().catch((err) => {
  console.error("[repair-findings] Fatal:", err);
  process.exit(1);
});
