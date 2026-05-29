const Database = require("better-sqlite3");
const db = new Database("C:/Users/dzste/OneDrive/Documents/loop/.team11/memory.db");

// Check which tables exist
const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);

let edits = [];
let ops = [];
let contras = [];

if (tableNames.includes("active_edits")) {
  edits = db.prepare("SELECT * FROM active_edits WHERE released_at IS NULL ORDER BY claimed_at DESC").all();
}
if (tableNames.includes("operators")) {
  ops = db.prepare("SELECT * FROM operators ORDER BY last_active DESC").all();
}
if (tableNames.includes("contradictions")) {
  contras = db.prepare("SELECT * FROM contradictions WHERE status = 'OPEN' ORDER BY created_at DESC").all();
}

const facts = db.prepare("SELECT * FROM findings WHERE type IN ('fact','decision') AND (superseded_by IS NULL OR superseded_by = 0) ORDER BY created_at DESC LIMIT 20").all();
const trails = db.prepare("SELECT * FROM pheromones ORDER BY created_at DESC LIMIT 10").all();

console.log(JSON.stringify({ edits, ops, facts, trails, contras, tableNames }, null, 2));
db.close();
