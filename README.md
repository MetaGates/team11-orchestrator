# Team11: Multi-Agent Paired Orchestration System

A global Claude Code plugin that turns a single Claude session into a coordinated team of 11 AI agents working in background pairs with human oversight. Works on any project, any terminal, instantly.

---

## The Big Picture

```
You (human)
  │
  │  /team11 add venue signals API with tests
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                     CEO Agent                            │
│  Runs in YOUR session (foreground)                       │
│  Reads your request → assesses complexity → dispatches   │
│  Never writes code (orchestrates only)                   │
└────┬──────────┬──────────┬──────────┬──────────┬────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
  │Pair 1│  │Pair 2│  │Pair 3│  │Pair 4│  │Pair 5│
  │ α  β │  │ α  β │  │ α  β │  │ α  β │  │ α  β │
  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘
  background  background                    (idle)
  worktree    worktree        ← only dispatched if needed

Each pair: 2 identical agents that alternate coding and auditing.
All run in background. You keep working. They surface findings to you.

```

## How It Works (Step by Step)

### 1. You Give a Task

Type `/team11 <your task>` in any Claude Code terminal. The CEO agent activates in your session.

### 2. CEO Assesses and Decomposes

The CEO reads your request and decides:
- **Trivial** (typo, one-liner) → CEO does it directly, no agents needed
- **Small** (single feature, one bug) → dispatches 1 pair
- **Medium** (multi-file, refactor) → dispatches 2-3 pairs
- **Large** (cross-cutting, new system) → dispatches 4-5 pairs

It breaks the task into atomic subtasks and assigns each to a pair. Independent tasks run in parallel across pairs. Dependent tasks are sequenced.

### 3. CEO Discovers Available Tools

Before dispatching, the CEO scans your project for MCP servers (Postgres, Redis, GitHub, Playwright, etc.) and tells each agent what tools they have. Different projects have different tools — agents adapt automatically.

### 4. Agents Work in Pairs

Each pair gets an isolated git worktree (a full copy of the repo). They can't interfere with each other or your main branch.

Inside each pair, the two agents — Alpha and Beta — take turns:

```
Round 1:
  Alpha CODES the feature
    → reads hive mind (what other pairs are doing)
    → reads source files (verify current state)
    → writes code
    → updates hive mind ("I edited venues.py, affects VenueSchema")
    → runs targeted tests
    → commits in worktree

  Beta AUDITS Alpha's code
    → reads hive mind (cross-pair awareness)
    → reads Alpha's changes
    → checks: correctness, security, patterns, tests, interface contracts
    → writes findings report

    If trivial issue (typo, missing import):
      Beta FIXES it directly → roles swap for next round

    If substantive issue (logic bug, security hole):
      Beta FLAGS it → goes to you for review

Round 2 (if needed):
  Roles have swapped. Beta last touched the code, so:
  Alpha AUDITS Beta's fix
    → same criteria
    → writes findings

...continues until both agents agree the code is clean.
```

**The core rule: you never review your own edit.** This is why roles rotate — the agent who wrote the code is always checked by the other one.

### 5. Human Review Gate

Every audit cycle ends with findings presented to YOU. This is non-negotiable — agents cannot auto-approve.

You see:
- What files changed and why
- What the auditor found (critical/major/minor)
- What was fixed vs. what needs your decision
- The full audit trail (who coded what, who caught what)

You can:
- **Approve** → CEO merges the worktree to main
- **Reject** → pair starts over with your feedback
- **Modify** → you give specific guidance, pair adjusts

### 6. The Hive Mind

When multiple pairs work simultaneously, they need to know what each other is doing. The hive mind (`.team11/hive.md`) is a shared file that every agent reads before editing and writes to after editing:

```markdown
| Pair | Agent | File | Action | Interfaces Affected | Status |
|------|-------|------|--------|---------------------|--------|
| 1 | Alpha | src/api/routes/venues.py | Added GET /signals | VenueSignalSchema | coding |
| 2 | Alpha | frontend/src/hooks/useSignals.ts | New hook | VenueSignal type | coding |
```

If Pair 2 sees Pair 1 is changing the schema their hook depends on, they coordinate — wait for Pair 1 to finish, or work on a non-conflicting part first.

**Isolation:** The hive mind lives in `<project>/.team11/hive.md` — scoped to THIS project. Two terminals working on two different projects have completely separate hive minds. No interference.

### 8. Background Execution

All agents run in background. Your main Claude session stays fully interactive — you can ask questions, edit files, run commands, start a completely different conversation.

Agents only interrupt you for:
- **Human review gate** — audit findings need your approval
- **Destructive actions** — git push, file deletion, deploy
- **Blockers** — agent stuck after 2 retries
- **Completion** — task done and merged

You can check on them anytime:
- `/tasks` — see all running background agents
- Read `.team11/hive.md` — see what every pair is editing right now
- Read `.team11/logs/pair-N.md` — see detailed activity log for any pair

---

## Knowledge Capture System

Team11 doesn't just write code — it builds institutional knowledge.

### Session Logs (`docs/logs/YYYY-MM-DD-pair-CEO.md`)

Written ONCE at `/team11 standdown` — not during active work. The CEO compiles all pair logs into one clean session log.

**During work:** Agents write to their pair logs (`.team11/logs/pair-N.md`) in real time — cheap, no formatting overhead.

**At standdown:** CEO reads all pair logs and compiles a single session log with:
- **What was completed** (with file paths, checkboxes)
- **Architecture decisions** — full context, alternatives rejected and WHY
- **Known issues** — prioritized TODO for next session

**Why at standdown, not per-subtask:** Zero token waste during active work. Pair logs already capture everything. One compilation pass with the full picture produces a better-organized document.

### README & Documentation Updates

After standdown, the CEO checks: did anything change how the project works? If yes, it updates README.md, CLAUDE.md, and relevant docs/ files. Documentation stays current with code.

### Skill & Memory Proposals (Human-Gated)

When agents discover something reusable during their work — a pattern, a gotcha, a multi-step workflow — they write a **proposal**, not a permanent skill or memory.

```
Agent discovers pattern → writes proposal to .team11/proposals/
  → CEO surfaces it to you: "PROPOSED SKILL: [name], approve/reject/modify?"
    → You approve → saved permanently to ~/.claude/skills/ or project memory
    → You reject → deleted
    → You modify → updated per your feedback, then saved
```

**Why the gate?** Skills and memories compound. A wrong skill gets reused across 50 future tasks. A wrong memory biases every future decision. The 10 seconds you spend reviewing a proposal prevents hours of compounding errors.

Proposals must be:
- **Specific** — file paths, line numbers, exact commands
- **Correct** — verified by tests or manual confirmation
- **Non-obvious** — not derivable from reading the code for 30 seconds
- **Actionable** — "when X happens, do Y" not "X is interesting"

---

## File Layout

```
~/.claude/                              # GLOBAL (shared across all projects)
  ├── skills/team11/
  │   ├── SKILL.md                      # CEO orchestration manual
  │   ├── README.md                     # This document
  │   ├── agents/
  │   │   └── coder-auditor.md          # Universal agent prompt (all 10 use this)
  │   └── protocols/
  │       └── connected-hive.md         # GitHub API sync protocol for connected mode
  └── commands/
      └── team11.md                     # /team11 slash command entry point

<any-project>/                          # PER-PROJECT
  ├── .team11/                          # Ephemeral agent state (gitignored)
  │   ├── hive.md                       # Shared edit registry (rendered by Secretary)
  │   ├── config.json                   # Mode config: solo (default) or connected
  │   ├── logs/pair-N.md                # Pair activity logs
  │   ├── findings/pair-N-round-M.md    # Audit reports for human review
  │   ├── proposals/                    # Skill/memory proposals awaiting approval
  │   ├── mcp-server/                   # team11-memory MCP server (28 tools, SQLite+vector)
  │   │   ├── src/                      # TypeScript source
  │   │   ├── dist/                     # Compiled JS
  │   │   └── README.md                 # Server docs, tool reference, sync setup
  │   ├── checkpoints/                  # Crash recovery state per pair
  │   │   └── pair-N-checkpoint.json
  │   ├── stale/                        # Archived knowledge below 25% confidence
  │   └── pheromones.json               # Extended pheromone trail data
  └── docs/logs/
      └── YYYY-MM-DD-pair-CEO.md         # Session log (compiled at standdown)
```

**Key separation:**
- Global plugin (`~/.claude/skills/team11/`) — the system itself. Portable, works everywhere.
- Per-project state (`.team11/`) — ephemeral working data. Gitignored. Isolated per project.
- Session logs (`docs/logs/YYYY-MM-DD-pair-CEO.md`) — compiled by CEO at standdown from pair logs. Committed to git.

---

## Persistent Memory

Facts, pheromones, and gotchas discovered during work live in a SQLite database managed by the **team11-memory MCP server** (`.team11/mcp-server/`). After each merge, the CEO writes findings, decisions, pheromone trails, and gotchas directly via MCP tool calls (`store_finding`, `store_decision`, `store_pheromone`, `store_gotcha`). Before dispatching pairs, the CEO calls `recall_context` to retrieve relevant prior knowledge and include it in the dispatch prompt.

The MCP server uses hybrid FTS5 keyword search + sqlite-vec vector search (all-MiniLM-L6-v2, 384d). Results are ranked by BM25 relevance, importance weight, recency, and access frequency — merged with Reciprocal Rank Fusion and capped at ~8K tokens. Saves ~50K tokens per session by delivering curated context instead of raw file reads.

**OneDrive warning:** Do not store `memory.db` inside an OneDrive-synced folder — SQLite WAL journaling conflicts with cloud sync. Set `TEAM11_MEMORY_DB` in the MCP server env to a path outside OneDrive (e.g. `C:/team11-data/<project>/memory.db`). See `.team11/mcp-server/README.md` for details.

In connected mode (with Turso sync enabled), coworkers see new facts within 60 seconds of each write.

---

## Knowledge Lifecycle

Facts in `memory.db` are not permanent by default — they decay to prevent stale knowledge from biasing future work.

- **Initial confidence:** 100% when a fact is first stored
- **Decay rate:** 5% per week if no pair re-confirms the fact
- **Re-confirmation:** A pair writing `[OUTBOX:REINFORCED]` in their log resets the decay timer
- **50% threshold:** Fact is flagged for re-verification. Appears in `/team11 status` output so the next relevant task picks it up.
- **25% threshold:** Fact is archived to `.team11/stale/`. Not deleted — can be restored if proven correct again.
- **Decay calculation:** CEO runs the decay pass at `/team11 standdown`

This ensures the hive mind reflects what is currently true, not just what was true six months ago.

---

## MCP Servers

Team11 auto-discovers available MCP servers per project. Currently configured:

| Server | Scope | What It Does |
|--------|-------|-------------|
| **Playwright** | global | Browser automation, E2E testing, screenshots |
| **Sequential Thinking** | global | Structured reasoning for complex decisions |
| **GitHub** | global | PR management, issues, repo operations |
| **Context7** | global | Documentation lookup for frameworks/libraries |
| **team11-memory** | per-project | Persistent SQLite memory — `recall_context`, `store_finding`, `store_pheromone`, `get_pheromones`, 28 tools total |
| **graphify** | per-project | Knowledge graph MCP — query graph nodes, community structure, god nodes, shortest paths |
| **PostgreSQL** | per-project | Database schema inspection, query execution |
| **Redis** | per-project | Cache inspection, session data, pub/sub |

Agents use MCP tools when they provide richer data than built-in tools. For example: Postgres MCP for schema introspection instead of raw SQL, GitHub MCP for PR reviews instead of `gh` CLI.

---

## graphify Integration

graphify turns your codebase into a queryable knowledge graph. Team11 uses it in two ways:

1. **CEO context enrichment** — before dispatching, CEO reads `graphify-out/GRAPH_REPORT.md` to identify god nodes (highest-connectivity abstractions) and community structure. This replaces broad file scanning for architecture questions.
2. **MCP server** — the graphify server (`python -m graphify.serve graphify-out/graph.json`) exposes graph queries as MCP tools. Agents can ask "what depends on X?" without reading 40 files.

### Setup

```bash
# 1. Install graphify (Python 3.12+, per-project venv)
uv venv .venv --python 3.12
uv pip install graphifyy

# 2. Register with Claude Code
PYTHONUTF8=1 .venv/Scripts/python.exe -m graphify install        # installs skill
PYTHONUTF8=1 .venv/Scripts/python.exe -m graphify claude install  # CLAUDE.md hook + PreToolUse

# 3. Build the initial graph (run from project root)
/graphify                # scans . → graphify-out/graph.json + graph.html + GRAPH_REPORT.md

# 4. Add to .mcp.json
```

```json
{
  "mcpServers": {
    "team11-memory": {
      "command": "node",
      "args": [".team11/mcp-server/dist/index.js"],
      "env": { "TEAM11_MEMORY_DB": "C:/team11-data/<project>/memory.db" }
    },
    "graphify": {
      "command": ".venv/Scripts/python.exe",
      "args": ["-m", "graphify.serve", "graphify-out/graph.json"],
      "env": { "PYTHONUTF8": "1" }
    }
  }
}
```

```bash
# 5. Enable in Claude Code settings
# Add "graphify" and "team11-memory" to enabledMcpjsonServers in .claude/settings.local.json
# Restart Claude Code
```

### What graphify produces

| Output | Path | What it's for |
|--------|------|--------------|
| Knowledge graph | `graphify-out/graph.json` | MCP server source, agent queries |
| Interactive viz | `graphify-out/graph.html` | Human exploration |
| Report | `graphify-out/GRAPH_REPORT.md` | God nodes, communities, surprising connections — read before architecture work |
| Wiki | `graphify-out/wiki/` | Per-node pages (when generated) |

### Keeping the graph current

The `graphify claude install` step registers a **PreToolUse hook** that prompts Claude Code to rebuild the graph after code changes. For manual rebuilds:

```bash
/graphify --update    # incremental — re-extracts only changed files (fast)
/graphify             # full rebuild (slower, needed after large refactors)
```

---

## Activation

**Team11 is completely inert until you invoke it.** No auto-triggers, no background daemons, no hooks, no token consumption. When not invoked, it does not exist.

To turn it off mid-task: `/team11 stop`

---

## Full Command Reference (30 commands)

### Setup & Teardown (one-time per project)
| Command | What It Does |
|---------|-------------|
| `/team11 setup` | Create 5 permanent worktrees + install deps. Auto-prompted on first use. |
| `/team11 setup <N>` | Create only N worktrees (e.g., `setup 3`) |
| `/team11 teardown` | Remove all permanent worktrees (frees disk). Safe on Windows (uses `git worktree remove`). |

> **CRITICAL on Windows:** Never delete worktrees with `rm -rf` or PowerShell `Remove-Item -Recurse`. pnpm creates NTFS junctions in `node_modules` — PowerShell and MSYS bash **follow junctions and delete target directories**, which can permanently destroy `Documents/`, `Downloads/`, etc.
> **Safe deletion only via:** `git worktree remove <path>` or `cmd.exe /c "rmdir /S /Q <path>"`

### Task Execution
| Command | What It Does |
|---------|-------------|
| `/team11 <task>` | Start a task — CEO decomposes, dispatches pairs, runs full protocol |
| `/team11 reset pair <N>` | Reset pair N's worktree to clean main (between tasks) |
| `/team11 reset all` | Reset all worktrees to clean main |
| `/team11 stop` | Graceful stop: agents commit WIP, then halt. Worktrees persist. |
| `/team11 stop pair <N>` | Stop only pair N |
| `/team11 recover` | Detect crashed pairs, assess damage, present recovery options |

### Swarm Modes
| Command | What It Does |
|---------|-------------|
| `/team11 swarm-debug <bug>` | All 5 pairs independently investigate a hard bug — converge on root cause, human picks hypothesis to pursue |

### Monitoring & Live View
| Command | What It Does |
|---------|-------------|
| `/team11 status` | All active pairs, tasks, hive mind state |
| `/team11 hive` | Display the CEO-maintained hive mind |
| `/team11 log <N>` | Pair N's activity log |
| `/team11 watch` | Live view: all pairs — hive + latest log entries |
| `/team11 watch <N>` | Live view: pair N — log + current git diff in worktree |

### Review & Approval
| Command | What It Does |
|---------|-------------|
| `/team11 findings` | List pending audit findings awaiting review |
| `/team11 proposals` | List pending skill/memory proposals awaiting review |
| `/team11 approve <file>` | Approve a proposal → saved to knowledge base |
| `/team11 reject <file>` | Reject and delete a proposal |

### Knowledge & Documentation
| Command | What It Does |
|---------|-------------|
| `/team11 log-today` | Display today's session log |
| `/team11 project-prompt` | Display the project knowledge index |
| `/team11 project-prompt init` | Deep codebase scan → generate initial project knowledge |

### Session Control
| Command | What It Does |
|---------|-------------|
| `/team11 standdown` | End persistent session. Compile session log. Run decay pass. Go dormant. |

### Diagnostics & Costs
| Command | What It Does |
|---------|-------------|
| `/team11 costs` | Token cost breakdown per pair, per task, and session totals |
| `/team11 test-prompt` | Run a small known task to evaluate whether project-prompt.md is effective |

### Connected Mode (Cross-Human)
| Command | What It Does |
|---------|-------------|
| `/team11 connect` | Connect project to shared hive via GitHub `team11-coord` branch |
| `/team11 connect join` | Join coworker's existing coordination branch |
| `/team11 disconnect` | Switch back to solo mode (instant) |
| `/team11 operators` | List registered operators and their active pairs |
| `/team11 sync` | Force-refresh hive from GitHub |

### Meta
| Command | What It Does |
|---------|-------------|
| `/team11 help` | Show this command list |

---

## Using Team11

### Starting a Task

```bash
# In any Claude Code terminal:
/team11 add a REST endpoint for venue signals with full test coverage

/team11 refactor the scoring engine to use configurable weights

/team11 investigate why the venue detail page crashes on Google image URLs and fix it

/team11 research best practices for OpenAI batch API integration and write an ADR
```

### Monitoring While Agents Work

```bash
/team11 status          # what's everyone doing?
/team11 hive            # who's editing what file?
/team11 log 1           # what has pair 1 been up to?
```

### Responding to Human Gates

When a pair finishes an audit cycle, you'll see a summary in your session:
```
PAIR 1 AUDIT COMPLETE — 2 findings (1 minor fixed, 1 major needs review)
File: .team11/findings/pair-1-round-1.md
Action needed: Approve / Reject / Modify
```

Read the findings, then respond naturally: "approve", "reject, the query needs to use a CTE instead", etc.

### Persistent Session

```bash
/team11 fix the login bug       # CEO activates, stays online
now refactor the auth module    # no /team11 prefix needed
status                          # shows hive + pair status
/team11 standdown               # compiles session log, CEO goes dormant
```

After the first `/team11 <task>`, the CEO stays active. You send tasks directly — no prefix needed. The CEO compiles the session log when you run standdown.

### Connected Mode (Working with Coworkers)

```bash
/team11 connect                 # create team11-coord branch, register as operator
# coworker runs:
/team11 connect join            # joins your coordination branch

# both dispatch tasks — shared hive prevents file collisions
/team11 operators               # see who's connected and what they're working on
/team11 disconnect              # back to solo mode instantly
```

Connected mode shares the hive mind via a `team11-coord` orphan branch on GitHub. No source code on the branch — just coordination state. Your coworker's agents see your file claims, and vice versa.

### Multi-Terminal Usage

Open two terminals, two different projects:
```
Terminal 1 (food-aggro):  /team11 add venue signals endpoint
Terminal 2 (other-project): /team11 fix authentication bug
```

Each gets its own `.team11/` directory. Completely isolated. No interference.

---

## Design Principles

### Why Rotating Pairs Instead of Fixed Roles?

In Team10, specialized agents (Pipeline Agent, Scoring Agent, Frontend Agent) couldn't help each other. If the Pipeline Agent was idle while the Backend Agent was overloaded, the idle agent was wasted.

Team11 agents are all identical generalists. Any agent can work on any file in any language. The pair structure ensures quality (adversarial review) without requiring specialization.

### Why Human Gates on Every Audit?

Research shows that separating the coder from the judge is the single most impactful pattern for code quality (confirmed by HubSpot's Sidekick, Anthropic's three-agent harness, and OMC's verifier lane). But even paired agents can converge on a wrong answer.

The human gate catches what both agents missed. It takes 10-30 seconds to review findings and costs nothing. Skipping it risks compounding errors across dependent tasks.

### Why Per-Project Hive Mind?

Global shared state would mean two terminals working on different projects could see each other's edits and create confusion. Per-project isolation (`.team11/` in the project root) guarantees that each project's agents only see relevant context.

### Why Proposals Instead of Direct Skill/Memory Saves?

A wrong skill gets reused. A wrong memory biases decisions. The proposal gate ensures only verified, correct knowledge becomes permanent. The 10-second human review prevents hours of compounding mistakes.

### Why Background Execution?

Foreground agents block your session — you can't do anything while they work. Background agents let you keep working, asking questions, or even running a separate task. You only get interrupted when your input is actually needed.

---

## Token Cost Estimates

All agents run on Claude Opus 4.6 (per project policy).

| Scenario | Active Agents | Est. Hourly Cost |
|----------|--------------|-----------------|
| Small task (1 pair) | 2 | $10-30/hr |
| Medium task (2-3 pairs) | 4-6 | $25-75/hr |
| Large task (all 5 pairs) | 10 | $50-150/hr |

**Cost optimization built in:**
- CEO only dispatches as many pairs as needed (not always 5)
- Agents use grep before read, read before write, batch tool calls
- Test output is trimmed to failures-only before feeding to agents
- Worktree isolation prevents wasted re-reads from merge conflicts

---

## Communication Architecture

```
CEO writes → hive.md (read-only for pairs — shared awareness)
CEO writes → inboxes/pair-N.md (targeted messages to specific pairs)
CEO writes → memory.db (via team11-memory MCP tools after each merge)
Pairs write → logs/pair-N.md (their own activity log)
Pairs write → findings/pair-N-round-M.md (audit reports)
Pairs write → proposals/*.md (knowledge proposals for human review)
```

No shared-write files between pairs. Zero concurrency issues.

---

## Error Handling & Recovery

| Situation | What Happens |
|-----------|-------------|
| Agent fails a task | CEO re-dispatches with more specific instructions |
| Agent fails twice | CEO surfaces to you with diagnosis |
| Agent crashes | `/team11 recover` reads `.team11/checkpoints/pair-N-checkpoint.json` to resume from last known phase, not from scratch |
| Merge conflict | CEO surfaces both sides to you for resolution |
| MCP unavailable | Agent falls back to built-in tools |
| Human rejects | Pair restarts with your feedback via mailbox |
| Agent stuck 3+ attempts | Switches to competing-hypothesis debugging |
| Graceful stop | Agents commit WIP, write partial findings, then halt |

### Checkpoint System

Each pair writes a checkpoint file at key phases: `<project>/.team11/checkpoints/pair-N-checkpoint.json`.

The checkpoint contains: current phase, task description, files modified, files remaining, context notes, and the last commit SHA. If a pair crashes, `/team11 recover` reads the checkpoint and resumes from the last known state rather than starting over. Checkpoint files are deleted after a successful merge.

---

## Project Knowledge System

```
.team11/project-prompt.md        ← Index (200 lines max, always loaded)
.team11/knowledge/
  ├── tech-stack.md              ← Loaded when relevant
  ├── architecture.md
  ├── gotchas.md                 ← Critical gotchas also in index
  ├── patterns.md
  ├── domain.md
  ├── pitfalls.md
  ├── testing.md
  └── deployment.md
```

Index is always in every dispatch. Topic files loaded by CEO only when relevant to the task. Grows through human-approved proposals only. Stable knowledge graduates to CLAUDE.md.

---

## Key Quality Features

- **Anti-rationalization auditing** — auditors have explicit rules against rationalizing problems away, must show evidence for every check
- **"Never delegate understanding"** — CEO must synthesize research into specific specs before dispatching, vague delegation forbidden
- **13 audit categories** — accuracy, security, reasoning, scenarios, context, automation, tests, interfaces, performance, observability, accessibility, migration safety, hive conflicts
- **Atomic task claiming** — hive mind entry IS the claim, no duplicate work possible
- **Commit trailers** — Constraint, Rejected, Directive, Confidence, Scope-risk, Not-tested on every non-trivial commit

---

## Backup & Portability

Team11 lives at `~/.claude/skills/team11/` — **not inside any git repo by default.** To protect against data loss:

1. Initialize as its own repo: `cd ~/.claude/skills/team11 && git init && git add -A && git commit -m "Team11 initial"`
2. Push to GitHub: `gh repo create team11 --private --source=. --push`
3. Clone on any machine: `git clone <url> ~/.claude/skills/team11`

This also enables version history for the prompts themselves — you can see how they evolved.

---

## Quick Reference

| Command | What It Does |
|---------|-------------|
| `/team11 <task>` | Start a task |
| `/team11 status` | What's everyone doing? |
| `/team11 hive` | Who's editing what? |
| `/team11 watch` | Live view of all agents |
| `/team11 log <N>` | Pair N's log |
| `/team11 findings` | Pending audit findings |
| `/team11 proposals` | Pending knowledge proposals |
| `/team11 approve/reject` | Review proposals |
| `/team11 log-today` | Today's work log |
| `/team11 project-prompt` | View project knowledge |
| `/team11 project-prompt init` | Generate project knowledge from codebase |
| `/team11 recover` | Fix crashed pairs |
| `/team11 setup` | One-time worktree setup |
| `/team11 reset all` | Reset between tasks |
| `/team11 stop` | Graceful stop |
| `/team11 standdown` | End session, compile log, run decay pass |
| `/team11 connect` | Share hive with coworker |
| `/team11 disconnect` | Back to solo mode |
| `/team11 operators` | Who's connected? |
| `/team11 teardown` | Remove worktrees (see Windows warning above) |
| `/team11 swarm-debug <bug>` | All pairs investigate a hard bug |
| `/team11 costs` | Token cost breakdown |
| `/team11 test-prompt` | Evaluate project-prompt.md effectiveness |
| `/team11 help` | All commands |
