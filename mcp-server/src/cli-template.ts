#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

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

  // Step 2: Write all source files
  console.log("Writing MCP server source files...");
  writeSourceFiles(mcpServerDir);

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
// writeSourceFiles -- embeds ALL TypeScript source files as JSON strings
// -----------------------------------------------------------------------
function writeSourceFiles(mcpServerDir: string) {
  const files: Array<{ path: string; content: string }> = [];

/* __EMBEDDED_SOURCE_FILES__ */

  // Write all files
  for (const file of files) {
    const fullPath = join(mcpServerDir, file.path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  console.log("  Wrote " + files.length + " source files");
}
