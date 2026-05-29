/**
 * init-project.ts — Initialize Team11 MCP memory in a new project.
 *
 * Usage: node dist/scripts/init-project.js [project-root]
 *
 * If project-root is omitted, uses the current working directory.
 *
 * What it does:
 *   1. Creates .team11/ directory structure
 *   2. Copies MCP server source to .team11/mcp-server/
 *   3. Runs npm install + npm run build
 *   4. Creates .team11/config.json (solo mode, no sync)
 *   5. Adds .team11/ entries to .gitignore
 *   6. Creates or updates .mcp.json with team11-memory entry
 *   7. Initializes the SQLite database (all tables)
 *   8. Prints next steps
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findMcpServerRoot(): string {
  // Walk up from dist/scripts/ to find package.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not find MCP server root");
}

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

const GITIGNORE_BLOCK = `
# Team11 state (ephemeral, gitignored)
.team11/config.json
.team11/memory.db
.team11/memory.db-*
.team11/memory.db-*
.team11/knowledge-graph.jsonl
.team11/logs/
.team11/findings/
.team11/checkpoints/
.team11/stale/
.team11/inboxes/
.team11/proposals/
.team11/hive.md
.team11/pheromones.json
.team11/_outbox.json
.team11/_secretary_query.cjs

# Team11 MCP server build artifacts
.team11/mcp-server/dist/
.team11/mcp-server/node_modules/

# Allow MCP server source (safe to commit)
!.team11/mcp-server/
!.team11/mcp-server/src/
!.team11/mcp-server/src/**
!.team11/mcp-server/package.json
!.team11/mcp-server/package-lock.json
!.team11/mcp-server/tsconfig.json
!.team11/mcp-server/README.md
`;

function main() {
  const projectRoot = resolve(process.argv[2] || process.cwd());
  const mcpServerSrc = findMcpServerRoot();
  const team11Dir = join(projectRoot, ".team11");
  const destMcpServer = join(team11Dir, "mcp-server");

  console.log(`\nTeam11 Memory — Project Init`);
  console.log(`Project root: ${projectRoot}`);
  console.log(`Source MCP server: ${mcpServerSrc}\n`);

  // 1. Create .team11/ structure
  const dirs = ["logs", "findings", "checkpoints", "stale", "inboxes", "proposals"];
  for (const d of dirs) {
    mkdirSync(join(team11Dir, d), { recursive: true });
  }
  console.log(`[1/7] Created .team11/ directory structure`);

  // 2. Copy MCP server source (excluding dist, node_modules)
  if (resolve(mcpServerSrc) === resolve(destMcpServer)) {
    console.log(`[2/7] MCP server already in place (same project)`);
  } else {
    const copied = copyDirRecursive(mcpServerSrc, destMcpServer, ["dist", "node_modules", ".git"]);
    console.log(`[2/7] Copied MCP server source (${copied} files)`);
  }

  // 3. Install + build
  console.log(`[3/7] Installing dependencies...`);
  try {
    execSync("npm install", { cwd: destMcpServer, stdio: "pipe" });
    console.log(`      npm install done`);
    execSync("npm run build", { cwd: destMcpServer, stdio: "pipe" });
    console.log(`      npm run build done`);
  } catch (err: any) {
    console.error(`      ERROR: ${err.message}`);
    console.error(`      Run manually: cd ${destMcpServer} && npm install && npm run build`);
  }

  // 4. Create config.json (solo, no sync)
  const configPath = join(team11Dir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      mode: "solo",
      operator: null,
      repo: null,
      pre_verification: {
        enabled: false,
        commands: []
      }
    }, null, 2));
    console.log(`[4/7] Created .team11/config.json (solo mode)`);
  } else {
    console.log(`[4/7] .team11/config.json already exists — skipped`);
  }

  // 5. Update .gitignore
  const gitignorePath = join(projectRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(".team11/config.json")) {
    console.log(`[5/7] .gitignore already has Team11 entries — skipped`);
  } else {
    // Remove any blanket .team11/ ignore
    let updated = existing.replace(/^\.team11\/\s*$/m, "");
    updated = updated.trimEnd() + "\n" + GITIGNORE_BLOCK;
    writeFileSync(gitignorePath, updated);
    console.log(`[5/7] Updated .gitignore with Team11 entries`);
  }

  // 6. Create/update .mcp.json
  const mcpJsonPath = join(projectRoot, ".mcp.json");
  let mcpConfig: any = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      // Valid JSON can still be null / an array / a primitive. Only adopt it
      // when it's a real object — otherwise the `.mcpServers` access below
      // would throw (null) or corrupt the file (array/primitive) OUTSIDE this
      // try, aborting init mid-run. Bad/missing → fall back to a fresh object.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        mcpConfig = parsed;
      }
    } catch { /* malformed JSON — keep the fresh default */ }
  }
  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object" || Array.isArray(mcpConfig.mcpServers)) {
    mcpConfig.mcpServers = {};
  }
  if (!mcpConfig.mcpServers["team11-memory"]) {
    mcpConfig.mcpServers["team11-memory"] = {
      command: "node",
      args: [".team11/mcp-server/dist/index.js"],
      env: {
        TEAM11_MEMORY_DB: ".team11/memory.db"
      }
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`[6/7] Added team11-memory to .mcp.json`);
  } else {
    console.log(`[6/7] team11-memory already in .mcp.json — skipped`);
  }

  // 7. Initialize the database
  try {
    const dbPath = join(team11Dir, "memory.db").replace(/\\/g, "/");
    // Run the freshly-built dist/db.js::initDb in a separate node process via
    // execFileSync (argv form, NO shell) — mirrors cli-template.ts. Paths are
    // embedded with JSON.stringify and passed as a -e argument, so no shell
    // metacharacter in any path can be interpreted (RCE-class fix; sibling
    // cli/summaries were hardened in 45eb4a576, this call site was missed).
    const initScript =
      `import { initDb } from './dist/db.js'; ` +
      `const db = initDb(${JSON.stringify(dbPath)}); ` +
      `const tables = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get(); ` +
      `console.log(JSON.stringify(tables)); db.close();`;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", initScript], {
      cwd: destMcpServer,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(result.trim());
    console.log(`[7/7] Database initialized (${parsed.c} tables)`);
  } catch (err: any) {
    console.log(`[7/7] Database will be initialized on first MCP server start`);
  }

  // 8. Create empty pheromones.json
  const pheromonePath = join(team11Dir, "pheromones.json");
  if (!existsSync(pheromonePath)) {
    writeFileSync(pheromonePath, JSON.stringify({ trails: [] }, null, 2));
  }

  // 9. Create empty hive.md
  const hivePath = join(team11Dir, "hive.md");
  if (!existsSync(hivePath)) {
    const projectName = projectRoot.split(/[\\/]/).pop() || "project";
    writeFileSync(hivePath, `# Hive Mind
**Project:** ${projectName}
**Date:** ${new Date().toISOString().split("T")[0]}
**Type:** hive-mind
**Version:** 1

## Active Edits
| Pair | Agent | File | Action | Status | Timestamp |
|------|-------|------|--------|--------|-----------|

## Discovered Facts
| ID | Fact | Source | Confidence | Last Reinforced | Timestamp |
|----|------|--------|------------|-----------------|-----------|

## Decisions
| ID | Decision | Rationale | Decided By | Timestamp |
|----|----------|-----------|------------|-----------|

## Contradictions
| ID | Claim A | Source A | Claim B | Source B | Resolution | Status |
|----|---------|----------|---------|----------|------------|--------|

## Pheromone Trails
| Date | Pair | Task | Difficulty | Files Touched | Gotchas | Duration |
|------|------|------|------------|---------------|---------|----------|
`);
  }

  console.log(`
TEAM11 MEMORY INITIALIZED
  Project: ${projectRoot}
  DB: .team11/memory.db
  MCP: .team11/mcp-server/ (${existsSync(join(destMcpServer, "dist", "index.js")) ? "built" : "needs build"})
  Mode: solo (no sync)

Next steps:
  1. Add "team11-memory" to enabledMcpjsonServers in .claude/settings.local.json
  2. Restart Claude Code
  3. Run /team11 setup to create worktrees
  4. (Optional) Add Turso sync: edit .team11/config.json with sync block
`);
}

main();
