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
      const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      // Valid JSON can still be null / an array / a primitive. Only adopt it
      // when it's a real object — otherwise the `.mcpServers` write below (which
      // is OUTSIDE this try) dereferences null → uncaught TypeError that aborts
      // init mid-run, or mutates an array into a malformed .mcp.json. Bad/missing
      // → keep the fresh { mcpServers: {} } default.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        mcpConfig = parsed as Record<string, unknown>;
      }
    } catch { /* malformed JSON — keep the fresh default */ }
  }
  if (
    !mcpConfig.mcpServers ||
    typeof mcpConfig.mcpServers !== "object" ||
    Array.isArray(mcpConfig.mcpServers)
  ) {
    mcpConfig.mcpServers = {};
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
  Tools:       28 MCP tools registered

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
