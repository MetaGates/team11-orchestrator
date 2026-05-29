import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { initEmbeddings, embeddingsAvailable } from "../embeddings.js";
import { storeEmbedding } from "../tools/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find project root (go up from .team11/mcp-server/dist/scripts/)
function findProjectRoot(): string {
  // If TEAM11_DIR env var is set, use its parent
  if (process.env.TEAM11_DIR) {
    return dirname(process.env.TEAM11_DIR);
  }
  // Otherwise walk up from script location
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.team11'))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not find project root (no .team11/ directory found)");
}

const projectRoot = findProjectRoot();
const team11Dir = join(projectRoot, ".team11");
const dbPath = join(team11Dir, "memory.db");

console.log(`Seeding Team11 memory database at: ${dbPath}`);
console.log(`Reading findings from: ${join(team11Dir, "findings")}`);

// Import initDb from our db module
// Since we're running from dist/, import relatively
import { initDb } from "../db.js";

const db = initDb(dbPath);

// Parse a finding .md file
function parseFindingMd(content: string, filePath: string) {
  const title = content.match(/^#\s+(.+)/m)?.[1] || filePath;
  const type = content.match(/\*\*Type:\*\*\s+(.+)/)?.[1]?.trim() || "finding";
  const date = content.match(/\*\*Date:\*\*\s+(.+)/)?.[1]?.trim();
  const author = content.match(/\*\*Author:\*\*\s+(.+)/)?.[1]?.trim();
  const confidence = content.match(/\*\*Confidence:\*\*\s+(.+)/)?.[1]?.trim() || "medium";

  // Get content (everything after the header block, before Sources)
  const sections = content.split(/^## /m).slice(1);
  const mainContent = sections
    .filter(s => !s.startsWith("Sources"))
    .map(s => s.trim())
    .join("\n\n## ");

  return {
    title: title.replace(/^#+\s*/, ''),
    content: mainContent || content,
    type: mapType(type),
    confidence: mapConfidence(confidence),
    source_file: filePath,
    source_pair: author || null,
    created_at: date || new Date().toISOString().split('T')[0],
  };
}

function mapType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('decision')) return 'decision';
  if (lower.includes('gotcha')) return 'gotcha';
  if (lower.includes('fact')) return 'fact';
  if (lower.includes('architecture')) return 'architecture';
  return 'finding';
}

function mapConfidence(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('high')) return 'high';
  if (lower.includes('low')) return 'low';
  return 'medium';
}

// Initialize embedding model before seeding
await initEmbeddings();

// Seed findings
const findingsDir = join(team11Dir, "findings");
if (existsSync(findingsDir)) {
  const files = readdirSync(findingsDir).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} finding files`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO findings (title, content, type, confidence, source_file, source_pair, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of files) {
    const content = readFileSync(join(findingsDir, file), "utf8");
    const parsed = parseFindingMd(content, file);

    try {
      insertStmt.run(
        parsed.title,
        parsed.content,
        parsed.type,
        parsed.confidence,
        parsed.source_file,
        parsed.source_pair,
        parsed.created_at
      );
      count++;
      console.log(`  Seeded: ${parsed.title} (${parsed.type})`);
    } catch (err: any) {
      console.error(`  Error seeding ${file}: ${err.message}`);
    }
  }

  console.log(`\nSeeded ${count} findings into memory.db`);
} else {
  console.log("No findings directory found, skipping");
}

// Generate embeddings for all findings that don't have one yet.
// Reuse storeEmbedding (the single source of truth for the hash-check +
// transactional vec/cache write) so a model swap invalidates seed vectors the
// same way it does for live writes — no parallel copy of the insert logic here.
if (embeddingsAvailable()) {
  const allFindings = db.prepare(`SELECT id, title, content FROM findings`).all() as { id: number; title: string; content: string }[];
  let embeddedCount = 0;
  for (const finding of allFindings) {
    const before = db.prepare(`SELECT content_hash FROM embedding_cache WHERE finding_id = ?`).get(finding.id) as { content_hash: string } | undefined;
    await storeEmbedding(db, finding.id, `${finding.title} ${finding.content}`);
    const after = db.prepare(`SELECT content_hash FROM embedding_cache WHERE finding_id = ?`).get(finding.id) as { content_hash: string } | undefined;
    if (after && after.content_hash !== before?.content_hash) embeddedCount++;
  }
  console.log(`Generated embeddings for ${embeddedCount} findings`);
} else {
  console.log("Embeddings not available, skipping vector indexing");
}

// Seed pheromones from pheromones.json
const pheromonesPath = join(team11Dir, "pheromones.json");
if (existsSync(pheromonesPath)) {
  const data = JSON.parse(readFileSync(pheromonesPath, "utf8"));
  if (data.trails && data.trails.length > 0) {
    const insertPheromone = db.prepare(`
      INSERT OR IGNORE INTO pheromones (task, pair, difficulty, files_touched, gotchas, duration_minutes, rounds, findings_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    for (const trail of data.trails) {
      try {
        insertPheromone.run(
          trail.task,
          trail.pair ? String(trail.pair) : null,
          trail.difficulty || 'MEDIUM',
          JSON.stringify(trail.files || []),
          JSON.stringify(trail.gotchas || []),
          trail.duration_minutes || trail.actual_duration_min || null,
          trail.rounds || null,
          trail.findings_count || null,
          trail.date || new Date().toISOString().split('T')[0]
        );
        count++;
      } catch (err: any) {
        console.error(`  Error seeding pheromone: ${err.message}`);
      }
    }
    console.log(`Seeded ${count} pheromone trails`);
  }
} else {
  console.log("No pheromones.json found, skipping");
}

// Print stats
const total = db.prepare(`SELECT COUNT(*) as count FROM findings`).get() as any;
const byType = db.prepare(`SELECT type, COUNT(*) as count FROM findings GROUP BY type`).all();
const pheromoneCount = db.prepare(`SELECT COUNT(*) as count FROM pheromones`).get() as any;

console.log(`\n--- Memory DB Stats ---`);
console.log(`Total findings: ${total.count}`);
for (const t of byType) {
  console.log(`  ${(t as any).type}: ${(t as any).count}`);
}
console.log(`Pheromone trails: ${pheromoneCount.count}`);
console.log(`Database: ${dbPath}`);

db.close();
