# Team11 Session Log & Proposals Protocol

Session log format at standdown, README & CLAUDE.md update rules, and the Skill & Memory Proposals workflow.

Loaded by the CEO on `/team11 standdown` and when a pair files a proposal (detected by the Secretary and surfaced at the next human gate).

## Session Log (Written at Standdown)

**Session log file:** `docs/logs/YYYY-MM-DD-session-CEO-HHMMSS.md` where HHMMSS is the session start time (24h format, seconds precision). Written ONCE at `/team11 standdown` — not during active work.

**CRITICAL: NEVER overwrite an existing session log.** Each session produces a NEW file with seconds-precision timestamp, guaranteeing uniqueness (e.g., `2026-04-08-session-CEO-143022.md`, `2026-04-08-session-CEO-185547.md`). The seconds component ensures no collisions even for multiple sessions in the same minute. Always use the current time at standdown, not the session start time.

**Agents do NOT write daily logs during work.** They write to their pair logs (`.team11/logs/pair-N.md`) in real time — that's the raw data. At standdown, the CEO compiles all pair logs into one clean session log.

**Why this is better:**
- Zero token waste on log formatting during active work
- Pair logs already capture everything in real time
- The CEO has the full picture at standdown — produces a better-organized summary
- One file per session, never overwritten — full history preserved

Create `docs/logs/` if it doesn't exist.

**At standdown, the CEO creates the session log with this format:**
```markdown
# Work Log — [Month Day, Year] (Session HHMM)

## Completed Today
<!-- Append to this section throughout the day as tasks complete -->

### [Feature/Fix/Task Name]
- [x] [Concrete deliverable with file paths]
- [x] [Next deliverable]
...

---

## Known Issues / TODO for Tomorrow

### HIGH PRIORITY
1. **[Issue]** — [context, how to reproduce, what needs to happen]

### MEDIUM PRIORITY
...

### LOW PRIORITY
...

---

## Data Quality Snapshot (end of day)
<!-- If relevant — skip if no data changes -->

| Metric | Value |
|---|---|
| [key metric] | [value] |
...

---

## Cost Tracking
<!-- If relevant — skip if no API/infra costs -->

| Item | Estimated Cost |
|---|---|
| [item] | [cost] |
...

---

## Architecture Decisions Made Today (Full Context)

### N. [Decision Title]

**Context:** [What situation we were in. What we were trying to do. Set the scene fully — someone reading this 6 months from now should understand the entire situation without reading any other document.]

**Problem:** [What went wrong, or what choice we faced. Be specific: error messages, math that didn't work out, user feedback, observed behavior vs expected behavior.]

**Decision:** [What we chose. Include file paths, function names, config values, exact implementation details.]

**Trade-off:** [What we gave up. What alternative we rejected and WHY — not just "we considered X" but "X fails because Y specific scenario."]

**Impact on [system/workflow/cost]:** [Downstream effects. What changes as a result. What to watch out for.]

**Future fix:** [If this is a band-aid, what the real solution is. If it's permanent, say so.]
```

**Style rules for the work log:**
- Write like you're explaining to a smart colleague who joins the team tomorrow
- Include the MATH when decisions involve numbers (scores, costs, token counts, thresholds)
- Include actual ERROR MESSAGES and STACK TRACES when debugging
- Name specific files, line numbers, function names — never "the scoring module" when you can say `scoring/aggregation.py:L145`
- Explain WHY alternatives were rejected, not just that they were
- If you discovered a gotcha, explain the full scenario that triggers it
- Every architectural decision section should be self-contained — readable without any other document

The CEO compiles this log from all pair logs at standdown. One pass, one file, complete picture.

## README & Documentation Updates

After standdown, check: **did this session change how the project works, how to set it up, or how to use it?** If yes:

1. Update the project's `README.md` with the new information
2. Update `CLAUDE.md` if the change affects development workflow, CLI commands, architecture, or conventions
3. Update relevant `docs/` files if architecture decisions changed

Documentation must stay current with the code. If an agent added a new CLI command, endpoint, config option, or changed a workflow — the docs reflect it in the same session, not later.

## Skill & Memory Proposals (Human Review Gate)

Agents discover reusable patterns, gotchas, and solutions during their work. These are valuable — but **only if correct.** Every proposed skill or memory goes through human review before being saved permanently.

### When Agents Should Propose

An agent proposes a skill when it:
- Solved something that took >3 tool calls to figure out
- Found a multi-step workflow that will recur
- Discovered a pattern that's non-obvious from the code alone

An agent proposes a memory when it:
- Learned something about the codebase that isn't documented
- Found a gotcha that would trip up future agents or humans
- Discovered a dependency or coupling that isn't obvious

### Proposal Flow

1. **Agent writes proposal** to `.team11/proposals/skill-XXXX.md` or `.team11/proposals/memory-XXXX.md`:
   ```markdown
   # Proposed [Skill|Memory]: [Name]
   **Source:** Pair [name], [agent id], during [task description]
   **Type:** [skill|memory]
   **Confidence:** [high|medium|low]

   ## What
   [The pattern, gotcha, or workflow]

   ## Why This Matters
   [When would this help? What goes wrong without it?]

   ## Evidence
   [File paths, line numbers, test results that prove this is correct]

   ## Proposed Content
   [The actual skill steps or memory content to save if approved]
   ```

2. **CEO surfaces proposal to user** at the next human gate via `AskUserQuestion` (see Human Gate Protocol in main SKILL.md). Do NOT free-text prompt.

3. **CEO scans proposal for secrets** before surfacing. Use these concrete regex patterns:
   ```
   AKIA[0-9A-Z]{16}                    # AWS access key
   [A-Za-z0-9/+=]{40}                  # AWS secret key (near AKIA or aws_secret)
   sk-[a-zA-Z0-9]{48,}                 # OpenAI API key
   sk-ant-[a-zA-Z0-9-]{90,}            # Anthropic API key
   ghp_[a-zA-Z0-9]{36}                 # GitHub personal access token
   gho_[a-zA-Z0-9]{36}                 # GitHub OAuth token
   postgresql://[^\s]+:[^\s]+@          # DB connection string with credentials
   redis://[^\s]*:[^\s]+@              # Redis connection string with password
   mongodb(\+srv)?://[^\s]+:[^\s]+@    # MongoDB connection string
   -----BEGIN (RSA |EC |)PRIVATE KEY   # Private keys
   eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}  # JWT tokens
   Bearer [a-zA-Z0-9_-]{20,}          # Auth bearer tokens
   xox[bprs]-[a-zA-Z0-9-]+            # Slack tokens
   SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}  # SendGrid API key
   password\s*[=:]\s*[^\s]{8,}        # Hardcoded passwords
   secret\s*[=:]\s*[^\s]{8,}          # Hardcoded secrets
   ```
   If ANY pattern matches: redact the match, warn user, and NEVER save to knowledge files.

   **Also scan pair logs and daily logs before git commit.** Secrets in committed logs enter git history permanently. The CEO should grep pair logs and daily log entries through these patterns before any `git add` on `docs/logs/` files.

4. **Human decides** (via `AskUserQuestion` with options Approve / Reject / Modify / Defer):
   - **Approve** → CEO saves it to the proper location (knowledge topic file, or `~/.claude/skills/` for skills)
   - **Reject** → CEO deletes the proposal file
   - **Modify** → CEO updates based on human feedback, then saves
   - **Defer** → proposal stays in `.team11/proposals/` for later review

5. **Never auto-save skills or memories.** The proposal file in `.team11/proposals/` is a staging area, not a permanent location. Nothing leaves proposals without human approval.

### What Makes a Good Proposal

- **Specific.** File paths, line numbers, exact commands — not vague advice.
- **Correct.** Verified by tests or manual confirmation. If unverified, mark confidence as "low."
- **Non-obvious.** If you could derive it by reading the code for 30 seconds, don't propose it.
- **Actionable.** "When X happens, do Y" — not "X is interesting."
