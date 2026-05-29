/**
 * bootstrap.ts — Run from inside a project's .team11/mcp-server/ to get everything working.
 *
 * Usage: cd <project>/.team11/mcp-server && node dist/scripts/bootstrap.js
 *
 * Checks what's missing and fixes it:
 *   - node_modules missing? → npm install
 *   - dist/ missing? → npm run build
 *   - memory.db missing or tables missing? → initDb()
 *   - config.json missing? → creates solo default
 *   - pheromones.json missing? → creates empty
 *   - hive.md missing? → creates default
 *   - .gitignore missing Team11 entries? → adds them
 *   - .mcp.json missing team11-memory? → adds it
 *
 * Safe to run repeatedly — skips anything already done.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { initDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team11"))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume we're in .team11/mcp-server/dist/scripts/
  return resolve(__dirname, "..", "..", "..", "..");
}

function main() {
  const projectRoot = findProjectRoot();
  const team11Dir = join(projectRoot, ".team11");
  const mcpDir = join(team11Dir, "mcp-server");
  const projectName = projectRoot.split(/[\\/]/).pop() || "project";

  console.log(`\nTeam11 Bootstrap — ${projectName}`);
  console.log(`Project: ${projectRoot}\n`);

  let fixes = 0;

  // 1. State directories
  for (const d of ["logs", "findings", "checkpoints", "stale", "inboxes", "proposals"]) {
    const p = join(team11Dir, d);
    if (!existsSync(p)) { mkdirSync(p, { recursive: true }); fixes++; }
  }
  console.log(`[1/7] State directories: OK`);

  // 2. config.json
  const configPath = join(team11Dir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      mode: "solo",
      operator: null,
      repo: null,
      pre_verification: { enabled: false, commands: [] }
    }, null, 2));
    console.log(`[2/7] config.json: CREATED (solo mode)`);
    fixes++;
  } else {
    console.log(`[2/7] config.json: OK`);
  }

  // 3. Database
  const dbPath = join(team11Dir, "memory.db");
  try {
    const db = initDb(dbPath);
    const tables = (db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as {c: number}).c;
    db.close();
    console.log(`[3/7] Database: OK (${tables} tables)`);
    if (!existsSync(dbPath.replace("memory.db", "") + "memory.db")) fixes++; // new DB
  } catch (err: any) {
    console.log(`[3/7] Database: ERROR — ${err.message}`);
  }

  // 4. pheromones.json
  const pheroPath = join(team11Dir, "pheromones.json");
  if (!existsSync(pheroPath)) {
    writeFileSync(pheroPath, JSON.stringify({ trails: [] }, null, 2));
    console.log(`[4/7] pheromones.json: CREATED`);
    fixes++;
  } else {
    console.log(`[4/7] pheromones.json: OK`);
  }

  // 5. hive.md
  const hivePath = join(team11Dir, "hive.md");
  if (!existsSync(hivePath)) {
    const date = new Date().toISOString().split("T")[0];
    writeFileSync(hivePath, `# Hive Mind
**Project:** ${projectName}
**Date:** ${date}
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
    console.log(`[5/7] hive.md: CREATED`);
    fixes++;
  } else {
    console.log(`[5/7] hive.md: OK`);
  }

  // 6. .gitignore
  const gitignorePath = join(projectRoot, ".gitignore");
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.includes(".team11/config.json")) {
    const block = `
# Team11 state (ephemeral)
.team11/config.json
.team11/memory.db
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
.team11/mcp-server/dist/
.team11/mcp-server/node_modules/
!.team11/mcp-server/
!.team11/mcp-server/src/
!.team11/mcp-server/src/**
!.team11/mcp-server/package.json
!.team11/mcp-server/package-lock.json
!.team11/mcp-server/tsconfig.json
!.team11/mcp-server/README.md
`;
    let updated = gitignore.replace(/^\.team11\/\s*$/m, "");
    updated = updated.trimEnd() + "\n" + block;
    writeFileSync(gitignorePath, updated);
    console.log(`[6/7] .gitignore: UPDATED`);
    fixes++;
  } else {
    console.log(`[6/7] .gitignore: OK`);
  }

  // 7. .mcp.json
  const mcpPath = join(projectRoot, ".mcp.json");
  let mcp: any = {};
  if (existsSync(mcpPath)) {
    try { mcp = JSON.parse(readFileSync(mcpPath, "utf8")); } catch { /* fresh */ }
  }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  if (!mcp.mcpServers["team11-memory"]) {
    mcp.mcpServers["team11-memory"] = {
      command: "node",
      args: [".team11/mcp-server/dist/index.js"],
      env: { TEAM11_MEMORY_DB: ".team11/memory.db" }
    };
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
    console.log(`[7/7] .mcp.json: ADDED team11-memory`);
    fixes++;
  } else {
    console.log(`[7/7] .mcp.json: OK`);
  }

  console.log(`\n${fixes === 0 ? "Everything already set up." : `Fixed ${fixes} item(s).`}`);
  console.log(`\nNext: add "team11-memory" to enabledMcpjsonServers in .claude/settings.local.json, then restart Claude Code.\n`);
}

main();
