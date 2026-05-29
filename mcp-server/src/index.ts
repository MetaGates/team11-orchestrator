import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db.js";
import { initEmbeddings } from "./embeddings.js";
import { registerTools } from "./tools/index.js";
import { loadSyncConfig, initSync, shutdownSync } from "./sync.js";
import { resolve, isAbsolute, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Find the project root by walking up from a starting directory
 * until we find a .team11/ directory.
 */
function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(resolve(dir, ".team11"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve the database path. If it's relative, resolve it relative to:
 *   1. PROJECT_ROOT env var (if set)
 *   2. The project root (found by walking up from __dirname to find .team11/)
 *   3. Fall back to CWD (original behavior)
 */
function resolveDbPath(raw: string): string {
  if (isAbsolute(raw)) return raw;

  // Try PROJECT_ROOT env var first
  if (process.env.PROJECT_ROOT) {
    return resolve(process.env.PROJECT_ROOT, raw);
  }

  // Walk up from script location to find project root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = findProjectRoot(__dirname);
  if (projectRoot) {
    return resolve(projectRoot, raw);
  }

  // Fallback: resolve relative to CWD
  return resolve(raw);
}

const server = new McpServer({
  name: "team11-memory",
  version: "1.0.0",
  description: "Persistent memory for Team11 multi-agent orchestration",
});

// Initialize database — path configurable via env var
const rawDbPath = process.env.TEAM11_MEMORY_DB || ".team11/memory.db";
const dbPath = resolveDbPath(rawDbPath);
const db = initDb(dbPath);

// Initialize embedding model (non-blocking — FTS5 works without it)
await initEmbeddings();

// Resolve project root for config loading
const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = dirname(__filename2);
const projectRoot =
  process.env.PROJECT_ROOT || findProjectRoot(__dirname2) || process.cwd();

// Initialize Turso sync (opt-in — disabled by default)
const syncConfig = loadSyncConfig(projectRoot);
if (syncConfig) {
  await initSync(dbPath, syncConfig);
}

// Register all tools (pass projectRoot for sync tools)
registerTools(server, db, projectRoot);

// Graceful shutdown — clean up sync resources
process.on("SIGINT", () => {
  shutdownSync();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownSync();
  process.exit(0);
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
