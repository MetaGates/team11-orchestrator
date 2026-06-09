# Team11 Memory — MCP Server

Persistent memory for Team11 multi-agent orchestration. Stores findings, decisions, gotchas, and pheromone trails in a local SQLite database with FTS5 full-text search, sqlite-vec vector search, and optional Turso cloud sync for team collaboration.

## Quick Start

**One command (recommended)** — installs, builds, then `bootstrap.js` fixes whatever else is missing (DB init, `config.json`, `pheromones.json`, `hive.md`, `.gitignore`, `.mcp.json`). Safe to re-run:

```bash
cd .team11/mcp-server && npm install && npm run build && node dist/scripts/bootstrap.js
```

**Or step by step:**

```bash
cd .team11/mcp-server
npm install
npm run build
npm run seed    # Import existing .team11/findings/*.md into the database
```

**Brand-new project?** `node dist/scripts/init-project.js [project-root]` scaffolds `.team11/`, copies the server in, installs + builds, initializes the DB, and wires `.gitignore` + `.mcp.json` in one shot.

The MCP server auto-discovers via `.mcp.json` in the project root. Restart Claude Code after setup.

## How It Works

```
Agent asks: "What do we know about mobile UI?"
                    ↓
         recall_context("mobile UI")
                    ↓
    ┌─────────────────────────────┐
    │  FTS5 keyword search        │──→ BM25 ranked results
    │  sqlite-vec vector search   │──→ semantic similarity results
    │  Reciprocal Rank Fusion     │──→ merged + scored
    │  Token budget enforcement   │──→ fits in ~8K tokens
    └─────────────────────────────┘
                    ↓
    Structured context bundle:
    - Findings (from last month's audit)
    - Decisions (settled architectural choices)
    - Gotchas (pitfalls to avoid)
    - Pheromone trails (what happened last time)
```

### What Gets Stored

| Data Type | When It Enters | Example |
|-----------|---------------|---------|
| **Findings** | CEO merges pair work | "CSP blocks inline styles in HUD.js" |
| **Decisions** | Human approves architecture | "Use bottom-sheet pattern for mobile panels" |
| **Gotchas** | Agent discovers pitfall | "Nakama ES5 target — no Object.values()" |
| **Pheromone trails** | After every completed task | "Mobile HUD: HIGH difficulty, 15 files, 45 min" |
| **Facts** | Agent discovers non-obvious truth | "CompositeRenderer uses ImageData caching" |

### How It Saves Tokens

Without memory: agents re-read files, re-discover gotchas, re-debate decisions. ~50K+ tokens wasted per session.

With memory: `recall_context()` returns ~8K tokens of curated, relevant knowledge. Agents start informed.

## Tools (28 total)

### Core
| Tool | Description |
|------|-------------|
| `recall_context` | **Primary tool.** Retrieve relevant context for a task. Hybrid FTS5 + vector search, scored and token-budgeted. |
| `get_detail` | Get full content of a specific entry by ID (after recall_context returns summaries). |

### Store
| Tool | Description |
|------|-------------|
| `store_finding` | Store a finding, decision, gotcha, or fact. Auto-generates embedding. |
| `store_decision` | Store a decision with rationale. Sets confidence=high, importance=0.8. |
| `store_gotcha` | Store a non-obvious pitfall with evidence. Sets confidence=high, importance=0.7. |
| `store_pheromone` | Store a pheromone trail after task completion (difficulty, files, gotchas, duration, verdict_breakdown). |

### Search
| Tool | Description |
|------|-------------|
| `search_memory` | Free-text FTS5 search with optional type filter. |
| `list_recent` | List recent entries by type and time window. |
| `memory_stats` | Database statistics (counts by type, confidence, recent activity). |

### Pheromones
| Tool | Description |
|------|-------------|
| `get_pheromones` | Look up pheromone data for specific files or task keywords. |

### Confidence Decay
| Tool | Description |
|------|-------------|
| `run_decay` | Run confidence decay (5% weekly **after a 14-day grace period**). Flags stale (≤50%), archives very stale (≤25%). Also runs summary GC. |
| `reinforce_finding` | Re-confirm a finding: **+20% confidence (capped at 1.0)** and reset the decay clock. |
| `restore_finding` | Un-archive a finding, reset confidence to 1.0. |
| `list_stale` | List findings below a confidence threshold. |

### Summarization Cache
| Tool | Description |
|------|-------------|
| `get_file_summary` | Check cache for a git-aware file summary (keyed by blob SHA). Returns cached summary or `{cached: false}`. |
| `store_file_summary` | Store an AI-generated structural summary of a file. Keyed by blob SHA — auto-invalidates when file changes. |

### Contradictions
| Tool | Description |
|------|-------------|
| `store_contradiction` | Store a contradiction between two claims discovered by agents. |
| `resolve_contradiction` | Resolve a previously stored contradiction. |
| `list_contradictions` | List contradictions filtered by status (OPEN, RESOLVED, DEFERRED, ALL). |

### Coordination (Cross-Operator)
| Tool | Description |
|------|-------------|
| `claim_file` | Claim a file for editing. Blocks if already claimed by another pair/operator. |
| `release_file` | Release all file claims for a pair (after merge). |
| `list_active_edits` | List all currently claimed files across all operators. |
| `register_operator` | Register or update a Team11 operator. |
| `list_operators` | List all registered operators. |
| `heartbeat_operator` | Update an operator's last_active timestamp. |

### Health
| Tool | Description |
|------|-------------|
| `health_check` | DB table counts (incl. WAL/SHM size), Turso sync status, embedding availability, tool count. |

### Sync
| Tool | Description |
|------|-------------|
| `sync_status` | Check Turso sync status and connection details. |
| `force_sync` | Force immediate sync with Turso cloud. |

## Search Architecture

### Hybrid Search (FTS5 + Vector)

`recall_context` runs two searches in parallel and merges results:

1. **FTS5 keyword search** — exact term matching with BM25 ranking. Best for specific identifiers, file names, error messages.
2. **Vector search (sqlite-vec)** — semantic similarity via all-MiniLM-L6-v2 embeddings (384 dimensions). Best for conceptual queries ("how do we handle real-time sync?").
3. **Reciprocal Rank Fusion** — merges both result sets with k=60. Items found by both searches rank highest.

### Scoring

Each result gets a composite score:
```
score = RRF_rank × confidence_score
where RRF considers:
  BM25 relevance    (40%)
  Importance weight  (25%)
  Recency           (20%)  — decays over 90 days
  Access frequency  (15%)  — caps at 10 accesses
```

Low-confidence entries (from decay) are deprioritized multiplicatively.

### FTS5 Tokenization

A custom preprocessor splits code identifiers before indexing:
- `CharacterPanel` → `Character Panel`
- `snake_case_name` → `snake case name`
- `src/ui/HUD.js` → `src ui HUD js`

This means searching "character panel" finds `CharacterPanel`.

## Embeddings

- **Model:** all-MiniLM-L6-v2 (384 dimensions, ~22MB)
- **Runtime:** @huggingface/transformers (ONNX, CPU inference)
- **First run:** Downloads model (~3 seconds)
- **Per embedding:** ~10-50ms on CPU
- **Cache:** SHA-256 content hash prevents re-embedding unchanged content
- **Graceful fallback:** If model fails to load, FTS5-only search still works

## Confidence Decay (v2)

Knowledge decays over time unless reinforced. **v2 (2026-04-22)** adds a **14-day grace period** and makes **access count as reinforcement**. Constants live in `src/decay.ts` (`GRACE_PERIOD_DAYS=14`, `DECAY_RATE=0.05`, `REINFORCE_BUMP=0.2`, `STALE_THRESHOLD=0.5`, `ARCHIVE_THRESHOLD=0.25`):

```
Within 14 days of last_reinforced:  no decay at all (grace period)
After grace:  Confidence = (1 - 0.05) ^ weeks_since_grace_ended

Day 0–14:   100%  — fresh (grace)
~Week 6:    ~81%  — still good
~Week 16:   ~49%  — FLAGGED as stale (≤50%)
~Week 30:   ~24%  — ARCHIVED (≤25%, superseded_by = -1)
```

Reinforcement is two-pronged:
- **Explicit:** agents log `[REINFORCED]` (or `[OUTBOX:REINFORCED]`) in their pair logs; the Secretary calls `reinforce_finding`, which **adds +20% confidence (capped at 1.0)** and resets the decay clock.
- **Implicit:** every `recall_context` / `search_memory` / `get_detail` that returns an entry bumps its `last_reinforced` — routine access keeps live knowledge fresh with no marker needed.

`run_decay` (called at `/team11 standdown`) recomputes all scores, flags entries ≤50%, archives entries ≤25%, and runs summary-cache GC. Archival is reversible via `restore_finding`.

## Secretary Carrier & Outbox Protocol

Agents write structured `[OUTBOX:*]` markers (plus the `[FACT]` / `[GOTCHA]` / `[REINFORCED]` / `[CONTRADICTION]` line prefixes and `QUESTION FOR HUMAN`) in their pair logs. The **carrier** that drains those markers into the DB is `dist/scripts/process-pair-log.js` — a one-shot, idempotent processor (NOT a poll/sleep loop). It:

1. Scans the pair logs for **new** markers since the last run
2. Writes each entry to the DB via the existing primitives (`initDb`, `storeEmbedding`) — so findings get vector embeddings
3. Triggers Turso sync, updates `pheromones.json` / `verdicts.json`, and re-renders `hive.md`

```bash
# Process all pair logs (default):
node dist/scripts/process-pair-log.js

# Useful flags:
node dist/scripts/process-pair-log.js --pair 3        # only logs/pair-3.md
node dist/scripts/process-pair-log.js --dry-run       # parse + report, no writes
node dist/scripts/process-pair-log.js --all-history   # force full re-ingest of a log
```

**Idempotency & safety:**
- A per-log **high-water mark** in `.team11/_secretary_state.json` means re-running only processes lines added since last time. (Keep this file — deleting it makes the next `--all-history` re-ingest every log.)
- A **single-flight lock** at `.team11/_secretary.lock` makes concurrent firings (several pairs finishing at once) safe.
- **Live-log detection by mtime:** a freshly-modified log (within `BACKLOG_MTIME_WINDOW_MS`, default 48h) is ingested in full automatically, while an old historical log with no prior mark is baseline-skipped — so `--all-history` is now an explicit override, not a routine requirement.

**Trigger models (correct under both):**
- **Event-driven** — a `SubagentStop` hook (matcher `team11-coder-auditor`) in `.claude/settings.local.json` runs the carrier on every pair completion.
- **CEO-driven** — the CEO runs it manually between dispatches (the fallback; also handy with `--pair` / `--dry-run`).

The older `write-and-sync.js` does the same DB write + embedding, but consumes a **pre-built `_outbox.json`** rather than scanning the pair logs itself — `process-pair-log.js` (which scans logs for new markers) is the current carrier.

## Summarization Cache

Agents can cache AI-generated structural summaries of files, keyed by git blob SHA:

```
Agent reads CharacterPanel.js (22K tokens)
  → calls store_file_summary("CharacterPanel.js", "2400-line UI component...")
  
Next agent needs CharacterPanel.js
  → calls get_file_summary("CharacterPanel.js")
  → blob SHA matches → returns 400-token summary instead of 22K file read
  
File changes → blob SHA changes → cache miss → agent reads fresh
```

Token savings: ~90% per cached file read. Stale entries auto-cleaned after 7 days by `run_decay`.

## Sync (Optional — For Teams)

Multiple operators share one memory database via [Turso](https://turso.tech/) (distributed SQLite).

**Solo users:** Sync is disabled by default. Zero cloud dependencies. Memory accumulates locally forever.

**Teams:** Enable sync so your coworker's agents know what your agents discovered.

```
You:  memory.db ←sync→ Turso cloud ←sync→ memory.db :Coworker
      (local writes)                      (local writes)
      (60s sync interval)                 (60s sync interval)
```

### Setup (One Person Creates, Team Shares)

**Step 1: Create the database (one person does this)**

On Windows, use WSL:
```bash
# Install Turso CLI (in WSL)
curl -sSfL https://get.tur.so/install.sh | bash

# Login (use --headless in WSL since it can't open a browser)
~/.turso/turso auth login --headless

# Create database (pick a region close to your team)
~/.turso/turso db create team11-memory-PROJECTNAME

# Get URL
~/.turso/turso db show team11-memory-PROJECTNAME --url

# Create database token
~/.turso/turso db tokens create team11-memory-PROJECTNAME
```

**Step 2: Create per-operator tokens (each person gets their own)**

```bash
# Create a token with 30-day expiry for each operator
~/.turso/turso db tokens create team11-memory-PROJECTNAME --expiration 30d
```

Share the URL (not secret) and have each operator create their own token. Alternatively, set `TURSO_AUTH_TOKEN` as an environment variable — the server reads it as a fallback if `config.json` has no token.

**Step 3: Configure (everyone does this)**

Edit `.team11/config.json`:
```json
{
  "sync": {
    "enabled": true,
    "provider": "turso",
    "url": "libsql://team11-memory-PROJECTNAME-yourorg.turso.io",
    "token": "eyJ..."
  }
}
```

Or use env var instead of token in config:
```bash
export TURSO_AUTH_TOKEN="eyJ..."
```

**Step 4: Add MCP server to allowed list**

In `.claude/settings.local.json`, add `"team11-memory"` to the `enabledMcpjsonServers` array.

**IMPORTANT:** `.team11/config.json` is gitignored. Tokens never enter version control.

### Sync Behavior

- **Writes:** Go to local SQLite first (instant), then sync to Turso on next interval
- **Reads:** Always from local SQLite (no network latency)
- **Interval:** Every 60 seconds by default (configurable)
- **Failure:** If Turso is unreachable, local-only mode. Errors logged, never blocks.
- **After writes:** Store tools call `forceSync()` to push immediately

### Available Regions

| Region | Location |
|--------|----------|
| aws-ap-northeast-1 | Tokyo |
| aws-ap-south-1 | Mumbai |
| aws-eu-west-1 | Ireland |
| aws-us-east-1 | Virginia |
| aws-us-east-2 | Ohio |
| aws-us-west-2 | Oregon |

## Database

- **Engine:** SQLite via better-sqlite3
- **Location:** `.team11/memory.db`
- **Mode:** WAL (Write-Ahead Logging) for concurrent reads
- **Vector:** sqlite-vec (384-dimension float vectors)
- **Full-text:** FTS5 with porter/unicode61 tokenizer
- **Size:** Starts at ~100KB, grows with accumulated knowledge

### Schema

```
findings        — All knowledge entries (findings, decisions, gotchas, facts)
pheromones      — Task completion trails (difficulty, files, gotchas, duration, verdict_breakdown)
contradictions  — Conflicting claims between agents (claim_a vs claim_b, status)
file_summaries  — Git-aware code summary cache (keyed by blob SHA, FTS5 searchable)
active_edits    — File claims for cross-operator coordination (who's editing what)
operators       — Registered Team11 operators (name, prefix, last_active)
findings_fts    — FTS5 virtual table for full-text search on findings
summaries_fts   — FTS5 virtual table for full-text search on summaries
findings_vec    — sqlite-vec virtual table for vector search
embedding_cache — SHA-256 dedup cache for embeddings
```

## OneDrive Warning

**Do NOT store `memory.db` inside a OneDrive-synced folder.** SQLite uses file locking and WAL journaling that conflicts with cloud sync. If your project is inside OneDrive, either:
1. Set `TEAM11_MEMORY_DB` to a path outside OneDrive (e.g., `C:/team11-data/memory.db`)
2. Exclude `.team11/` from OneDrive sync
3. Disable OneDrive sync entirely

## Project Structure

```
.team11/mcp-server/
  ├── package.json
  ├── tsconfig.json
  ├── README.md
  ├── src/
  │   ├── index.ts          — Server entry point
  │   ├── db.ts             — SQLite schema, FTS5, sqlite-vec
  │   ├── tokenize.ts       — Code-aware FTS5 preprocessor
  │   ├── scoring.ts        — Composite scoring engine
  │   ├── embeddings.ts     — @huggingface/transformers pipeline
  │   ├── decay.ts          — Confidence decay engine
  │   ├── sync.ts           — Turso sync manager
  │   ├── tools/
  │   │   ├── index.ts          — Tool registration barrel (28 tools)
  │   │   ├── recall.ts         — recall_context, get_detail
  │   │   ├── store.ts          — store_finding, store_decision, store_gotcha
  │   │   ├── search.ts         — search_memory, list_recent, memory_stats, decay tools
  │   │   ├── pheromones.ts     — store_pheromone, get_pheromones (dual-write to DB + JSON)
  │   │   ├── summaries.ts      — get_file_summary, store_file_summary (git-aware cache)
  │   │   ├── contradictions.ts — store/resolve/list contradictions
  │   │   ├── coordination.ts   — claim_file, release_file, operators, active_edits
  │   │   ├── health.ts         — health_check (DB stats, sync, embeddings)
  │   │   └── sync.ts           — sync_status, force_sync
  │   └── scripts/
  │       ├── seed.ts              — Import existing findings into DB
  │       ├── process-pair-log.ts  — Secretary carrier: drain [OUTBOX:*] → DB (current)
  │       ├── write-and-sync.ts    — Legacy writer: consumes a pre-built _outbox.json
  │       ├── consolidate-memory.ts — Sleep-time maintenance: dedupe + GC (--execute)
  │       ├── bootstrap.ts         — One-command setup inside an existing mcp-server/
  │       └── init-project.ts      — Scaffold Team11 MCP into a brand-new project
  └── dist/                     — Compiled JS output
```
