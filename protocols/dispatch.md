# Team11 Dispatch Protocol

This is the full operating protocol for `/team11 <task>` — Steps 0-6, checkpoint protocol, dispatch template, merge & report.

Loaded by the CEO on every task dispatch. Not loaded for meta-commands (`/team11 status`, `/team11 hive`, `/team11 findings`, etc.).

Cross-references to main SKILL:
- Model Routing config drives the `model` parameter in every Agent tool call
- HOTL Gate evaluation runs as step 3b in the Pair Loop (between pre-verification and human gate)
- Human Gate Protocol specifies use of `AskUserQuestion` for every human decision point

## Step 0: First-Run Detection

**Every time the user invokes any `/team11` command (except `help`), check this first:**

```bash
PROJECT_NAME=$(basename "$PWD")
WORKTREE_CHECK="../${PROJECT_NAME}-pair-1"
```

**If worktrees don't exist** (first time in this repo), stop and prompt the user:

```
TEAM11 — NEW PROJECT DETECTED: [project name]

No worktrees found. Before I can dispatch agents, I need to set up
permanent worktrees for this project.

This is a one-time setup that:
  1. Creates 5 worktree directories (sibling to this repo)
  2. Installs dependencies in each (Python venv, Node modules)
  3. Copies environment files (.env, etc.) if .worktreeinclude exists
  4. Creates .team11/ state directory (gitignored)

Estimated disk: ~6-9GB depending on project size
Estimated time: 3-10 minutes (mostly dependency install)

How many pairs do you want? (1-5, default 5)
```

Wait for user response (via `AskUserQuestion` — see Human Gate Protocol). Then run the setup protocol. After setup completes, continue with the original command the user typed.

**If worktrees exist but `.team11/` doesn't**, just create `.team11/` and continue — the state directory is ephemeral and can be recreated anytime.

**If both exist**, proceed directly to Step 1.

## Step 1: Assess Complexity

Read the user's request. Determine how many pairs to dispatch:

| Complexity | Pairs | Example |
|-----------|-------|---------|
| Trivial | 0 (do it yourself) | Fix a typo, change a string |
| Small | 1 pair | Single feature, one bug fix |
| Medium | 2-3 pairs | Multi-file feature, refactor |
| Large | 4-5 pairs | Cross-cutting change, new system |

**Do not over-dispatch.** 1 pair is often enough. Only use more when work is genuinely parallel and independent.

**Pheromone-informed estimation (PROCEDURAL — not optional):** Before deciding pair count and task assignments, the CEO MUST call the `mcp__team11-memory__get_pheromones` MCP tool with the list of files in scope for the user's request. This returns difficulty ratings, gotchas, and duration estimates from past pair work on those files.

```
get_pheromones(files=["src/scoring/engine.py", "src/scoring/list_generator.py"], limit=10)
```

Use the response to:
- Bump pair count up if past tasks on these files were HIGH difficulty
- Prefer pairs with prior pheromone history on these files (they know the gotchas)
- Pre-seed the dispatch's CONTEXT field with the gotchas from the response — don't let pairs rediscover known traps

**If `get_pheromones` returns nothing:** the files have no history. Proceed with default estimation, but expect the task to generate new pheromone data on completion.

**Do NOT skip this call.** Aspirational pheromone reads (which was the prior design) produced write-only bookkeeping — Phase 0 audit on 2026-04-22 confirmed no dispatch path actually read pheromones. This step makes them load-bearing.

## Step 2: Decompose

Break request into tasks. Each task gets:
- **Pair assignment** (which pair handles it)
- **Scope** (files involved)
- **Deliverable** (what "done" looks like)
- **Dependencies** (what must finish first)

Tasks assigned to the same pair run sequentially within the pair. Tasks across different pairs run in parallel.

**Inject pheromone gotchas into each pair's dispatch prompt.** The `get_pheromones` response from Step 1 includes gotchas per file. When decomposing, attach the relevant gotchas to each subtask's CONTEXT field in the dispatch template — this prevents pairs from rediscovering known traps (e.g., "CSP blocks inline styles", "psycopg3 not psycopg2", "port 3001 not 3000"). Gotchas that apply project-wide are already in `.team11/project-prompt.md` / `knowledge/gotchas.md`; pheromone gotchas are the file-specific layer on top.

## Step 3: Initialize State

If `.team11/` doesn't exist, create it:
```
mkdir -p .team11/logs .team11/findings .team11/checkpoints .team11/stale
```

Initialize `.team11/hive.md` with:
```markdown
# Hive Mind
**Project:** [project name]
**Date:** YYYY-MM-DD
**Type:** hive-mind
**Version:** 1

## Active Edits
| Pair | Agent | File | Action | Interfaces Affected | Status | Timestamp |
|------|-------|------|--------|---------------------|--------|-----------|

## Discovered Facts
| ID | Fact | Source | Confidence | Last Reinforced | Timestamp | Supersedes |
|----|------|--------|------------|-----------------|-----------|------------|

## Decisions
| ID | Decision | Rationale | Decided By | Timestamp | Supersedes |
|----|----------|-----------|------------|-----------|------------|

## Contradictions
| ID | Claim A | Source A | Claim B | Source B | Resolution | Status |
|----|---------|----------|---------|----------|------------|--------|

## Pheromone Trails
| Date | Pair | Task | Difficulty | Files Touched | Gotchas | Duration |
|------|------|------|------------|---------------|---------|----------|
```

Add `.team11/` to `.gitignore` if not present.

**Version field:** The CEO increments the Version number on every hive.md update. This allows pairs to detect stale reads and supports the connected mode sync protocol.

## Step 4: Dispatch Pairs (Sequential Init, Parallel Execution)

**Pre-check:** Verify worktrees exist. If not, tell user to run `/team11 setup` first (see `protocols/worktrees.md`).

```bash
PROJECT_NAME=$(basename "$PWD")
ls "../${PROJECT_NAME}-pair-1" > /dev/null 2>&1 || echo "ERROR: Run /team11 setup first"
```

Pairs deploy one at a time so each reads an accurate hive mind before starting.

**Announce the deployment plan:**
```
DEPLOYING [N] PAIRS:
  Pair 1: [task summary] → [files] (worktree: ../food-aggro-pair-1/)
  Pair 2: [task summary] → [files] (worktree: ../food-aggro-pair-2/)
  ...

Resetting Pair 1 worktree...
Initializing Pair 1...
```

**Sequential launch protocol:**
```
For each pair N:
  1. Reset worktree to latest main:
     cd ../food-aggro-pair-N && git fetch origin main && git reset --hard origin/main && git clean -fd
  2. The pair works directly on its permanent branch (team11-pair-N)
  3. Update hive mind with Pair N's assignment + background task ID
  4. Deploy Pair N agent (background)
     → "Pair N deployed. Pair N+1 standing by..."
  5. Next pair (sees Pair N in hive mind)
```

Each pair is launched using the `Agent` tool with:
- `subagent_type: "team11-coder-auditor"` — the registered subagent stub at `.claude/agents/team11-coder-auditor.md` delegates to the full agent prompt at `~/.claude/skills/team11/agents/coder-auditor.md`. The CEO does NOT paste the full agent prompt into the `prompt` parameter — the stub loads it.
- `run_in_background: true`
- `model` from `config.model_routing[role]` (see Model Routing in main SKILL.md)
- **No `isolation: "worktree"` needed** — agents work directly in their permanent worktree directory

For research-only tasks (web searches, doc reads, no code changes), use `subagent_type: "team11-researcher"` instead. For Secretary dispatch (Mode B), use `subagent_type: "team11-secretary"`.

### Dispatch Template

Passed as the `prompt` parameter to the `Agent` tool. The subagent stub handles loading the full agent prompt from the skill file.

**Ordering rule (for prompt caching):** static content FIRST, dynamic content LAST. Claude Code's automatic prefix caching reuses the longest shared prefix across sequential dispatches in a session. A dispatch that puts the 1000+ line project prompt + knowledge topics BEFORE the per-task HIVE MIND / TASK fields gets ~90% discount on that prefix after the first dispatch. Reversing this ordering (dynamic first) gives you 0% cache hit.

Follow this order exactly:

```
=== STATIC PREFIX (cacheable across all dispatches) ===

PROJECT PROMPT INDEX:
[paste contents of .team11/project-prompt.md — REQUIRED, always present]

RELEVANT KNOWLEDGE TOPICS:
[paste contents of the relevant .team11/knowledge/<topic>.md files — CEO selects which topics match the task scope; do NOT paste all topics]

CLAUDE.MD CONSTRAINTS:
[paste any relevant constraints from the project's CLAUDE.md]

RESEARCH DOCS:
[if the task touches a domain with an R-XX.YY.md decision, reference it — paste the decision summary, not the whole file]

IMPORTANT — NEVER DELEGATE UNDERSTANDING:
The CEO must have synthesized all research and context into THIS prompt before
dispatching. The following are FORBIDDEN in the TASK field:
  - "Based on your findings, fix the bug" — YOU state what the bug is and where
  - "Research and implement" — YOU do the research, THEN dispatch implementation
  - "Figure out what's wrong and fix it" — YOU diagnose, THEN dispatch the fix
  - "Look into X" without specific files/lines — YOU narrow it down first
Every dispatch must include: exact file paths, what to change, why, and what
"done" looks like. If you can't write this, you haven't understood the task yet.

=== SEMI-STATIC (cacheable within a session) ===

MODE: [solo|connected]
OPERATOR: [operator name + prefix, e.g. "CyberStein (cs)" — omit in solo mode]
PROJECT ROOT: [absolute path to main repo]
AVAILABLE MCPs: [list discovered MCP tools]

=== DYNAMIC (per-task; invalidates cache below this line) ===

PAIR: [N]
PAIR_ID: [pair-N in solo, {prefix}-pair-N in connected, e.g. cs-pair-1]
AGENT: [Alpha|Beta]
ROLE THIS ROUND: [coder|auditor]
WORKTREE PATH: [absolute path to permanent worktree, e.g. C:\Users\...\food-aggro-pair-1]
PARTNER: [the other agent's context — what they're doing]

HIVE MIND:
[paste current .team11/hive.md content — includes previous pairs' entries]

OTHER ACTIVE PAIRS:
[Pair 1: working on X in files Y]
[Pair 2: working on Z in files W]

=== TASK ===

TASK: [specific deliverable — be precise, not vague]
FILES IN SCOPE: [explicit list of files the agent may edit]
ACCEPTANCE CRITERIA: [what "done" looks like — specific, testable conditions]
CONTEXT: [relevant code snippets, decisions, patterns to follow]
PHEROMONE GOTCHAS: [from get_pheromones response for in-scope files — paste each gotcha with its file]
```

**Rules:**
- Sequential initialization — deploy pairs one at a time, each sees previous pairs in hive mind
- Parallel execution — once deployed, all pairs run simultaneously in background
- Sequential within pairs — Alpha codes first, Beta audits, then they alternate
- For a single pair: launch Alpha as coder first, then when Alpha completes, launch Beta as auditor with Alpha's changes as context
- Agents work in their permanent worktree directory, NOT the main repo
- Hive mind file (`.team11/hive.md`) is in the main repo — agents read it there via absolute path (CEO writes it)

## Checkpoint Protocol

Before each major phase transition, pairs write a checkpoint file to `.team11/checkpoints/pair-N-checkpoint.json`. This enables crash recovery — the CEO can read the checkpoint and resume the pair from the last known state.

**Checkpoint file:** `.team11/checkpoints/pair-N-checkpoint.json`
```json
{
  "pair": 1,
  "agent": "Alpha",
  "role": "coder",
  "phase": "coding",
  "task": "Add mobile detection to HUD overlay files",
  "started_at": "2026-04-01T15:30:00Z",
  "last_checkpoint": "2026-04-01T15:45:00Z",
  "files_modified": [
    "client-game/src/ui/HUD.js",
    "client-game/src/ui/Minimap.js"
  ],
  "files_remaining": [
    "client-game/src/ui/ChatPanel.js",
    "client-game/src/ui/InventoryPanel.js"
  ],
  "findings_so_far": [],
  "committed": false,
  "commit_sha": null,
  "next_action": "Edit ChatPanel.js to add mobile detection",
  "context_notes": "Using isMobileDevice() from utils/device.js. Pattern: import at top, wrap touch handlers in if-block."
}
```

**Phase values:** `"starting"` | `"coding"` | `"testing"` | `"committed"` | `"auditing"` | `"findings_written"` | `"awaiting_human"` | `"fixing"` | `"complete"`

**When to write checkpoints:**

| Role | Checkpoint Moments |
|------|--------------------|
| **Coder** | After starting (phase: `starting`), after all files edited (phase: `coding` → `testing`), after committed (phase: `committed`) |
| **Auditor** | After starting audit (phase: `auditing`), after findings written (phase: `findings_written`) |

**CEO reads checkpoints for `/team11 recover`** — see Error Recovery section in main SKILL.md.

**Checkpoint cleanup:** After a successful merge (Step 6), the CEO deletes the pair's checkpoint file. Clean state for the next task.

**Robustness:** If a checkpoint file fails to parse (corrupt JSON from a mid-write crash), treat it as no checkpoint — fall back to pair log analysis for recovery.

## Step 5: The Pair Loop

**Critical: Audit triggers on SUBTASK COMPLETION, not on individual file edits.**

If a subtask involves editing 5 files that interact (endpoint + schema + hook + tests + types), the coder edits ALL 5 files, runs tests, and commits the complete subtask as one unit. Only THEN does the auditor review — with full context of how all the pieces fit together.

The hive mind still gets updated per-file (so other pairs see what's being touched in real time), but the audit cycle waits for the coherent whole.

```
1. Agent A codes the COMPLETE subtask:
   - Writes checkpoint (phase: "starting")
   - Edits all files in scope (updates hive.md per-file for visibility)
   - Writes checkpoint (phase: "coding" with files_modified updated)
   - Runs tests on the complete change
   - Commits as one logical unit
   - Writes checkpoint (phase: "committed" with commit_sha)
   - Signals DONE

2. Agent B audits the COMPLETE subtask as a whole:
   - Writes checkpoint (phase: "auditing")
   - Reads ALL changed files together — understands the full interaction
   - Traces scenarios through the complete change, not isolated files
   - Produces findings (each finding includes **Verdict:** PENDING)
   - Writes checkpoint (phase: "findings_written")
   ├─ Trivial fix: B fixes directly → A audits B's fix (roles swapped)
   ├─ Substantive issue: B flags it → report to human
   └─ Clean audit: proceed to pre-verification

3. PRE-VERIFICATION: CEO runs automated checks in the pair's worktree
   - Read pre_verification config from .team11/config.json
   - Run each enabled command whose `scope` matches touched files
   - If a blocking command fails:
     → Log failure output in pair log
     → Return to coder with error output — NO human gate
     → Coder fixes, re-commits, auditor re-audits, pre-verification re-runs
   - If a `blocking: false` command fails: log in pair log, continue
   - If all blocking commands pass: proceed to step 3b
   - Log results in pair log: "[CEO] Pre-verification: ruff-check ✓, mypy ✓ (non-blocking), frontend-lint ✓"

3b. HOTL GATE EVALUATION (see HOTL Gate section in main SKILL):
    - Evaluate auto-merge criteria against the audit
    - Write shadow log entry to .team11/findings/hotl-shadow.jsonl
    - If mode=live AND all criteria pass → SKIP step 4, proceed to step 6
    - Otherwise continue to step 4

4. HUMAN GATE: Surface findings to user IMMEDIATELY via AskUserQuestion
   - Write findings to .team11/findings/pair-N-round-M.md
   - Each finding includes **Verdict:** PENDING
   - Use AskUserQuestion with structured options (see Human Gate Protocol in main SKILL)
   - The user should never have to poll for findings. Notify them the moment findings are ready.

5. After human review, CEO updates verdicts:
   - For each finding, set verdict to CONFIRMED, DISPUTED, or DEFERRED
   - Update .team11/findings/verdicts.json with the verdict entry
   - Update the shadow log line with the human_decision + agreement flag
   - Include verdict counts in the pair completion report

6. If fixes needed: whoever didn't write it last, reviews it

7. Loop until pair agrees + human approves (or HOTL auto-merged)

8. CEO merges worktree to main branch (Step 6)
```

**The auditing agent MUST stop and surface findings** unless the HOTL gate is in `live` mode and all criteria pass.

### Verdicts tracking file (`.team11/findings/verdicts.json`)

```json
{
  "verdicts": [
    {
      "id": "P1-R1-F01",
      "pair": 1,
      "round": 1,
      "finding": "Missing column whitelist on dynamic update",
      "severity": "critical",
      "category": "security",
      "auditor": "Beta",
      "verdict": "CONFIRMED",
      "resolved_by": "Alpha",
      "resolution": "Added whitelist in venues.py:L52",
      "timestamp": "2026-04-01T16:00:00Z",
      "human_approved": true
    }
  ],
  "summary": {
    "total": 1,
    "confirmed": 1,
    "disputed": 0,
    "deferred": 0
  }
}
```

## Step 6: Merge & Report

**Git workflow — who does what:**

| Actor | Can do | Cannot do |
|-------|--------|-----------|
| **Pair agents** | commit (in task branch, in their worktree) | pull, merge, push — never |
| **CEO** | pull, merge to main, reset worktrees | push (must ask user first) |
| **User** | approves push | — |

**After human approval (or HOTL auto-merge), CEO executes this sequence in the main repo:**

```bash
# 1. Pull latest main (other pairs may have merged since last time)
cd <main-repo>
git pull origin main

# 2. Squash-merge the pair's work into main as ONE clean commit
git merge --squash team11-pair-N
# If conflict: surface the conflict to the user with both sides shown.
# User decides: resolve manually, re-dispatch the pair, or discard.

# 3. Commit with a proper message using the commit protocol (trailers — see main SKILL)
git commit -m "$(cat <<'COMMIT'
<type>(<scope>): <description>

<body — what changed and why>

Constraint: ...
Rejected: ...
Confidence: high
Scope-risk: narrow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
COMMIT
)"

# 4. Push to remote (ASK USER FIRST via AskUserQuestion — always confirm before pushing)
git push origin main

# 5. Reset the pair's worktree so it's ready for next task
cd ../food-aggro-pair-N
git fetch origin main
git reset --hard origin/main   # sync pair branch to latest main
git clean -fd

# 6. Delete the pair's checkpoint file (clean state for next task)
rm -f <project-root>/.team11/checkpoints/pair-N-checkpoint.json
```

**Why this order matters:**
- `pull` first ensures we merge on top of the latest main (avoids conflicts with other pairs' merged work)
- `push` after merge so the remote always has the full picture
- `reset` last so the worktree picks up everything (its own merged work + other pairs' work)
- After reset, all worktrees converge back to the same main. They diverge during task branches, converge after merge.

**Pheromone trail write:** After successful merge, the CEO writes a pheromone trail entry:

1. **Append to hive.md Pheromone Trails table:**
   ```
   | 2026-04-01 | Pair 2 | Mobile HUD fixes | HIGH | 15 files | CSP blocks inline styles; must use class-based styling | 45min |
   ```

2. **Write extended data to `.team11/pheromones.json`:**
   ```json
   {
     "trails": [
       {
         "date": "2026-04-01",
         "pair": 2,
         "task": "Mobile HUD fixes",
         "difficulty": "HIGH",
         "files": ["src/ui/HUD.js", "src/ui/Minimap.js"],
         "gotchas": ["CSP blocks inline styles", "isMobileDevice() not available in all contexts"],
         "estimated_duration_min": 30,
         "actual_duration_min": 45,
         "rounds": 2,
         "findings_count": 3,
         "verdict_breakdown": {"confirmed": 2, "disputed": 1, "deferred": 0}
       }
     ]
   }
   ```

3. **Increment hive.md Version number.**

**Multiple pairs finishing in sequence:**
```
Pair 1 approved → CEO: pull → merge team11-pair-1 → ask user → push → reset pair-1
Pair 2 approved → CEO: pull → merge team11-pair-2 → ask user → push → reset pair-2
                         ↑ main now includes Pair 1's merged work
Pair 3 approved → CEO: pull → merge team11-pair-3 → ask user → push → reset pair-3
                         ↑ main now includes Pair 1 + Pair 2's merged work
```

All worktrees end up on the same main after their reset. No drift.

**Report to user after each merge:**

```
## Pair [N] Complete
**Task:** [description]
**Rounds:** [how many code-audit cycles]
**Branch:** team11-pair-N → merged to main
**Verdicts:** [X confirmed, Y disputed, Z deferred]
**HOTL:** [shadow / live / off] — [auto-merged / human-gated]

### Changes Made
| File | What Changed | Why | Agent |
|------|-------------|-----|-------|
| `path:L10-45` | [description] | [reasoning] | [Alpha/Beta] |

### Audit Findings & Resolutions
| # | Finding | Severity | Category | Verdict | Resolution |
|---|---------|----------|----------|---------|------------|
| 1 | [what the auditor found] | major | security | CONFIRMED | [FIXED by Beta: added column whitelist] |

### Audit Detail
**Round 1:**
- Alpha coded: [summary of all changes]
- Beta audited: [N] findings ([breakdown])
  - Fixed directly: [list trivial fixes Beta made]
  - Flagged for human: [list substantive issues]
- Human reviewed: [approved / rejected with feedback / modified] (or "auto-merged via HOTL")

### What the Auditor Said Was Good
[paste from the "What's Good" section of the findings — proves thorough review]

### Human Decision: [Approved/Modified/Rejected/HOTL-auto]
### Worktree: Reset to latest main ✓
```
