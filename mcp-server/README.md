# Team11 Memory — MCP Server

Persistent memory for Team11 multi-agent orchestration. Stores findings, decisions, gotchas, and pheromone trails in a local SQLite database with FTS5 full-text search, sqlite-vec vector search, and optional Turso cloud sync for team collaboration.

## Quick Start

```bash
cd .team11/mcp-server
npm install
npm run build
npm run seed    # Import existing .team11/findings/*.md into the database
```

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
| `run_decay` | Run 5% weekly confidence decay. Flags stale (<50%), archives very stale (<25%). Also runs summary GC. |
| `reinforce_finding` | Reset a finding's decay timer (agent re-confirmed it's still true). |
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

## Confidence Decay

Knowledge decays over time unless reinforced:

```
Confidence = (1 - 0.05) ^ weeks_since_reinforced

Week 0:   100%  — fresh
Week 4:   81%   — still good
Week 14:  49%   — FLAGGED as stale (<50%)
Week 28:  24%   — ARCHIVED (<25%)
```

Agents reinforce facts by logging `[OUTBOX:REINFORCED]` in their pair logs. The Secretary calls `reinforce_finding` to reset the timer.

`run_decay` is called at `/team11 standdown` to update all scores.

## Secretary Agent & Outbox Protocol

Agents write structured `[OUTBOX:*]` entries in their pair logs. After each agent completes, the CEO dispatches a Secretary agent that:

1. Reads the pair log for new `[OUTBOX:*]` entries
2. Builds a JSON outbox file
3. Runs `write-and-sync.js` — ensures all tables exist (`initDb`), inserts entries, triggers Turso sync
4. Updates `pheromones.json` and `verdicts.json`
5. Renders `hive.md` from DB state

```bash
# The Secretary calls this script (not raw SQL):
node dist/scripts/write-and-sync.js .team11/_outbox.json
```

This ensures:
- Tables always exist (even on a fresh clone)
- Turso sync is triggered after every write
- Coworkers see changes within 60s

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
  │       ├── seed.ts            — Import existing findings into DB
  │       └── write-and-sync.ts  — Secretary agent DB writer (initDb + Turso sync)
  └── dist/                     — Compiled JS output
```
