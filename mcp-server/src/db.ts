import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Initialize the SQLite database with all tables, FTS5, triggers, and indexes.
 * Uses WAL mode for concurrent read performance.
 */
export function initDb(dbPath: string): Database.Database {
  // Create parent directories if needed
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Performance and safety pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("foreign_keys = ON");

  // -- findings table --
  db.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'finding',
      confidence TEXT DEFAULT 'medium',
      importance REAL DEFAULT 0.4,
      source_file TEXT,
      source_pair TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      accessed_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      superseded_by INTEGER,  -- sentinel: -1 = archived, NULL/0 = active
      UNIQUE(title, source_file)
    )
  `);

  // -- pheromones table --
  db.exec(`
    CREATE TABLE IF NOT EXISTS pheromones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      pair TEXT,
      difficulty TEXT,
      files_touched TEXT,
      gotchas TEXT,
      duration_minutes INTEGER,
      rounds INTEGER,
      findings_count INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // -- FTS5 virtual table for full-text search --
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
      title,
      content,
      tags,
      content=findings,
      content_rowid=id,
      tokenize='porter unicode61 remove_diacritics 2'
    )
  `);

  // -- FTS5 sync triggers --
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS findings_ai AFTER INSERT ON findings BEGIN
      INSERT INTO findings_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS findings_ad AFTER DELETE ON findings BEGIN
      INSERT INTO findings_fts(findings_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS findings_au AFTER UPDATE ON findings BEGIN
      INSERT INTO findings_fts(findings_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO findings_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END
  `);

  // -- Migration: add confidence_score and last_reinforced for decay engine --
  try {
    db.exec(`ALTER TABLE findings ADD COLUMN confidence_score REAL DEFAULT 1.0`);
  } catch (_e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE findings ADD COLUMN last_reinforced TEXT DEFAULT (datetime('now'))`);
  } catch (_e) { /* column already exists */ }

  // -- Indexes --
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_confidence ON findings(confidence)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_confidence_score ON findings(confidence_score)`);

  // -- sqlite-vec extension for vector search --
  sqliteVec.load(db);

  // Vector virtual table (384 dimensions for all-MiniLM-L6-v2)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS findings_vec USING vec0(
      finding_id INTEGER PRIMARY KEY,
      embedding float[384]
    );
  `);

  // Embedding cache — avoid re-computing embeddings for unchanged content
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id INTEGER UNIQUE REFERENCES findings(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'all-MiniLM-L6-v2',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_hash ON embedding_cache(content_hash)`);

  // -- Migration: add pheromone fields for protocol compliance --
  try {
    db.exec(`ALTER TABLE pheromones ADD COLUMN estimated_duration_minutes INTEGER`);
  } catch (_e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE pheromones ADD COLUMN verdict_breakdown TEXT`);
  } catch (_e) { /* column already exists */ }

  // -- contradictions table --
  db.exec(`
    CREATE TABLE IF NOT EXISTS contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_a TEXT NOT NULL,
      source_a TEXT NOT NULL,
      claim_b TEXT NOT NULL,
      source_b TEXT NOT NULL,
      resolution TEXT,
      status TEXT DEFAULT 'OPEN',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  // -- active_edits table (file claims for cross-operator coordination) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator TEXT NOT NULL,
      pair_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      action TEXT,
      status TEXT DEFAULT 'coding',
      claimed_at TEXT DEFAULT (datetime('now')),
      released_at TEXT,
      UNIQUE(file_path, released_at)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_active_edits_file ON active_edits(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_active_edits_pair ON active_edits(pair_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_active_edits_status ON active_edits(status)`);

  // -- operators table (registered Team11 operators) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      github TEXT,
      prefix TEXT NOT NULL UNIQUE,
      pairs TEXT DEFAULT '[1,2,3,4,5]',
      registered_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now'))
    )
  `);

  // -- file_summaries table (git-aware summarization cache) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_exports TEXT,
      line_count INTEGER,
      byte_size INTEGER,
      tags TEXT,
      generated_by TEXT DEFAULT 'agent',
      generated_at TEXT DEFAULT (datetime('now')),
      accessed_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      UNIQUE(file_path, blob_sha)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_path ON file_summaries(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_sha ON file_summaries(blob_sha)`);

  // FTS5 for summary search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
      file_path,
      summary,
      key_exports,
      tags,
      content=file_summaries,
      content_rowid=id,
      tokenize='porter unicode61 remove_diacritics 2'
    )
  `);

  // FTS5 sync triggers for summaries
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON file_summaries BEGIN
      INSERT INTO summaries_fts(rowid, file_path, summary, key_exports, tags)
      VALUES (new.id, new.file_path, new.summary, new.key_exports, new.tags);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON file_summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid, file_path, summary, key_exports, tags)
      VALUES ('delete', old.id, old.file_path, old.summary, old.key_exports, old.tags);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON file_summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid, file_path, summary, key_exports, tags)
      VALUES ('delete', old.id, old.file_path, old.summary, old.key_exports, old.tags);
      INSERT INTO summaries_fts(rowid, file_path, summary, key_exports, tags)
      VALUES (new.id, new.file_path, new.summary, new.key_exports, new.tags);
    END
  `);

  return db;
}
