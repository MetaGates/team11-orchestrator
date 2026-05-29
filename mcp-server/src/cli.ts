#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execSync, execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const command = process.argv[2];

if (!command || command === "help" || command === "--help") {
  console.log(`
team11-memory -- Persistent memory for Team11 multi-agent orchestration

Commands:
  init          Set up Team11 Memory in the current project
  init --sync   Set up with Turso sync prompts
  seed          Import existing .team11/findings/*.md into the database
  stats         Show database statistics
  decay         Run confidence decay across all entries
  help          Show this help message

Usage:
  npx team11-memory init     # In your project root
  npx team11-memory seed     # After adding findings
  npx team11-memory stats    # Check what's in the DB
  npx team11-memory decay    # Run weekly decay
`);
  process.exit(0);
}

if (command === "init") {
  init();
} else if (command === "seed") {
  runSeed();
} else if (command === "stats") {
  runStats();
} else if (command === "decay") {
  runDecay();
} else {
  console.error(`Unknown command: ${command}. Run 'team11-memory help' for usage.`);
  process.exit(1);
}

function init() {
  const projectRoot = resolve(process.cwd());
  const team11Dir = join(projectRoot, ".team11");
  const mcpServerDir = join(team11Dir, "mcp-server");
  const projectName = projectRoot.split(/[/\\]/).pop() || "project";

  console.log(`\nInitializing Team11 Memory in: ${projectRoot}\n`);

  // Step 1: Create directories
  console.log("Creating .team11/ directory structure...");
  const dirs = [
    join(team11Dir, "findings"),
    join(team11Dir, "logs"),
    join(team11Dir, "checkpoints"),
    join(team11Dir, "stale"),
    join(team11Dir, "proposals"),
    join(team11Dir, "inboxes"),
    join(mcpServerDir, "src", "tools"),
    join(mcpServerDir, "src", "scripts"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Step 2: Copy the live MCP server source into the target project.
  // Previously this embedded a hand-maintained snapshot of every source file
  // (writeSourceFiles), which drifted out of sync with db.ts and shipped a
  // born-broken schema (missing contradictions/active_edits/operators/
  // file_summaries tables). Copying the live source tree guarantees the
  // canonical, current schema (D3 fix). The DB itself is created from the
  // canonical initDb in Step 9b below.
  console.log("Copying MCP server source files...");
  copyLiveSource(mcpServerDir);

  // Step 3: Write package.json
  writeFileSync(join(mcpServerDir, "package.json"), JSON.stringify({
    name: "team11-memory",
    version: "1.0.0",
    description: "Persistent memory MCP server for Team11 multi-agent orchestration",
    type: "module",
    main: "dist/index.js",
    bin: { "team11-memory": "dist/cli.js" },
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
      seed: "node dist/scripts/seed.js"
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0",
      "better-sqlite3": "^11.0.0",
      "zod": "^3.25.0",
      "sqlite-vec": "^0.1.9",
      "@huggingface/transformers": "^4.0.0",
      "@libsql/client": "^0.17.2"
    },
    devDependencies: {
      "@types/better-sqlite3": "^7.6.0",
      "@types/node": "^22.0.0",
      typescript: "^5.5.0"
    }
  }, null, 2) + "\n");

  // Step 4: Write tsconfig.json
  writeFileSync(join(mcpServerDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      declaration: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      forceConsistentCasingInFileNames: true
    },
    include: ["src/**/*"]
  }, null, 2) + "\n");

  // Step 5: Install dependencies
  console.log("Installing dependencies (this may take a minute)...");
  try {
    execSync("npm install", { cwd: mcpServerDir, stdio: "inherit" });
  } catch (_err) {
    console.error("npm install failed. You may need to run it manually:");
    console.error(`  cd ${mcpServerDir} && npm install`);
  }

  // Step 6: Build TypeScript
  console.log("Building TypeScript...");
  try {
    execSync("npm run build", { cwd: mcpServerDir, stdio: "inherit" });
  } catch (_err) {
    console.error("Build failed. You may need to run it manually:");
    console.error(`  cd ${mcpServerDir} && npm run build`);
  }

  // Step 6b: Initialize the database from the CANONICAL schema (D3 fix).
  // Run the freshly-built dist/db.js::initDb in a separate node process so the
  // full, current schema (findings, pheromones, contradictions, active_edits,
  // operators, file_summaries, FTS5 + vec0) is created up front — not lazily
  // from a possibly-stale snapshot. execFileSync (no shell) keeps the
  // server-controlled paths from being shell-interpreted.
  console.log("Initializing database (canonical schema)...");
  try {
    const dbJsUrl = pathToFileURL(join(mcpServerDir, "dist", "db.js")).href;
    const dbPath = join(team11Dir, "memory.db").replace(/\\/g, "/");
    const initScript =
      `import(${JSON.stringify(dbJsUrl)}).then(m => { ` +
      `const db = m.initDb(${JSON.stringify(dbPath)}); ` +
      `const t = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get(); ` +
      `console.log('  Database ready (' + t.c + ' tables)'); db.close(); });`;
    execFileSync(process.execPath, ["--input-type=module", "-e", initScript], {
      cwd: mcpServerDir,
      stdio: "inherit",
    });
  } catch (_err) {
    console.error("Database init deferred — it will be created on first MCP server start.");
  }

  // Step 7: Create .mcp.json (merge if exists)
  console.log("Configuring MCP server discovery...");
  const mcpJsonPath = join(projectRoot, ".mcp.json");
  let mcpConfig: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch { /* start fresh */ }
  }
  // Use forward slashes for Node.js compatibility
  const indexPath = join(mcpServerDir, "dist", "index.js").replace(/\\/g, "/");
  const dbPath = join(team11Dir, "memory.db").replace(/\\/g, "/");
  (mcpConfig.mcpServers as Record<string, unknown>)["team11-memory"] = {
    command: "node",
    args: [indexPath],
    env: { TEAM11_MEMORY_DB: dbPath }
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");

  // Step 8: Create config.json
  console.log("Creating default config...");
  const configPath = join(team11Dir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      mode: "solo",
      operator: null,
      repo: null,
      sync: {
        enabled: false,
        provider: "turso",
        url: "",
        token: "",
        syncInterval: 60
      }
    }, null, 2) + "\n");
  } else {
    console.log("  config.json already exists, skipping.");
  }

  // Step 9: Update .gitignore
  console.log("Updating .gitignore...");
  const gitignorePath = join(projectRoot, ".gitignore");
  let gitignore = "";
  if (existsSync(gitignorePath)) {
    gitignore = readFileSync(gitignorePath, "utf8");
  }
  if (!gitignore.includes(".team11/")) {
    const addition = "\n# Team11 (ephemeral agent state, secrets, database)\n.team11/\n";
    writeFileSync(gitignorePath, gitignore + addition);
  }

  // Step 10: Seed if findings exist
  const findingsDir = join(team11Dir, "findings");
  const findingFiles = existsSync(findingsDir)
    ? readdirSync(findingsDir).filter(f => f.endsWith(".md"))
    : [];
  if (findingFiles.length > 0) {
    console.log(`Found ${findingFiles.length} existing findings. Seeding database...`);
    try {
      execSync("npm run seed", { cwd: mcpServerDir, stdio: "inherit" });
    } catch (_err) {
      console.error("Seed failed. Run manually: cd .team11/mcp-server && npm run seed");
    }
  }

  // Done!
  console.log(`
Team11 Memory initialized!

  Database:    .team11/memory.db
  MCP Server:  .team11/mcp-server/
  Config:      .team11/config.json
  Tools:       16 MCP tools registered

  Restart Claude Code to activate the memory server.

  For team sync (optional):
    1. Create a Turso database: turso db create team11-memory-${projectName}
    2. Get URL: turso db show team11-memory-${projectName} --url
    3. Get token: turso db tokens create team11-memory-${projectName}
    4. Edit .team11/config.json -- set sync.enabled=true, paste URL+token
    5. Share URL+token with coworkers
`);
}

function runSeed() {
  const mcpServerDir = join(process.cwd(), ".team11", "mcp-server");
  if (!existsSync(mcpServerDir)) {
    console.error("No .team11/mcp-server/ found. Run 'team11-memory init' first.");
    process.exit(1);
  }
  execSync("npm run seed", { cwd: mcpServerDir, stdio: "inherit" });
}

function runStats() {
  const dbPath = join(process.cwd(), ".team11", "memory.db");
  if (!existsSync(dbPath)) {
    console.error("No .team11/memory.db found. Run 'team11-memory init' first.");
    process.exit(1);
  }
  import("better-sqlite3").then(({ default: Database }) => {
    const db = new Database(dbPath);
    const total = (db.prepare("SELECT COUNT(*) as c FROM findings").get() as Record<string, number>).c;
    const byType = db.prepare("SELECT type, COUNT(*) as c FROM findings GROUP BY type").all() as Array<{ type: string; c: number }>;
    const pheromones = (db.prepare("SELECT COUNT(*) as c FROM pheromones").get() as Record<string, number>).c;
    console.log(`\nTeam11 Memory Stats`);
    console.log(`  Total entries: ${total}`);
    for (const t of byType) {
      console.log(`    ${t.type}: ${t.c}`);
    }
    console.log(`  Pheromone trails: ${pheromones}`);
    console.log(`  Database: ${dbPath}\n`);
    db.close();
  });
}

function runDecay() {
  const dbPath = join(process.cwd(), ".team11", "memory.db");
  if (!existsSync(dbPath)) {
    console.error("No .team11/memory.db found. Run 'team11-memory init' first.");
    process.exit(1);
  }
  import("better-sqlite3").then(({ default: Database }) => {
    const db = new Database(dbPath);
    import("./decay.js").then(({ runDecay: decay }) => {
      const result = decay(db);
      console.log(`\nConfidence Decay Results:`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Flagged (< 50%): ${result.flagged}`);
      console.log(`  Archived (< 25%): ${result.archived}`);
      if (result.flaggedEntries.length > 0) {
        console.log(`\n  Stale entries:`);
        for (const e of result.flaggedEntries) {
          console.log(`    [${Math.round(e.confidence * 100)}%] #${e.id}: ${e.title}`);
        }
      }
      if (result.archivedEntries.length > 0) {
        console.log(`\n  Archived entries:`);
        for (const e of result.archivedEntries) {
          console.log(`    [${Math.round(e.confidence * 100)}%] #${e.id}: ${e.title}`);
        }
      }
      db.close();
    });
  });
}

// -----------------------------------------------------------------------
// copyLiveSource -- copy the live MCP server source tree into a target
// project (replaces the old writeSourceFiles, which embedded a hand-
// maintained snapshot of every source file that drifted out of sync with
// db.ts and shipped a born-broken schema — D3 fix). The DB is created from
// the canonical initDb (see Step 9b in init()), so the schema is always
// current regardless of this copy.
// -----------------------------------------------------------------------

/** Walk up from this module to the MCP server package root (has package.json + src/). */
function findLiveSourceRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("Could not locate live MCP server source root (no package.json + src/ found)");
}

/** Recursively copy a directory, excluding build artifacts. Returns file count. */
function copyDirRecursive(src: string, dest: string, exclude: string[] = []): number {
  let count = 0;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (exclude.includes(entry)) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      count += copyDirRecursive(srcPath, destPath, exclude);
    } else {
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/**
 * Copy the live `src/` tree from this package into the target project's
 * mcp-server directory. No-op (with a notice) when init runs inside the same
 * package that hosts the source, to avoid copying a directory onto itself.
 */
function copyLiveSource(mcpServerDir: string): void {
  const liveRoot = findLiveSourceRoot();
  if (resolve(liveRoot) === resolve(mcpServerDir)) {
    console.log("  MCP server source already in place (same package) — skipping copy.");
    return;
  }
  const copied = copyDirRecursive(
    join(liveRoot, "src"),
    join(mcpServerDir, "src"),
    ["node_modules", "dist", ".git"],
  );
  console.log("  Copied " + copied + " source files");
}

// Retained for backward compatibility — delegates to the live-source copy.
// The stale embedded snapshot below is unreachable and kept only for diff
// reference; it is no longer used by init().
function writeSourceFiles(mcpServerDir: string) {
  copyLiveSource(mcpServerDir);
  return;

  // eslint-disable-next-line no-unreachable
  const files: Array<{ path: string; content: string }> = [];

  files.push({ path: "src/index.ts", content: "import { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport { StdioServerTransport } from \"@modelcontextprotocol/sdk/server/stdio.js\";\nimport { initDb } from \"./db.js\";\nimport { initEmbeddings } from \"./embeddings.js\";\nimport { registerTools } from \"./tools/index.js\";\nimport { loadSyncConfig, initSync, shutdownSync } from \"./sync.js\";\nimport { resolve, isAbsolute, dirname } from \"node:path\";\nimport { existsSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\n\n/**\n * Find the project root by walking up from a starting directory\n * until we find a .team11/ directory.\n */\nfunction findProjectRoot(startDir: string): string | null {\n  let dir = startDir;\n  while (true) {\n    if (existsSync(resolve(dir, \".team11\"))) {\n      return dir;\n    }\n    const parent = dirname(dir);\n    if (parent === dir) break; // reached filesystem root\n    dir = parent;\n  }\n  return null;\n}\n\n/**\n * Resolve the database path. If it's relative, resolve it relative to:\n *   1. PROJECT_ROOT env var (if set)\n *   2. The project root (found by walking up from __dirname to find .team11/)\n *   3. Fall back to CWD (original behavior)\n */\nfunction resolveDbPath(raw: string): string {\n  if (isAbsolute(raw)) return raw;\n\n  // Try PROJECT_ROOT env var first\n  if (process.env.PROJECT_ROOT) {\n    return resolve(process.env.PROJECT_ROOT, raw);\n  }\n\n  // Walk up from script location to find project root\n  const __filename = fileURLToPath(import.meta.url);\n  const __dirname = dirname(__filename);\n  const projectRoot = findProjectRoot(__dirname);\n  if (projectRoot) {\n    return resolve(projectRoot, raw);\n  }\n\n  // Fallback: resolve relative to CWD\n  return resolve(raw);\n}\n\nconst server = new McpServer({\n  name: \"team11-memory\",\n  version: \"1.0.0\",\n  description: \"Persistent memory for Team11 multi-agent orchestration\",\n});\n\n// Initialize database — path configurable via env var\nconst rawDbPath = process.env.TEAM11_MEMORY_DB || \".team11/memory.db\";\nconst dbPath = resolveDbPath(rawDbPath);\nconst db = initDb(dbPath);\n\n// Initialize embedding model (non-blocking — FTS5 works without it)\nawait initEmbeddings();\n\n// Resolve project root for config loading\nconst __filename2 = fileURLToPath(import.meta.url);\nconst __dirname2 = dirname(__filename2);\nconst projectRoot =\n  process.env.PROJECT_ROOT || findProjectRoot(__dirname2) || process.cwd();\n\n// Initialize Turso sync (opt-in — disabled by default)\nconst syncConfig = loadSyncConfig(projectRoot);\nif (syncConfig) {\n  await initSync(dbPath, syncConfig);\n}\n\n// Register all tools (pass projectRoot for sync tools)\nregisterTools(server, db, projectRoot);\n\n// Graceful shutdown — clean up sync resources\nprocess.on(\"SIGINT\", () => {\n  shutdownSync();\n  process.exit(0);\n});\nprocess.on(\"SIGTERM\", () => {\n  shutdownSync();\n  process.exit(0);\n});\n\n// Start server\nconst transport = new StdioServerTransport();\nawait server.connect(transport);\n" });

  files.push({ path: "src/db.ts", content: "import Database from \"better-sqlite3\";\nimport * as sqliteVec from \"sqlite-vec\";\nimport { mkdirSync } from \"node:fs\";\nimport { dirname } from \"node:path\";\n\n/**\n * Initialize the SQLite database with all tables, FTS5, triggers, and indexes.\n * Uses WAL mode for concurrent read performance.\n */\nexport function initDb(dbPath: string): Database.Database {\n  // Warn if database is inside OneDrive (SQLite + cloud sync = corruption risk)\n  if (dbPath.includes('OneDrive')) {\n    console.error('[team11-memory] WARNING: Database is inside OneDrive folder. SQLite may corrupt. Consider moving to a non-synced location.');\n  }\n\n  // Create parent directories if needed\n  mkdirSync(dirname(dbPath), { recursive: true });\n\n  const db = new Database(dbPath);\n\n  // Performance and safety pragmas\n  db.pragma(\"journal_mode = WAL\");\n  db.pragma(\"synchronous = NORMAL\");\n  db.pragma(\"cache_size = -64000\");\n  db.pragma(\"foreign_keys = ON\");\n\n  // -- findings table --\n  db.exec(`\n    CREATE TABLE IF NOT EXISTS findings (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      title TEXT NOT NULL,\n      content TEXT NOT NULL,\n      type TEXT NOT NULL DEFAULT 'finding',\n      confidence TEXT DEFAULT 'medium',\n      importance REAL DEFAULT 0.4,\n      source_file TEXT,\n      source_pair TEXT,\n      tags TEXT,\n      created_at TEXT DEFAULT (datetime('now')),\n      updated_at TEXT DEFAULT (datetime('now')),\n      accessed_at TEXT DEFAULT (datetime('now')),\n      access_count INTEGER DEFAULT 0,\n      superseded_by INTEGER REFERENCES findings(id),\n      UNIQUE(title, source_file)\n    )\n  `);\n\n  // -- pheromones table --\n  db.exec(`\n    CREATE TABLE IF NOT EXISTS pheromones (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      task TEXT NOT NULL,\n      pair TEXT,\n      difficulty TEXT,\n      files_touched TEXT,\n      gotchas TEXT,\n      duration_minutes INTEGER,\n      rounds INTEGER,\n      findings_count INTEGER,\n      created_at TEXT DEFAULT (datetime('now'))\n    )\n  `);\n\n  // -- FTS5 virtual table for full-text search --\n  db.exec(`\n    CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(\n      title,\n      content,\n      tags,\n      content=findings,\n      content_rowid=id,\n      tokenize='porter unicode61 remove_diacritics 2'\n    )\n  `);\n\n  // -- FTS5 sync triggers --\n  db.exec(`\n    CREATE TRIGGER IF NOT EXISTS findings_ai AFTER INSERT ON findings BEGIN\n      INSERT INTO findings_fts(rowid, title, content, tags)\n      VALUES (new.id, new.title, new.content, new.tags);\n    END\n  `);\n\n  db.exec(`\n    CREATE TRIGGER IF NOT EXISTS findings_ad AFTER DELETE ON findings BEGIN\n      INSERT INTO findings_fts(findings_fts, rowid, title, content, tags)\n      VALUES ('delete', old.id, old.title, old.content, old.tags);\n    END\n  `);\n\n  db.exec(`\n    CREATE TRIGGER IF NOT EXISTS findings_au AFTER UPDATE ON findings BEGIN\n      INSERT INTO findings_fts(findings_fts, rowid, title, content, tags)\n      VALUES ('delete', old.id, old.title, old.content, old.tags);\n      INSERT INTO findings_fts(rowid, title, content, tags)\n      VALUES (new.id, new.title, new.content, new.tags);\n    END\n  `);\n\n  // -- Migration: add confidence_score and last_reinforced for decay engine --\n  try {\n    db.exec(`ALTER TABLE findings ADD COLUMN confidence_score REAL DEFAULT 1.0`);\n  } catch (_e) { /* column already exists */ }\n  try {\n    db.exec(`ALTER TABLE findings ADD COLUMN last_reinforced TEXT DEFAULT (datetime('now'))`);\n  } catch (_e) { /* column already exists */ }\n\n  // -- Indexes --\n  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type)`);\n  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at)`);\n  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_confidence ON findings(confidence)`);\n  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_confidence_score ON findings(confidence_score)`);\n\n  // -- sqlite-vec extension for vector search --\n  sqliteVec.load(db);\n\n  // Vector virtual table (384 dimensions for all-MiniLM-L6-v2)\n  db.exec(`\n    CREATE VIRTUAL TABLE IF NOT EXISTS findings_vec USING vec0(\n      finding_id INTEGER PRIMARY KEY,\n      embedding float[384]\n    );\n  `);\n\n  // Embedding cache — avoid re-computing embeddings for unchanged content\n  db.exec(`\n    CREATE TABLE IF NOT EXISTS embedding_cache (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      finding_id INTEGER UNIQUE REFERENCES findings(id) ON DELETE CASCADE,\n      content_hash TEXT NOT NULL,\n      embedding BLOB NOT NULL,\n      model TEXT DEFAULT 'all-MiniLM-L6-v2',\n      created_at TEXT DEFAULT (datetime('now'))\n    );\n  `);\n  db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_hash ON embedding_cache(content_hash)`);\n\n  return db;\n}\n" });

  files.push({ path: "src/tokenize.ts", content: "/**\n * Pre-process text for FTS5 indexing.\n * Splits camelCase, PascalCase, snake_case, kebab-case, and file paths\n * into separate searchable tokens.\n */\nexport function tokenizeForFts(text: string): string {\n  return text\n    .replace(/([a-z])([A-Z])/g, \"$1 $2\")       // camelCase -> camel Case\n    .replace(/([A-Z]+)([A-Z][a-z])/g, \"$1 $2\") // HTMLParser -> HTML Parser\n    .replace(/_/g, \" \")                          // snake_case -> snake case\n    .replace(/-/g, \" \")                          // kebab-case -> kebab case\n    .replace(/[\\/\\\\.]/g, \" \")                    // file/paths -> file paths\n    .replace(/\\s+/g, \" \")                        // collapse whitespace\n    .trim();\n}\n\nconst STOPWORDS = new Set([\n  \"the\", \"a\", \"an\", \"is\", \"are\", \"was\", \"were\", \"be\", \"been\", \"being\",\n  \"have\", \"has\", \"had\", \"do\", \"does\", \"did\", \"will\", \"would\", \"could\",\n  \"should\", \"may\", \"might\", \"shall\", \"can\", \"need\", \"must\",\n  \"to\", \"of\", \"in\", \"for\", \"on\", \"with\", \"at\", \"by\", \"from\", \"as\",\n  \"into\", \"through\", \"during\", \"before\", \"after\", \"above\", \"below\",\n  \"and\", \"but\", \"or\", \"nor\", \"not\", \"so\", \"yet\", \"both\", \"either\",\n  \"neither\", \"each\", \"every\", \"all\", \"any\", \"few\", \"more\", \"most\",\n  \"other\", \"some\", \"such\", \"no\", \"only\", \"own\", \"same\",\n  \"than\", \"too\", \"very\", \"just\", \"because\", \"if\", \"when\", \"where\",\n  \"how\", \"what\", \"which\", \"who\", \"whom\", \"this\", \"that\", \"these\", \"those\",\n  \"i\", \"me\", \"my\", \"we\", \"our\", \"you\", \"your\", \"he\", \"him\", \"his\",\n  \"she\", \"her\", \"it\", \"its\", \"they\", \"them\", \"their\",\n]);\n\n/**\n * Extract search keywords from a natural language query.\n * Removes stopwords and applies tokenization.\n */\nexport function extractKeywords(text: string): string[] {\n  const tokenized = tokenizeForFts(text);\n  return tokenized\n    .toLowerCase()\n    .split(/\\s+/)\n    .filter((w) => w.length > 1 && !STOPWORDS.has(w));\n}\n\n/**\n * Build an FTS5 MATCH query from keywords.\n * Uses OR logic so partial matches still return results.\n */\nexport function buildFtsQuery(keywords: string[]): string {\n  if (keywords.length === 0) return \"\";\n  // Escape special FTS5 characters\n  const escaped = keywords.map((k) => k.replace(/['\"(){}[\\]*:^~!@#$%&]/g, \"\"));\n  return escaped.filter((k) => k.length > 0).join(\" OR \");\n}\n" });

  files.push({ path: "src/scoring.ts", content: "/**\n * Composite scoring engine for Team11 Memory MCP.\n * Formula: BM25(40%) + Importance(25%) + Recency(20%) + Access Frequency(15%)\n */\n\ninterface ScoredFields {\n  bm25_score: number;\n  importance: number;\n  updated_at?: string;\n  created_at: string;\n  access_count: number;\n  confidence_score?: number;\n}\n\n/**\n * Compute composite score for a search result.\n * All sub-scores are normalized to 0-1 before weighting.\n */\nexport function computeCompositeScore(result: ScoredFields): number {\n  // BM25: FTS5 returns negative values (lower = better match).\n  // Normalize absolute value into 0-1 range, capping at 20.\n  const bm25 = Math.min(1.0, Math.abs(result.bm25_score) / 20);\n\n  // Importance: already 0-1 in the schema, default 0.4.\n  const importance = result.importance ?? 0.4;\n\n  // Recency: 1.0 for today, linear decay to 0 over 90 days.\n  const daysSinceUpdate = daysBetween(\n    result.updated_at ?? result.created_at,\n    new Date(),\n  );\n  const recency = Math.max(0, 1.0 - daysSinceUpdate / 90);\n\n  // Access frequency: caps at 10 accesses for full score.\n  const accessFreq = Math.min((result.access_count ?? 0) / 10, 1.0);\n\n  // Confidence: multiplicative gate — low confidence entries get deprioritized.\n  const confidence = result.confidence_score ?? 1.0;\n\n  const rawScore =\n    bm25 * 0.4 + importance * 0.25 + recency * 0.2 + accessFreq * 0.15;\n  return rawScore * confidence;\n}\n\nfunction daysBetween(dateStr: string, now: Date): number {\n  const date = new Date(dateStr);\n  const ms = now.getTime() - date.getTime();\n  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));\n}\n\n/**\n * Estimate token count for a piece of text.\n * Rough approximation: 1 token ~ 4 characters.\n */\nexport function estimateTokens(text: string): number {\n  return Math.ceil(text.length / 4);\n}\n" });

  files.push({ path: "src/embeddings.ts", content: "import { pipeline, type FeatureExtractionPipeline } from \"@huggingface/transformers\";\n\nlet embedder: FeatureExtractionPipeline | null = null;\n\n/**\n * Initialize the embedding model. Downloads on first use (~22MB).\n * Uses all-MiniLM-L6-v2: 384-dimensional, fast, good for English text.\n */\nexport async function initEmbeddings(): Promise<void> {\n  if (embedder) return;\n  try {\n    embedder = (await pipeline(\"feature-extraction\", \"Xenova/all-MiniLM-L6-v2\")) as FeatureExtractionPipeline;\n    console.error(\"[team11-memory] Embedding model loaded: all-MiniLM-L6-v2 (384d)\");\n  } catch (err) {\n    console.error(\"[team11-memory] WARNING: Failed to load embedding model. Vector search disabled.\", err);\n    embedder = null;\n  }\n}\n\n/**\n * Generate embedding vector for text.\n * Returns Float32Array of 384 dimensions (for MiniLM-L6-v2).\n * Returns null if embeddings not initialized.\n */\nexport async function embed(text: string): Promise<Float32Array | null> {\n  if (!embedder) return null;\n  try {\n    // Truncate to model's max token window (~256 tokens for MiniLM)\n    const truncated = text.substring(0, 1000);\n    const output = await embedder(truncated, { pooling: \"mean\", normalize: true });\n    return new Float32Array(output.data as Float32Array);\n  } catch (err) {\n    console.error(\"[team11-memory] Embedding error:\", err);\n    return null;\n  }\n}\n\n/**\n * Check if embeddings are available.\n */\nexport function embeddingsAvailable(): boolean {\n  return embedder !== null;\n}\n\n/**\n * Get embedding dimensions.\n */\nexport function embeddingDimensions(): number {\n  return 384; // all-MiniLM-L6-v2\n}\n" });

  files.push({ path: "src/decay.ts", content: "import type Database from \"better-sqlite3\";\n\n/**\n * Confidence decay engine for Team11 Memory.\n *\n * 5% weekly exponential decay: confidence = 0.95^weeks.\n * - Below 50% => flagged as stale.\n * - Below 25% => archived (superseded_by = -1).\n */\n\nconst DECAY_RATE = 0.05; // 5% per week\nconst STALE_THRESHOLD = 0.5; // Flag at 50%\nconst ARCHIVE_THRESHOLD = 0.25; // Archive at 25%\n\nexport interface DecayResult {\n  updated: number;\n  flagged: number;\n  archived: number;\n  flaggedEntries: Array<{ id: number; title: string; confidence: number }>;\n  archivedEntries: Array<{ id: number; title: string; confidence: number }>;\n}\n\n/**\n * Calculate current confidence for an entry based on time since last reinforcement.\n */\nexport function calculateConfidence(lastReinforced: string): number {\n  const now = new Date();\n  const reinforced = new Date(lastReinforced);\n  const weeksSinceReinforced =\n    (now.getTime() - reinforced.getTime()) / (1000 * 60 * 60 * 24 * 7);\n  return Math.max(0, Math.pow(1 - DECAY_RATE, weeksSinceReinforced));\n}\n\n/**\n * Run confidence decay across all active findings.\n * Updates confidence_score based on time since last_reinforced.\n * Flags stale entries and archives very stale ones.\n */\nexport function runDecay(db: Database.Database): DecayResult {\n  const findings = db\n    .prepare(\n      `SELECT id, title, type, confidence_score, last_reinforced, created_at, superseded_by\n       FROM findings\n       WHERE superseded_by IS NULL OR superseded_by = 0`,\n    )\n    .all() as any[];\n\n  let updated = 0;\n  let flagged = 0;\n  let archived = 0;\n  const flaggedEntries: DecayResult[\"flaggedEntries\"] = [];\n  const archivedEntries: DecayResult[\"archivedEntries\"] = [];\n\n  const updateStmt = db.prepare(\n    `UPDATE findings SET confidence_score = ? WHERE id = ?`,\n  );\n  const archiveStmt = db.prepare(\n    `UPDATE findings SET superseded_by = -1 WHERE id = ?`,\n  );\n\n  for (const f of findings) {\n    const newConfidence = calculateConfidence(\n      f.last_reinforced || f.created_at,\n    );\n\n    if (Math.abs(newConfidence - (f.confidence_score ?? 1.0)) > 0.01) {\n      updateStmt.run(newConfidence, f.id);\n      updated++;\n    }\n\n    if (newConfidence < ARCHIVE_THRESHOLD && f.superseded_by !== -1) {\n      archiveStmt.run(f.id);\n      archived++;\n      archivedEntries.push({\n        id: f.id,\n        title: f.title,\n        confidence: newConfidence,\n      });\n    } else if (newConfidence < STALE_THRESHOLD) {\n      flagged++;\n      flaggedEntries.push({\n        id: f.id,\n        title: f.title,\n        confidence: newConfidence,\n      });\n    }\n  }\n\n  return { updated, flagged, archived, flaggedEntries, archivedEntries };\n}\n\n/**\n * Reinforce a finding — reset its confidence decay timer.\n * Called when an agent re-confirms a fact is still true.\n */\nexport function reinforce(db: Database.Database, findingId: number): void {\n  db.prepare(\n    `UPDATE findings SET\n       confidence_score = 1.0,\n       last_reinforced = datetime('now'),\n       updated_at = datetime('now')\n     WHERE id = ?`,\n  ).run(findingId);\n}\n\n/**\n * Restore an archived finding (un-archive).\n * Resets confidence to 1.0 and clears the archive marker.\n */\nexport function restore(db: Database.Database, findingId: number): void {\n  db.prepare(\n    `UPDATE findings SET\n       superseded_by = NULL,\n       confidence_score = 1.0,\n       last_reinforced = datetime('now'),\n       updated_at = datetime('now')\n     WHERE id = ?`,\n  ).run(findingId);\n}\n" });

  files.push({ path: "src/sync.ts", content: "import { createClient, type Client } from \"@libsql/client\";\nimport { existsSync, readFileSync } from \"node:fs\";\nimport { join } from \"node:path\";\n\nexport interface SyncConfig {\n  enabled: boolean;\n  provider: \"turso\";\n  url: string;\n  token: string;\n  syncInterval?: number;\n}\n\nlet syncClient: Client | null = null;\nlet syncTimer: ReturnType<typeof setInterval> | null = null;\n\n/**\n * Load sync config from .team11/config.json.\n * Returns null if sync is disabled or config is missing/invalid.\n */\nexport function loadSyncConfig(projectRoot: string): SyncConfig | null {\n  const configPath = join(projectRoot, \".team11\", \"config.json\");\n  if (!existsSync(configPath)) return null;\n\n  try {\n    const config = JSON.parse(readFileSync(configPath, \"utf8\"));\n    if (!config.sync || !config.sync.enabled) return null;\n    return config.sync as SyncConfig;\n  } catch {\n    return null;\n  }\n}\n\n/**\n * Initialize Turso embedded replica.\n *\n * Uses @libsql/client in embedded replica mode: a local SQLite file that\n * syncs to a Turso cloud primary. better-sqlite3 continues to handle all\n * reads/writes against the same file; this client only drives sync().\n *\n * Returns the Client on success, null on failure (local-only fallback).\n */\nexport async function initSync(\n  dbPath: string,\n  syncConfig: SyncConfig,\n): Promise<Client | null> {\n  if (!syncConfig.enabled || !syncConfig.url || !syncConfig.token) {\n    console.error(\n      \"[team11-memory] Sync disabled or incomplete config. Running local-only.\",\n    );\n    return null;\n  }\n\n  try {\n    syncClient = createClient({\n      url: `file:${dbPath}`,\n      syncUrl: syncConfig.url,\n      authToken: syncConfig.token,\n    });\n\n    // Initial sync -- pull remote state\n    await syncClient.sync();\n    console.error(`[team11-memory] Turso sync connected: ${syncConfig.url}`);\n    console.error(\n      `[team11-memory] Sync interval: ${syncConfig.syncInterval || 60}s`,\n    );\n\n    // Periodic background sync\n    const intervalMs = (syncConfig.syncInterval || 60) * 1000;\n    syncTimer = setInterval(async () => {\n      try {\n        await syncClient?.sync();\n      } catch (err) {\n        console.error(\"[team11-memory] Sync error (will retry):\", err);\n      }\n    }, intervalMs);\n\n    return syncClient;\n  } catch (err) {\n    console.error(\n      \"[team11-memory] Failed to initialize Turso sync. Running local-only.\",\n      err,\n    );\n    syncClient = null;\n    return null;\n  }\n}\n\n/**\n * Force an immediate sync (call after writes to push changes promptly).\n */\nexport async function forceSync(): Promise<void> {\n  if (!syncClient) return;\n  try {\n    await syncClient.sync();\n  } catch (err) {\n    console.error(\"[team11-memory] Force sync failed:\", err);\n  }\n}\n\n/**\n * Shut down sync cleanly -- clear the timer and close the client.\n */\nexport function shutdownSync(): void {\n  if (syncTimer) {\n    clearInterval(syncTimer);\n    syncTimer = null;\n  }\n  if (syncClient) {\n    syncClient.close();\n    syncClient = null;\n  }\n}\n\n/**\n * Check whether Turso sync is currently active.\n */\nexport function isSyncActive(): boolean {\n  return syncClient !== null;\n}\n" });

  files.push({ path: "src/tools/index.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type Database from \"better-sqlite3\";\nimport { registerRecallTools } from \"./recall.js\";\nimport { registerStoreTools } from \"./store.js\";\nimport { registerSearchTools } from \"./search.js\";\nimport { registerPheromoneTools } from \"./pheromones.js\";\nimport { registerSyncTools } from \"./sync.js\";\n\nexport function registerTools(\n  server: McpServer,\n  db: Database.Database,\n  projectRoot: string,\n): void {\n  registerRecallTools(server, db);\n  registerStoreTools(server, db);\n  registerSearchTools(server, db);\n  registerPheromoneTools(server, db);\n  registerSyncTools(server, projectRoot);\n}\n" });

  files.push({ path: "src/tools/recall.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type Database from \"better-sqlite3\";\nimport { z } from \"zod\";\nimport { computeCompositeScore, estimateTokens } from \"../scoring.js\";\nimport { extractKeywords, buildFtsQuery } from \"../tokenize.js\";\nimport { embed, embeddingsAvailable } from \"../embeddings.js\";\n\nexport function registerRecallTools(\n  server: McpServer,\n  db: Database.Database,\n): void {\n  // recall_context — primary retrieval tool\n  server.tool(\n    \"recall_context\",\n    \"Retrieve relevant context for a task from Team11's persistent memory. Returns findings, decisions, gotchas, and pheromone data ranked by relevance.\",\n    {\n      task_description: z\n        .string()\n        .describe(\"Natural language description of the task\"),\n      max_tokens: z\n        .number()\n        .optional()\n        .default(8000)\n        .describe(\"Maximum tokens in response\"),\n    },\n    async ({ task_description, max_tokens }) => {\n      const keywords = extractKeywords(task_description);\n      if (keywords.length === 0) {\n        return {\n          content: [\n            {\n              type: \"text\" as const,\n              text: JSON.stringify({\n                query: task_description,\n                results_count: 0,\n                findings: [],\n                decisions: [],\n                gotchas: [],\n                facts: [],\n                pheromones: [],\n              }),\n            },\n          ],\n        };\n      }\n\n      const ftsQuery = buildFtsQuery(keywords);\n\n      // FTS5 search with BM25 scoring — weights: title(10), content(1), tags(2)\n      // Excludes archived entries (superseded_by = -1 is the archive marker)\n      const ftsResults = db\n        .prepare(\n          `\n        SELECT f.*, bm25(findings_fts, 10.0, 1.0, 2.0) as bm25_score\n        FROM findings_fts fts\n        JOIN findings f ON f.id = fts.rowid\n        WHERE findings_fts MATCH ?\n          AND (f.superseded_by IS NULL OR f.superseded_by = 0)\n        ORDER BY bm25(findings_fts, 10.0, 1.0, 2.0)\n        LIMIT 50\n      `,\n        )\n        .all(ftsQuery);\n\n      // Vector search (if embeddings are available)\n      let vectorResults: any[] = [];\n      if (embeddingsAvailable()) {\n        const queryVector = await embed(task_description);\n        if (queryVector) {\n          const vectorBlob = Buffer.from(queryVector.buffer);\n          vectorResults = db\n            .prepare(\n              `\n            SELECT f.*, v.distance\n            FROM findings_vec v\n            JOIN findings f ON f.id = v.finding_id\n            WHERE v.embedding MATCH ? AND k = 30\n            ORDER BY v.distance\n          `,\n            )\n            .all(vectorBlob);\n        }\n      }\n\n      // Merge results via Reciprocal Rank Fusion (RRF)\n      // Then apply composite scoring as secondary sort within RRF groups\n      const merged = mergeWithRRF(ftsResults, vectorResults);\n      const scored = merged.map((r: any) => ({\n        ...r,\n        composite_score: computeCompositeScore({\n          ...r,\n          bm25_score: r.bm25_score ?? 0,\n        }),\n      }));\n      // Final sort: RRF score primary, composite secondary\n      scored.sort((a: any, b: any) => {\n        const rrfDiff = (b.rrf_score ?? 0) - (a.rrf_score ?? 0);\n        if (Math.abs(rrfDiff) > 0.001) return rrfDiff;\n        return b.composite_score - a.composite_score;\n      });\n\n      // Token budget enforcement — reserve 500 tokens for envelope\n      let tokenBudget = max_tokens - 500;\n      const included: any[] = [];\n      for (const r of scored) {\n        const est = estimateTokens(r.title + r.content);\n        if (tokenBudget - est < 0) break;\n        tokenBudget -= est;\n        included.push(r);\n\n        // Update access tracking\n        db.prepare(\n          `UPDATE findings SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?`,\n        ).run(r.id);\n      }\n\n      // Pheromone lookup by keyword match\n      const pheromonePattern = `%${keywords.join(\"%\")}%`;\n      const pheromones = db\n        .prepare(\n          `\n        SELECT * FROM pheromones\n        WHERE task LIKE ? OR files_touched LIKE ? OR gotchas LIKE ?\n        ORDER BY created_at DESC LIMIT 10\n      `,\n        )\n        .all(pheromonePattern, pheromonePattern, pheromonePattern);\n\n      const response = {\n        query: task_description,\n        results_count: included.length,\n        token_estimate: max_tokens - tokenBudget,\n        findings: included\n          .filter((r: any) => r.type === \"finding\")\n          .map(summarize),\n        decisions: included\n          .filter((r: any) => r.type === \"decision\")\n          .map(summarize),\n        gotchas: included\n          .filter((r: any) => r.type === \"gotcha\")\n          .map(summarize),\n        facts: included\n          .filter((r: any) => r.type === \"fact\")\n          .map(summarize),\n        pheromones: pheromones.map((p: any) => ({\n          task: p.task,\n          difficulty: p.difficulty,\n          files: safeJsonParse(p.files_touched, []),\n          gotchas: safeJsonParse(p.gotchas, []),\n          duration_minutes: p.duration_minutes,\n        })),\n      };\n\n      return {\n        content: [\n          { type: \"text\" as const, text: JSON.stringify(response, null, 2) },\n        ],\n      };\n    },\n  );\n\n  // get_detail — fetch full content by ID\n  server.tool(\n    \"get_detail\",\n    \"Get the full content of a specific memory entry by ID. Use after recall_context returns summaries.\",\n    {\n      id: z.number().describe(\"The finding/decision/gotcha ID\"),\n    },\n    async ({ id }) => {\n      const result = db\n        .prepare(`SELECT * FROM findings WHERE id = ?`)\n        .get(id) as Record<string, unknown> | undefined;\n      if (!result) {\n        return {\n          content: [\n            {\n              type: \"text\" as const,\n              text: JSON.stringify({ error: \"Not found\" }),\n            },\n          ],\n        };\n      }\n      // Update access tracking\n      db.prepare(\n        `UPDATE findings SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?`,\n      ).run(id);\n      return {\n        content: [\n          { type: \"text\" as const, text: JSON.stringify(result, null, 2) },\n        ],\n      };\n    },\n  );\n}\n\nfunction summarize(r: any) {\n  return {\n    id: r.id,\n    title: r.title,\n    type: r.type,\n    confidence: r.confidence,\n    score: Math.round(r.composite_score * 100) / 100,\n    created_at: r.created_at,\n    summary:\n      r.content.length > 200\n        ? r.content.substring(0, 200) + \"...\"\n        : r.content,\n  };\n}\n\nfunction safeJsonParse(str: string | null, fallback: any): any {\n  if (!str) return fallback;\n  try {\n    return JSON.parse(str);\n  } catch {\n    return fallback;\n  }\n}\n\n/**\n * Reciprocal Rank Fusion (RRF) to merge FTS5 + vector search results.\n * RRF score = sum(1 / (k + rank)) across both result sets.\n * k = 60 is the standard constant.\n */\nfunction mergeWithRRF(ftsResults: any[], vecResults: any[], k: number = 60): any[] {\n  const scores = new Map<number, { item: any; score: number }>();\n\n  ftsResults.forEach((item, rank) => {\n    const existing = scores.get(item.id) || { item, score: 0 };\n    existing.score += 1 / (k + rank);\n    if (!scores.has(item.id)) existing.item = item;\n    scores.set(item.id, existing);\n  });\n\n  vecResults.forEach((item, rank) => {\n    const existing = scores.get(item.id) || { item, score: 0 };\n    existing.score += 1 / (k + rank);\n    if (!scores.has(item.id)) existing.item = item;\n    scores.set(item.id, existing);\n  });\n\n  return Array.from(scores.values())\n    .sort((a, b) => b.score - a.score)\n    .map(({ item, score }) => ({ ...item, rrf_score: score }));\n}\n" });

  files.push({ path: "src/tools/store.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type Database from \"better-sqlite3\";\nimport { z } from \"zod\";\nimport { createHash } from \"node:crypto\";\nimport { embed, embeddingsAvailable } from \"../embeddings.js\";\nimport { forceSync, isSyncActive } from \"../sync.js\";\n\n/**\n * Generate and store embedding for a finding.\n * Skips if embeddings unavailable or content unchanged (by hash).\n */\nasync function storeEmbedding(db: Database.Database, findingId: number | bigint, content: string): Promise<void> {\n  if (!embeddingsAvailable()) return;\n\n  const contentHash = createHash(\"sha256\").update(content).digest(\"hex\");\n\n  // Check cache — skip if content unchanged\n  const cached = db.prepare(`SELECT content_hash FROM embedding_cache WHERE finding_id = ?`).get(Number(findingId)) as { content_hash: string } | undefined;\n  if (cached && cached.content_hash === contentHash) return;\n\n  const vector = await embed(content);\n  if (!vector) return;\n\n  const vectorBlob = Buffer.from(vector.buffer);\n\n  // Store in vec0 virtual table\n  db.prepare(`INSERT OR REPLACE INTO findings_vec (finding_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(Number(findingId), vectorBlob);\n\n  // Store in cache\n  db.prepare(`INSERT OR REPLACE INTO embedding_cache (finding_id, content_hash, embedding) VALUES (?, ?, ?)`).run(Number(findingId), contentHash, vectorBlob);\n}\n\nexport function registerStoreTools(\n  server: McpServer,\n  db: Database.Database,\n): void {\n  server.tool(\n    \"store_finding\",\n    \"Store a finding, decision, gotcha, or fact in Team11's persistent memory.\",\n    {\n      title: z.string().describe(\"Short title for the finding\"),\n      content: z.string().describe(\"Full content/description\"),\n      type: z\n        .enum([\"finding\", \"decision\", \"gotcha\", \"fact\", \"architecture\"])\n        .default(\"finding\"),\n      confidence: z\n        .enum([\"high\", \"medium\", \"low\"])\n        .optional()\n        .default(\"medium\"),\n      importance: z\n        .number()\n        .min(0)\n        .max(1)\n        .optional()\n        .default(0.4),\n      source_pair: z\n        .string()\n        .optional()\n        .describe(\"Which pair created this\"),\n      source_file: z\n        .string()\n        .optional()\n        .describe(\"Original source file path\"),\n      tags: z\n        .array(z.string())\n        .optional()\n        .describe(\"Tags for categorization\"),\n    },\n    async ({\n      title,\n      content,\n      type,\n      confidence,\n      importance,\n      source_pair,\n      source_file,\n      tags,\n    }) => {\n      const tagsJson = tags ? JSON.stringify(tags) : null;\n\n      const result = db\n        .prepare(\n          `\n        INSERT INTO findings (title, content, type, confidence, importance, source_pair, source_file, tags)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?)\n      `,\n        )\n        .run(\n          title,\n          content,\n          type,\n          confidence,\n          importance,\n          source_pair ?? null,\n          source_file ?? null,\n          tagsJson,\n        );\n\n      await storeEmbedding(db, result.lastInsertRowid, `${title} ${content}`);\n      if (isSyncActive()) await forceSync();\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              stored: true,\n              id: result.lastInsertRowid,\n              type,\n            }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"store_decision\",\n    \"Store an architectural or design decision with rationale.\",\n    {\n      title: z.string().describe(\"Decision title\"),\n      content: z.string().describe(\"What was decided\"),\n      rationale: z.string().describe(\"Why this was decided\"),\n      decided_by: z.string().optional().default(\"Human\"),\n      tags: z.array(z.string()).optional(),\n    },\n    async ({ title, content, rationale, decided_by, tags }) => {\n      const fullContent = `${content}\\n\\nRationale: ${rationale}\\nDecided by: ${decided_by}`;\n      const tagsJson = tags ? JSON.stringify(tags) : null;\n\n      const result = db\n        .prepare(\n          `\n        INSERT INTO findings (title, content, type, confidence, importance, tags)\n        VALUES (?, ?, 'decision', 'high', 0.8, ?)\n      `,\n        )\n        .run(title, fullContent, tagsJson);\n\n      await storeEmbedding(db, result.lastInsertRowid, `${title} ${fullContent}`);\n      if (isSyncActive()) await forceSync();\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              stored: true,\n              id: result.lastInsertRowid,\n              type: \"decision\",\n            }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"store_gotcha\",\n    \"Store a gotcha or non-obvious pitfall for future agents to avoid.\",\n    {\n      title: z.string().describe(\"Brief gotcha description\"),\n      content: z\n        .string()\n        .describe(\"Full explanation with file paths and evidence\"),\n      evidence: z\n        .string()\n        .optional()\n        .describe(\"How this was discovered\"),\n      tags: z.array(z.string()).optional(),\n    },\n    async ({ title, content, evidence, tags }) => {\n      const fullContent = evidence\n        ? `${content}\\n\\nEvidence: ${evidence}`\n        : content;\n      const tagsJson = tags ? JSON.stringify(tags) : null;\n\n      const result = db\n        .prepare(\n          `\n        INSERT INTO findings (title, content, type, confidence, importance, tags)\n        VALUES (?, ?, 'gotcha', 'high', 0.7, ?)\n      `,\n        )\n        .run(title, fullContent, tagsJson);\n\n      await storeEmbedding(db, result.lastInsertRowid, `${title} ${fullContent}`);\n      if (isSyncActive()) await forceSync();\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              stored: true,\n              id: result.lastInsertRowid,\n              type: \"gotcha\",\n            }),\n          },\n        ],\n      };\n    },\n  );\n}\n\n// Re-export for use by seed script\nexport { storeEmbedding };\n" });

  files.push({ path: "src/tools/search.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type Database from \"better-sqlite3\";\nimport { z } from \"zod\";\nimport { extractKeywords, buildFtsQuery } from \"../tokenize.js\";\nimport { runDecay, reinforce, restore } from \"../decay.js\";\n\nexport function registerSearchTools(\n  server: McpServer,\n  db: Database.Database,\n): void {\n  server.tool(\n    \"search_memory\",\n    \"Search Team11's persistent memory with a free-text query. Returns matching entries ranked by relevance.\",\n    {\n      query: z\n        .string()\n        .describe(\n          'Search query (supports AND, OR, NOT, \"phrases\", prefix*)',\n        ),\n      type_filter: z\n        .enum([\n          \"finding\",\n          \"decision\",\n          \"gotcha\",\n          \"fact\",\n          \"architecture\",\n          \"all\",\n        ])\n        .optional()\n        .default(\"all\"),\n      limit: z.number().optional().default(20),\n    },\n    async ({ query, type_filter, limit }) => {\n      const keywords = extractKeywords(query);\n      if (keywords.length === 0) {\n        return {\n          content: [\n            {\n              type: \"text\" as const,\n              text: JSON.stringify({ results: [], count: 0 }),\n            },\n          ],\n        };\n      }\n\n      const ftsQuery = buildFtsQuery(keywords);\n      let sql = `\n        SELECT f.*, bm25(findings_fts, 10.0, 1.0, 2.0) as relevance\n        FROM findings_fts fts\n        JOIN findings f ON f.id = fts.rowid\n        WHERE findings_fts MATCH ?\n      `;\n      const params: any[] = [ftsQuery];\n\n      if (type_filter && type_filter !== \"all\") {\n        sql += ` AND f.type = ?`;\n        params.push(type_filter);\n      }\n\n      sql += ` ORDER BY relevance LIMIT ?`;\n      params.push(limit);\n\n      const results = db.prepare(sql).all(...params);\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({ results, count: results.length }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"list_recent\",\n    \"List the most recent memory entries, optionally filtered by type.\",\n    {\n      type_filter: z\n        .enum([\n          \"finding\",\n          \"decision\",\n          \"gotcha\",\n          \"fact\",\n          \"architecture\",\n          \"all\",\n        ])\n        .optional()\n        .default(\"all\"),\n      limit: z.number().optional().default(20),\n      days: z\n        .number()\n        .optional()\n        .default(30)\n        .describe(\"Only show entries from the last N days\"),\n    },\n    async ({ type_filter, limit, days }) => {\n      let sql = `SELECT * FROM findings WHERE created_at >= datetime('now', ?)`;\n      const params: any[] = [`-${days} days`];\n\n      if (type_filter && type_filter !== \"all\") {\n        sql += ` AND type = ?`;\n        params.push(type_filter);\n      }\n\n      sql += ` ORDER BY created_at DESC LIMIT ?`;\n      params.push(limit);\n\n      const results = db.prepare(sql).all(...params);\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({ results, count: results.length }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"memory_stats\",\n    \"Show statistics about Team11's persistent memory database.\",\n    {},\n    async () => {\n      const stats = {\n        total: db\n          .prepare(`SELECT COUNT(*) as count FROM findings`)\n          .get(),\n        by_type: db\n          .prepare(\n            `SELECT type, COUNT(*) as count FROM findings GROUP BY type`,\n          )\n          .all(),\n        by_confidence: db\n          .prepare(\n            `SELECT confidence, COUNT(*) as count FROM findings GROUP BY confidence`,\n          )\n          .all(),\n        recent_7d: db\n          .prepare(\n            `SELECT COUNT(*) as count FROM findings WHERE created_at >= datetime('now', '-7 days')`,\n          )\n          .get(),\n        pheromones: db\n          .prepare(`SELECT COUNT(*) as count FROM pheromones`)\n          .get(),\n        oldest: db\n          .prepare(\n            `SELECT created_at FROM findings ORDER BY created_at ASC LIMIT 1`,\n          )\n          .get(),\n        newest: db\n          .prepare(\n            `SELECT created_at FROM findings ORDER BY created_at DESC LIMIT 1`,\n          )\n          .get(),\n      };\n      return {\n        content: [\n          { type: \"text\" as const, text: JSON.stringify(stats, null, 2) },\n        ],\n      };\n    },\n  );\n\n  // -- Confidence decay tools --\n\n  server.tool(\n    \"run_decay\",\n    \"Run confidence decay across all memory entries. Updates scores based on time since last reinforcement. Flags stale entries (<50%) and archives very stale ones (<25%).\",\n    {},\n    async () => {\n      const result = runDecay(db);\n      return {\n        content: [\n          { type: \"text\" as const, text: JSON.stringify(result, null, 2) },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"reinforce_finding\",\n    \"Reinforce a finding — reset its confidence decay timer. Use when an agent re-confirms a fact is still true.\",\n    {\n      id: z.number().describe(\"Finding ID to reinforce\"),\n    },\n    async ({ id }) => {\n      reinforce(db, id);\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({ reinforced: true, id }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"restore_finding\",\n    \"Restore an archived finding. Un-archives it and resets confidence to 1.0.\",\n    {\n      id: z.number().describe(\"Finding ID to restore\"),\n    },\n    async ({ id }) => {\n      restore(db, id);\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({ restored: true, id }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"list_stale\",\n    \"List findings with low confidence scores that may need re-verification or archival.\",\n    {\n      threshold: z\n        .number()\n        .optional()\n        .default(0.5)\n        .describe(\"Confidence threshold (default 0.5)\"),\n      include_archived: z.boolean().optional().default(false),\n    },\n    async ({ threshold, include_archived }) => {\n      let sql = `SELECT id, title, type, confidence_score, last_reinforced, created_at FROM findings WHERE confidence_score < ?`;\n      if (!include_archived) {\n        sql += ` AND (superseded_by IS NULL OR superseded_by = 0)`;\n      }\n      sql += ` ORDER BY confidence_score ASC`;\n\n      const results = db.prepare(sql).all(threshold);\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify(\n              { stale: results, count: results.length },\n              null,\n              2,\n            ),\n          },\n        ],\n      };\n    },\n  );\n}\n" });

  files.push({ path: "src/tools/pheromones.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type Database from \"better-sqlite3\";\nimport { z } from \"zod\";\nimport { forceSync, isSyncActive } from \"../sync.js\";\n\nexport function registerPheromoneTools(\n  server: McpServer,\n  db: Database.Database,\n): void {\n  server.tool(\n    \"store_pheromone\",\n    \"Store a pheromone trail after completing a task. Helps future agents estimate difficulty and avoid gotchas.\",\n    {\n      task: z.string().describe(\"Task description\"),\n      pair: z.string().optional(),\n      difficulty: z.enum([\"LOW\", \"MEDIUM\", \"HIGH\"]),\n      files_touched: z\n        .array(z.string())\n        .describe(\"List of files modified\"),\n      gotchas: z\n        .array(z.string())\n        .optional()\n        .describe(\"Non-obvious issues encountered\"),\n      duration_minutes: z.number().optional(),\n      rounds: z\n        .number()\n        .optional()\n        .describe(\"Number of code-audit rounds\"),\n      findings_count: z.number().optional(),\n    },\n    async ({\n      task,\n      pair,\n      difficulty,\n      files_touched,\n      gotchas,\n      duration_minutes,\n      rounds,\n      findings_count,\n    }) => {\n      const result = db\n        .prepare(\n          `\n        INSERT INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, rounds, findings_count)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?)\n      `,\n        )\n        .run(\n          task,\n          pair ?? null,\n          difficulty,\n          JSON.stringify(files_touched),\n          JSON.stringify(gotchas ?? []),\n          duration_minutes ?? null,\n          rounds ?? null,\n          findings_count ?? null,\n        );\n\n      if (isSyncActive()) await forceSync();\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              stored: true,\n              id: result.lastInsertRowid,\n            }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"get_pheromones\",\n    \"Get pheromone trail data for files or tasks. Shows what happened last time someone worked on these files.\",\n    {\n      files: z\n        .array(z.string())\n        .optional()\n        .describe(\"File paths to check pheromone data for\"),\n      task_keywords: z\n        .string()\n        .optional()\n        .describe(\"Keywords to search pheromone tasks\"),\n      limit: z.number().optional().default(10),\n    },\n    async ({ files, task_keywords, limit }) => {\n      let results: any[] = [];\n\n      if (files && files.length > 0) {\n        // Search for pheromones where any of the given files were touched\n        const placeholders = files\n          .map(() => `files_touched LIKE ?`)\n          .join(\" OR \");\n        const params = files.map((f) => `%${f}%`);\n        results = db\n          .prepare(\n            `SELECT * FROM pheromones WHERE ${placeholders} ORDER BY created_at DESC LIMIT ?`,\n          )\n          .all(...params, limit);\n      } else if (task_keywords) {\n        results = db\n          .prepare(\n            `SELECT * FROM pheromones WHERE task LIKE ? ORDER BY created_at DESC LIMIT ?`,\n          )\n          .all(`%${task_keywords}%`, limit);\n      } else {\n        results = db\n          .prepare(\n            `SELECT * FROM pheromones ORDER BY created_at DESC LIMIT ?`,\n          )\n          .all(limit);\n      }\n\n      // Parse JSON fields for readability\n      const parsed = results.map((r: any) => ({\n        ...r,\n        files_touched: safeJsonParse(r.files_touched, []),\n        gotchas: safeJsonParse(r.gotchas, []),\n      }));\n\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              pheromones: parsed,\n              count: parsed.length,\n            }),\n          },\n        ],\n      };\n    },\n  );\n}\n\nfunction safeJsonParse(str: string | null, fallback: any): any {\n  if (!str) return fallback;\n  try {\n    return JSON.parse(str);\n  } catch {\n    return fallback;\n  }\n}\n" });

  files.push({ path: "src/tools/sync.ts", content: "import type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport {\n  loadSyncConfig,\n  forceSync,\n  isSyncActive,\n} from \"../sync.js\";\n\nexport function registerSyncTools(\n  server: McpServer,\n  projectRoot: string,\n): void {\n  server.tool(\n    \"sync_status\",\n    \"Check the status of Turso sync. Returns whether sync is active and connection details.\",\n    {},\n    async () => {\n      const config = loadSyncConfig(projectRoot);\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({\n              sync_enabled: isSyncActive(),\n              provider: config?.provider || \"none\",\n              url: config?.url || \"local-only\",\n              interval_seconds: config?.syncInterval || 60,\n            }),\n          },\n        ],\n      };\n    },\n  );\n\n  server.tool(\n    \"force_sync\",\n    \"Force an immediate sync with the Turso cloud. Use after batch operations.\",\n    {},\n    async () => {\n      if (!isSyncActive()) {\n        return {\n          content: [\n            {\n              type: \"text\" as const,\n              text: JSON.stringify({\n                error:\n                  \"Sync not active. Configure sync in .team11/config.json\",\n              }),\n            },\n          ],\n        };\n      }\n      await forceSync();\n      return {\n        content: [\n          {\n            type: \"text\" as const,\n            text: JSON.stringify({ synced: true }),\n          },\n        ],\n      };\n    },\n  );\n}\n" });

  files.push({ path: "src/scripts/seed.ts", content: "import Database from \"better-sqlite3\";\nimport { readdirSync, readFileSync, existsSync, mkdirSync } from \"fs\";\nimport { join, dirname } from \"path\";\nimport { fileURLToPath } from \"url\";\nimport { createHash } from \"crypto\";\nimport { initEmbeddings, embed, embeddingsAvailable } from \"../embeddings.js\";\n\nconst __dirname = dirname(fileURLToPath(import.meta.url));\n\n// Find project root (go up from .team11/mcp-server/dist/scripts/)\nfunction findProjectRoot(): string {\n  // If TEAM11_DIR env var is set, use its parent\n  if (process.env.TEAM11_DIR) {\n    return dirname(process.env.TEAM11_DIR);\n  }\n  // Otherwise walk up from script location\n  let dir = __dirname;\n  for (let i = 0; i < 10; i++) {\n    if (existsSync(join(dir, '.team11'))) return dir;\n    dir = dirname(dir);\n  }\n  throw new Error(\"Could not find project root (no .team11/ directory found)\");\n}\n\nconst projectRoot = findProjectRoot();\nconst team11Dir = join(projectRoot, \".team11\");\nconst dbPath = join(team11Dir, \"memory.db\");\n\nconsole.log(`Seeding Team11 memory database at: ${dbPath}`);\nconsole.log(`Reading findings from: ${join(team11Dir, \"findings\")}`);\n\n// Import initDb from our db module\n// Since we're running from dist/, import relatively\nimport { initDb } from \"../db.js\";\n\nconst db = initDb(dbPath);\n\n// Parse a finding .md file\nfunction parseFindingMd(content: string, filePath: string) {\n  const title = content.match(/^#\\s+(.+)/m)?.[1] || filePath;\n  const type = content.match(/\\*\\*Type:\\*\\*\\s+(.+)/)?.[1]?.trim() || \"finding\";\n  const date = content.match(/\\*\\*Date:\\*\\*\\s+(.+)/)?.[1]?.trim();\n  const author = content.match(/\\*\\*Author:\\*\\*\\s+(.+)/)?.[1]?.trim();\n  const confidence = content.match(/\\*\\*Confidence:\\*\\*\\s+(.+)/)?.[1]?.trim() || \"medium\";\n\n  // Get content (everything after the header block, before Sources)\n  const sections = content.split(/^## /m).slice(1);\n  const mainContent = sections\n    .filter(s => !s.startsWith(\"Sources\"))\n    .map(s => s.trim())\n    .join(\"\\n\\n## \");\n\n  return {\n    title: title.replace(/^#+\\s*/, ''),\n    content: mainContent || content,\n    type: mapType(type),\n    confidence: mapConfidence(confidence),\n    source_file: filePath,\n    source_pair: author || null,\n    created_at: date || new Date().toISOString().split('T')[0],\n  };\n}\n\nfunction mapType(raw: string): string {\n  const lower = raw.toLowerCase();\n  if (lower.includes('decision')) return 'decision';\n  if (lower.includes('gotcha')) return 'gotcha';\n  if (lower.includes('fact')) return 'fact';\n  if (lower.includes('architecture')) return 'architecture';\n  return 'finding';\n}\n\nfunction mapConfidence(raw: string): string {\n  const lower = raw.toLowerCase();\n  if (lower.includes('high')) return 'high';\n  if (lower.includes('low')) return 'low';\n  return 'medium';\n}\n\n// Initialize embedding model before seeding\nawait initEmbeddings();\n\n// Seed findings\nconst findingsDir = join(team11Dir, \"findings\");\nif (existsSync(findingsDir)) {\n  const files = readdirSync(findingsDir).filter(f => f.endsWith('.md'));\n  console.log(`Found ${files.length} finding files`);\n\n  const insertStmt = db.prepare(`\n    INSERT OR IGNORE INTO findings (title, content, type, confidence, source_file, source_pair, created_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?)\n  `);\n\n  let count = 0;\n  for (const file of files) {\n    const content = readFileSync(join(findingsDir, file), \"utf8\");\n    const parsed = parseFindingMd(content, file);\n\n    try {\n      insertStmt.run(\n        parsed.title,\n        parsed.content,\n        parsed.type,\n        parsed.confidence,\n        parsed.source_file,\n        parsed.source_pair,\n        parsed.created_at\n      );\n      count++;\n      console.log(`  Seeded: ${parsed.title} (${parsed.type})`);\n    } catch (err: any) {\n      console.error(`  Error seeding ${file}: ${err.message}`);\n    }\n  }\n\n  console.log(`\\nSeeded ${count} findings into memory.db`);\n} else {\n  console.log(\"No findings directory found, skipping\");\n}\n\n// Generate embeddings for all findings that don't have one yet\nif (embeddingsAvailable()) {\n  const allFindings = db.prepare(`SELECT id, title, content FROM findings`).all() as { id: number; title: string; content: string }[];\n  let embeddedCount = 0;\n  for (const finding of allFindings) {\n    const text = `${finding.title} ${finding.content}`;\n    const contentHash = createHash(\"sha256\").update(text).digest(\"hex\");\n\n    // Skip if already cached with same hash\n    const cached = db.prepare(`SELECT content_hash FROM embedding_cache WHERE finding_id = ?`).get(finding.id) as { content_hash: string } | undefined;\n    if (cached && cached.content_hash === contentHash) continue;\n\n    const vector = await embed(text);\n    if (!vector) continue;\n\n    const vectorBlob = Buffer.from(vector.buffer);\n    const findingId = Number(finding.id);\n    db.prepare(`INSERT OR REPLACE INTO findings_vec (finding_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(findingId, vectorBlob);\n    db.prepare(`INSERT OR REPLACE INTO embedding_cache (finding_id, content_hash, embedding) VALUES (?, ?, ?)`).run(findingId, contentHash, vectorBlob);\n    embeddedCount++;\n  }\n  console.log(`Generated embeddings for ${embeddedCount} findings`);\n} else {\n  console.log(\"Embeddings not available, skipping vector indexing\");\n}\n\n// Seed pheromones from pheromones.json\nconst pheromonesPath = join(team11Dir, \"pheromones.json\");\nif (existsSync(pheromonesPath)) {\n  const data = JSON.parse(readFileSync(pheromonesPath, \"utf8\"));\n  if (data.trails && data.trails.length > 0) {\n    const insertPheromone = db.prepare(`\n      INSERT OR IGNORE INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, rounds, findings_count, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n    `);\n\n    let count = 0;\n    for (const trail of data.trails) {\n      try {\n        insertPheromone.run(\n          trail.task,\n          trail.pair ? String(trail.pair) : null,\n          trail.difficulty || 'MEDIUM',\n          JSON.stringify(trail.files || []),\n          JSON.stringify(trail.gotchas || []),\n          trail.duration_minutes || trail.actual_duration_min || null,\n          trail.rounds || null,\n          trail.findings_count || null,\n          trail.date || new Date().toISOString().split('T')[0]\n        );\n        count++;\n      } catch (err: any) {\n        console.error(`  Error seeding pheromone: ${err.message}`);\n      }\n    }\n    console.log(`Seeded ${count} pheromone trails`);\n  }\n} else {\n  console.log(\"No pheromones.json found, skipping\");\n}\n\n// Print stats\nconst total = db.prepare(`SELECT COUNT(*) as count FROM findings`).get() as any;\nconst byType = db.prepare(`SELECT type, COUNT(*) as count FROM findings GROUP BY type`).all();\nconst pheromoneCount = db.prepare(`SELECT COUNT(*) as count FROM pheromones`).get() as any;\n\nconsole.log(`\\n--- Memory DB Stats ---`);\nconsole.log(`Total findings: ${total.count}`);\nfor (const t of byType) {\n  console.log(`  ${(t as any).type}: ${(t as any).count}`);\n}\nconsole.log(`Pheromone trails: ${pheromoneCount.count}`);\nconsole.log(`Database: ${dbPath}`);\n\ndb.close();\n" });


  // Write all files
  for (const file of files) {
    const fullPath = join(mcpServerDir, file.path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  console.log("  Wrote " + files.length + " source files");
}
