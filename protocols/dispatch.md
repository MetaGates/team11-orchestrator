# Team11 Dispatch Protocol

This is the full operating protocol for `/team11 <task>` — Steps 0-6, checkpoint protocol, dispatch template, merge & report.

Loaded by the CEO on every task dispatch. Not loaded for meta-commands (`/team11 status`, `/team11 hive`, `/team11 findings`, etc.).

Cross-references to main SKILL:
- Model Routing: `.team11/config.json → model_routing` is a record of intent; on this machine `CLAUDE_CODE_SUBAGENT_MODEL=claude-fable-5` overrides the Agent-tool `model` param, agent frontmatter `model`, and the main model, so every dispatch runs on Fable 5 whatever the config says (verified 2026-08-24, CC 2.1.241). Check `echo $CLAUDE_CODE_SUBAGENT_MODEL` before assuming a routing change took effect.
- HOTL Gate evaluation runs as step 4b in the Pair Loop (between pre-verification and human gate)
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

## Step 0b: CEO Session Wiring (once per session)

Before the first dispatch of a session (P2 rewire, 2026-08-25 — mechanisms probed 2026-08-24/25 on CC 2.1.241):

1. **`ListAgents`** — record what is addressable. Peer CEO sessions on this box (other Claude Code terminals) appear as named sessions; note the relevant ones in the hive.md header as addresses for cross-session contracts. `ListAgents` is CEO-only — it is NOT available inside subagents (probed 2026-08-24 from inside a pair), so never tell a pair to call it.
2. **One persistent `Monitor`** on `.team11/logs/*.md` + `.team11/_surfaced.md`, watching for `QUESTION FOR HUMAN | DONE | BLOCKED | [OUTBOX:` lines — the FALLBACK channel for agents that don't message: Workflow agents, ad-hoc dispatches, legacy logs. Named pairs push their events to `main` by `SendMessage` (delivered mid-turn), so the Monitor is a safety net, not the primary channel.
3. **Cross-session contracts** ("HOLD released", "seed landed", …): send them as a `SendMessage` to the peer session AND mirror them into `hive.md` — **the hive is the record, the message is the alarm.** `notify_when_idle: true` yields a one-shot idle notice from a busy peer (native Windows since CC 2.1.239; probed 2026-08-24).

## Step 1: Assess Complexity

Read the user's request. Determine how many pairs to dispatch:

| Complexity | Pairs | Example |
|-----------|-------|---------|
| Trivial | 0 (do it yourself) | Fix a typo, change a string |
| Small | 1 pair | Single feature, one bug fix |
| Medium | 2-3 pairs | Multi-file feature, refactor |
| Large | 4-5 pairs | Cross-cutting change, new system |

**Do not over-dispatch.** 1 pair is often enough. Only use more when work is genuinely parallel and independent.

**Pheromone-informed estimation (PROCEDURAL — not optional):** Before deciding pair count and task assignments, the CEO MUST call the `mcp__team11-memory__get_pheromones` MCP tool with the list of files in scope for the user's request. Its schema is deferred in this build: load it first with `ToolSearch(query="select:mcp__team11-memory__get_pheromones", max_results=1)` (batch any other team11-memory tools you will need into the same call), then invoke it. This returns difficulty ratings, gotchas, and duration estimates from past pair work on those files.

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

**Per phase, pick the engine.** For a **read-only, schema-shaped, parallel** sub-phase (audit / research sweep / multi-file analysis / scoring scatter), delegate the fan-out to the native **`Workflow` tool** rather than hand-rolling parallel pair dispatches — at equal scale it is faster + cheaper, schema-validated (auto-retried), auto-synthesized, and resumable. Then feed the validated results into the gated pair loop for any **writes**. A Workflow must NEVER be used to land writes (no human gate, no memory) — but its subagents run under `acceptEdits`, so they are NOT read-only by construction: state "read-only, do not edit files" explicitly in every Workflow agent prompt. Only the main conversation (the CEO) can launch a Workflow — never a pair subagent — and it caps at 16 concurrent agents (verified 2026-08-24, CC 2.1.241). **Routing ladder:** narrow lookup → **grep**; structural code question (who-calls / who-imports / impact) → **ripgrep (the `Grep` tool; the former OMC `lsp_*` tools were removed 2026-08-24)**; broad read-only agent work → **Workflow**; writes → **pair loop**. Workflow saves **time + main-context, NOT tokens** — never use it for narrow lookups or to "save tokens." Full how-to: `protocols/workflow-fanout.md`.

**Inject pheromone gotchas into each pair's dispatch prompt.** The `get_pheromones` response from Step 1 includes gotchas per file. When decomposing, attach the relevant gotchas to each subtask's CONTEXT field in the dispatch template — this prevents pairs from rediscovering known traps (e.g., "CSP blocks inline styles", "psycopg3 not psycopg2", "port 3001 not 3000"). Gotchas that apply project-wide are already in `.team11/project-prompt.md` / `knowledge/gotchas.md`; pheromone gotchas are the file-specific layer on top.

## Step 3: Initialize State

If `.team11/` doesn't exist, create it:
```
mkdir -p .team11/logs .team11/findings .team11/checkpoints .team11/stale
```

Initialize `.team11/hive.md` ONLY if it does not exist, as CEO narrative plus an empty carrier block:
```markdown
# Hive Mind
**Project:** [project name]
**Date:** YYYY-MM-DD
**Type:** hive-mind
**Version:** 1

## CEO narrative
[assignments, file claims, decisions, cross-lane contracts — free-form, CEO-written, above the markers]

<!-- CARRIER-AUTO:START -->
<!-- rendered by the carrier script (process-pair-log.js); never hand-edit between these markers -->
<!-- CARRIER-AUTO:END -->
```

Add `.team11/` to `.gitignore` if not present.

**Never rewrite an existing hive.md from a template** — append to the narrative above the CARRIER-AUTO block. The live file is CEO narrative + the carrier auto-block (Discovered Facts / Gotchas / Pheromone Trails rendered from the memory DB), not the five-table layout an earlier revision of this step initialized (verified 2026-08-24).

**Version field:** the carrier owns it — it stamps the auto-block version and mirrors it into the header `**Version:**` line on every render. The CEO does not hand-increment it.

## Step 4: Dispatch Pairs (Sequential Init, Parallel Execution)

**Pre-check:** Verify worktrees exist (run `/team11 setup` if not). Also verify `.team11/project-prompt.md` exists — it's REQUIRED in every dispatch (below); if missing, surface "PROJECT PROMPT MISSING — run `/team11 project-prompt init`" and create it before dispatching.

```bash
PROJECT_NAME=$(basename "$PWD")
ls "../${PROJECT_NAME}-pair-1" > /dev/null 2>&1 || echo "ERROR: Run /team11 setup first"
ls .team11/project-prompt.md > /dev/null 2>&1 || echo "WARN: .team11/project-prompt.md MISSING — run /team11 project-prompt init"
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
  3. Spawn BOTH agents of the pair up front, WITH `name:` (probed 2026-08-24/25, CC 2.1.241 —
     the Agent tool accepts `name:` even though the CEO's visible schema omits it):
       a. coder first:   Agent(subagent_type: "team11-coder-auditor", name: "<pair>-coder",   prompt: …)
       b. auditor second: Agent(subagent_type: "team11-auditor",       name: "<pair>-auditor", prompt: …)
     Spawn ORDER matters: the sibling roster is a snapshot at spawn — the later-spawned
     auditor sees the coder; the coder learns its partner's name from the PARTNER_NAME
     dispatch field. The auditor's FIRST prompt is small: "Read the brief + hive index,
     acknowledge to main, stop." It parks; it resumes with full context when messaged.
  4. Update hive mind with Pair N's assignment + both agent NAMES (`<pair>-coder`,
     `<pair>-auditor`) — the name is what `SendMessage` and `TaskStop` address;
     `/tasks` lists running background agents (do not call `TaskList`/`TaskGet`, hidden on Fable 5)
     → "Pair N deployed. Pair N+1 standing by..."
  5. Next pair (sees Pair N in hive mind)
```

Each pair is launched using the `Agent` tool with:
- `subagent_type`: **`"team11-coder-auditor"` for the coder, `"team11-auditor"` for the auditor.** The registered stubs in `.claude/agents/` delegate to the full agent prompt at `~/.claude/skills/team11/agents/coder-auditor.md`; the CEO does NOT paste the full agent prompt into the `prompt` parameter — the stub loads it. The auditor definition is ENFORCED read-only (P1, certified 2026-08-24/25): `disallowedTools` denies Edit/Write/NotebookEdit and a `PreToolUse` guard denies mutating Bash — its write surface is findings/log/checkpoint/proposals only.
- `name:` — `"<pair>-coder"` / `"<pair>-auditor"`. The name is the SendMessage/TaskStop address for the life of the session (probed 2026-08-24/25; the parameter is honored even though the CEO's visible schema omits it).
- Do NOT pass `run_in_background` — since 2.1.232 (fork mode on by default) every Agent spawn runs in the background; the parameter is accepted-but-redundant (checklist F7; CEO-side schema not re-inspected 2026-08-24 — the subagent-side `Agent` schema already omits it). Completion arrives via the SubagentStop hook / carrier and the completion notification; track the pair by its agent NAMES (`<pair>-coder` / `<pair>-auditor`) — runtime ids matter only for unnamed ad-hoc spawns.
- `model` from `config.model_routing[role]` is a record of intent only (see Model Routing in main SKILL.md): on this machine `CLAUDE_CODE_SUBAGENT_MODEL=claude-fable-5` overrides any `model` param or frontmatter value, so every pair runs on Fable 5 (which is also what the config records). To change routing, change/unset the env var — editing config.json alone does nothing.
- **NEVER pass `isolation: "worktree"`** — it spawns an uncleaned throwaway worktree that accumulates (see **Worktree Hygiene** in `protocols/worktrees.md`). Agents work directly in their permanent **pool** worktree directory.

For research-only tasks (web searches, doc reads, no code changes), use `subagent_type: "team11-researcher"` instead. There is no Secretary agent to dispatch: the Secretary is the carrier script (`process-pair-log.js`), which the SubagentStop hook runs automatically after each subagent completes and which maintains the CARRIER-AUTO block in hive.md. Do not spawn a `team11-secretary` subagent (the stub exists only for a manual one-shot pass if the hook is disabled).

### Dispatch Template

Passed as the `prompt` parameter to the `Agent` tool. The subagent stub handles loading the full agent prompt from the skill file.

**Ordering rule (for prompt caching):** static content FIRST, dynamic content LAST. Claude Code's automatic prefix caching reuses the longest shared prefix across sequential dispatches — but (verified 2026-08-24, CC 2.1.241) subagents use the **5-minute** cache TTL even on a subscription, and the cache is keyed by **model + effort + cwd** (a dispatch spawned from a different cwd — another worktree or session — is a different prefix). A dispatch that puts the 1000+ line project prompt + knowledge topics BEFORE the per-task HIVE MIND / TASK fields can get ~90% discount on that prefix — ONLY when the next dispatch shares the same model, effort and cwd AND lands within 5 minutes of the previous one. Pairs launched minutes apart, or with a different effort, pay full price for the prefix; keep the sequential-launch loop tight to benefit. Reversing this ordering (dynamic first) gives you 0% cache hit either way.

Follow this order exactly:

```
=== STATIC PREFIX (cacheable across dispatches that share model/effort/cwd within the 5-minute TTL) ===

PROJECT PROMPT INDEX:
[paste contents of .team11/project-prompt.md — REQUIRED, always present]

RELEVANT KNOWLEDGE TOPICS:
[paste contents of the relevant .team11/knowledge/<topic>.md files — CEO selects which topics match the task scope; do NOT paste all topics]

CLAUDE.MD CONSTRAINTS:
[Do NOT paste CLAUDE.md wholesale — agents already receive it via auto-injection. Paste ONLY task-scope-specific constraints or off-limits items the agent must not miss for THIS task.]

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

=== SEMI-STATIC (cacheable only while dispatches stay within the 5-minute TTL on the same model/effort/cwd) ===

MODE: [solo|connected]
OPERATOR: [operator name + prefix, e.g. "CyberStein (cs)" — omit in solo mode]
PROJECT ROOT: [absolute path to main repo]
AVAILABLE MCPs: [list discovered MCP tools]

=== DYNAMIC (per-task; invalidates cache below this line) ===

PAIR: [N]
PAIR_ID: [pair-N in solo, {prefix}-pair-N in connected, e.g. cs-pair-1]
AGENT: [Team11 role label for this dispatch — freeform, e.g. a/b or 1/2. Your ADDRESS is your spawn name below, not this label]
YOUR NAME: [<pair>-coder | <pair>-auditor — you were spawned with this `name:`; main and your partner address you by it, and your `from=` carries it]
PARTNER_NAME: [<pair>-auditor | <pair>-coder — message them by this name]
ROLE: [coder|auditor — fixed for this task; the auditor runs the ENFORCED read-only team11-auditor definition]
WORKTREE PATH: [absolute path to permanent worktree, e.g. C:\Users\...\food-aggro-pair-1]

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
- Both agents of a pair are spawned UP FRONT (coder first, auditor second — the roster snapshot depends on spawn order). Never wait for the coder to finish before spawning the auditor.
- Sequential within pairs — the coder works first; the parked auditor resumes when the coder messages it. Rounds alternate by MESSAGE, not by re-dispatch (probed 2026-08-24/25: a completed agent auto-resumes with its transcript intact).
- Agents work in their permanent worktree directory, NOT the main repo
- Hive mind file (`.team11/hive.md`) is in the main repo — agents read it there via absolute path (CEO writes it)

## Checkpoint Protocol

**Checkpoints are for CROSS-SESSION crash recovery ONLY** (slimmed in the P2 rewire, 2026-08-25). In-session, resume needs no checkpoint: a parked or completed agent auto-resumes with its full transcript when messaged (probed 2026-08-24/25, CC 2.1.241). A checkpoint matters only when the SESSION dies — a new session cannot address the old session's agents by name, so `/team11 recover` re-dispatches from the checkpoint + pair log.

**Checkpoint file:** `.team11/checkpoints/pair-N-checkpoint.json` — four fields, nothing more:
```json
{
  "pair": "pair-signals",
  "phase": "committed",
  "commit_sha": "abc1234",
  "next_action": "Await audit of abc1234; apply the fix list when the auditor messages it"
}
```

**Phase values:** `"starting"` | `"coding"` | `"testing"` | `"committed"` | `"auditing"` | `"findings_written"` | `"awaiting_human"` | `"fixing"` | `"complete"`

**When to write checkpoints:**

| Role | Checkpoint Moments |
|------|--------------------|
| **Coder** | At start (phase: `starting`), after the hive read (phase: `coding`), after all files edited (phase: `testing`), after each commit — initial or fix round (phase: `committed` + the sha) |
| **Auditor** | At audit start (phase: `auditing`), after findings written (phase: `findings_written`) |

Everything richer — files touched, context notes, findings-so-far — lives in the **pair log**, which recovery reads alongside the checkpoint. Do not duplicate it into the checkpoint.

**CEO reads checkpoints for `/team11 recover`** — see Error Recovery section in main SKILL.md.

**Checkpoint cleanup:** After a successful merge (Step 6), the CEO deletes the pair's checkpoint file. Clean state for the next task.

**Robustness:** If a checkpoint file fails to parse (corrupt JSON from a mid-write crash), treat it as no checkpoint — fall back to pair log analysis for recovery.

## Step 5: The Pair Loop

**Critical: Audit triggers on SUBTASK COMPLETION, not on individual file edits.**

If a subtask involves editing 5 files that interact (endpoint + schema + hook + tests + types), the coder edits ALL 5 files, runs tests, and commits the complete subtask as one unit. Only THEN does the auditor review — with full context of how all the pieces fit together.

The hive mind still gets updated per-file (so other pairs see what's being touched in real time), but the audit cycle waits for the coherent whole.

**The pair is two persistent named agents** (`<pair>-coder`, `<pair>-auditor` — spawned in Step 4). **Rounds are MESSAGES, not re-dispatches:** a completed agent auto-resumes with its full transcript when messaged (probed 2026-08-24/25, CC 2.1.241 — the P1 lane ran 4 audit rounds with zero re-dispatches). Nobody re-reads the brief between rounds; nobody re-explains context.

```
1. CODER codes the COMPLETE subtask:
   - Writes checkpoint {pair, phase: "coding", commit_sha: null, next_action}
   - Edits all files in scope (logs per-file in the pair log; the hive entry is the claim)
   - Runs tests on the complete change
   - Commits as one logical unit; checkpoint → {phase: "committed", commit_sha}
   - MESSAGES the auditor ("<pair>-auditor"): sha, files touched, what to attack
   - MESSAGES main: "DONE round N" + sha
   (both messages also get pair-log lines — the log is the record, the message is the alarm)

2. AUDITOR resumes (the coder's message wakes it, transcript intact) and audits
   the COMPLETE subtask as a whole:
   - Writes checkpoint {phase: "auditing"}
   - Reads ALL changed files together — understands the full interaction
   - Traces scenarios through the complete change, not isolated files
   - Produces the findings file (format unchanged; each finding **Verdict:** PENDING)
   - Checkpoint → {phase: "findings_written"}
   ├─ Trivial fix: auditor MESSAGES the exact one-liner to the coder — it cannot edit
   │  (ENFORCED read-only: the team11-auditor definition denies Edit/Write and mutating
   │  Bash). The coder applies it; the invariant holds — editor and reviewer are still
   │  different agents, and the auditor reviews the application next round.
   ├─ Substantive issue: auditor flags it in findings → MESSAGES main (verdict + findings path)
   └─ Clean audit: auditor MESSAGES main (verdict PASS + findings path) → pre-verification

3. FIX ROUNDS = MESSAGES: the coder applies the fix list, re-commits, messages the
   auditor + main again (round N+1). No re-dispatch, no brief re-explaining — the
   transcript is the context. The CEO can course-correct any agent mid-round by
   SendMessage (with a durable copy appended to the pair's inbox file).

4. PRE-VERIFICATION: CEO runs automated checks in the pair's worktree
   - Read pre_verification config from .team11/config.json
   - Run each enabled command whose `scope` matches touched files
   - If a blocking command fails:
     → Log failure output in pair log
     → MESSAGE the coder with the error output — NO human gate
     → Coder fixes, re-commits, auditor re-audits, pre-verification re-runs
   - If a `blocking: false` command fails: log in pair log, continue
   - If all blocking commands pass: proceed to step 4b
   - Log results in pair log: "[CEO] Pre-verification: ruff-check ✓, mypy ✓ (non-blocking), frontend-lint ✓"

4b. HOTL GATE EVALUATION (see HOTL Gate section in main SKILL):
    - Run `hotl-eval` (`node .team11/mcp-server/dist/scripts/hotl-eval.js --pair <id> --round <n> --findings <path> [--worktree <path>] [--base <ref>] [--preverif pass|fail]`): it evaluates the auto-merge criteria against the audit and appends the shadow-log line to .team11/findings/hotl-shadow.jsonl in BOTH modes (automated 2026-08-24; mode is `live` on this project per config.json). `--base` defaults to main→origin/main — a repo with neither (e.g. the skill repo) needs `--base master`; omitting `--preverif` fails closed (preverif-unknown blocks auto-merge).
    - If mode=live AND all criteria pass → SKIP step 5 (human gate) and merge (protocol Step 6)
    - Otherwise continue to step 5

5. HUMAN GATE (unchanged): surface findings to the user IMMEDIATELY via AskUserQuestion
   - Findings are already at .team11/findings/pair-N-round-M.md (each **Verdict:** PENDING)
   - Use AskUserQuestion with structured options (see Human Gate Protocol in main SKILL)
   - Fire a PushNotification on this gate — and on every blocker — so the alarm reaches
     the user away from the terminal. The user never polls for findings.

6. After human review, CEO updates verdicts:
   - For each finding, set verdict to CONFIRMED, DISPUTED, or DEFERRED
   - Update .team11/findings/verdicts.json with the verdict entry
   - Update the shadow log line with the human_decision + agreement flag
     (`hotl-eval --update-decision --pair <id> --round <n> --decision <X>`)
   - Relay required fixes to the coder by MESSAGE (durable copy → inbox file)

7. Loop until the auditor passes it AND the human approves (or HOTL auto-merged),
   then the CEO merges the worktree to main (protocol Step 6)
```

**The auditor MUST stop after messaging its verdict** — it never merges, and the human gate runs unless the HOTL gate is in `live` mode and all criteria pass.

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
      "auditor": "b",
      "verdict": "CONFIRMED",
      "resolved_by": "a",
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

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
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

1. **Store the trail where Step 1 reads it:** call `mcp__team11-memory__store_pheromone` (load its schema via ToolSearch first). There is no Pheromone Trails table in the live hive.md — the carrier renders recent trails from the DB inside the CARRIER-AUTO block; do not create one. Add a one-line note to the hive.md CEO narrative if the trail matters for the next dispatch.

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

3. **Do not hand-increment the hive.md Version number** — the carrier stamps it on every render.

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
| `path:L10-45` | [description] | [reasoning] | [agent name] |

### Audit Findings & Resolutions
| # | Finding | Severity | Category | Verdict | Resolution |
|---|---------|----------|----------|---------|------------|
| 1 | [what the auditor found] | major | security | CONFIRMED | [FIXED by coder: added column whitelist] |

### Audit Detail
**Round 1:**
- Coder ([agent name]) coded: [summary of all changes]
- Auditor ([agent name]) audited: [N] findings ([breakdown])
  - Trivial fixes messaged → applied by coder: [list]
  - Flagged for human: [list substantive issues]
- Human reviewed: [approved / rejected with feedback / modified] (or "auto-merged via HOTL")

### What the Auditor Said Was Good
[paste from the "What's Good" section of the findings — proves thorough review]

### Human Decision: [Approved/Modified/Rejected/HOTL-auto]
### Worktree: Reset to latest main ✓
```
