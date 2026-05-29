# Connected Hive Sync Protocol

This protocol defines how the CEO reads and writes the shared hive mind when Team11 is in connected mode.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- `.team11/config.json` has `mode: "connected"` with valid operator info
- `team11-coord` branch exists on the remote repo

## Modes: Solo vs Connected

Connected mode lets multiple humans run Team11 on the same GitHub repo from different machines; their agents share one hive (the `team11-coord` orphan branch) so file claims are visible across operators. It is **opt-in, per-project**. Disconnected, Team11 is fully local with zero network calls.

| Aspect | Solo (default) | Connected |
|--------|---------------|-----------|
| Hive mind | `.team11/hive.md` (local, gitignored) | `team11-coord` branch on GitHub (shared) |
| Pair naming | `pair-1` | `{prefix}-pair-1` (e.g., `cs-pair-1`) |
| File claims | Visible to local CEO only | Visible to ALL operators' CEOs |
| Project prompt | Local `.team11/project-prompt.md` | Shared on `team11-coord` branch |
| Knowledge base | Local `.team11/knowledge/` | Shared on `team11-coord` branch |
| Pair logs | Local `.team11/logs/pair-N.md` | Synced to `team11-coord: logs/{prefix}-pair-N.md` |
| Inboxes / Findings / Worktrees / Config | Local | LOCAL only (never shared) |

## Configuration (`.team11/config.json`)

Default (solo): `{"mode": "solo", "operator": null, "repo": null}`

When connected:
```json
{
  "mode": "connected",
  "operator": { "name": "CyberStein", "github": "CyberStein", "prefix": "cs", "pairs": [1,2,3,4,5] },
  "repo": "eoc-gengine/loopborn"
}
```

**Mode check:** Before every hive read/write, check `config.json`. If `mode: "solo"`, use local `.team11/hive.md`. If `mode: "connected"`, use the sync protocol below.

## `/team11 connect` Protocol

One-time per project. **Prerequisite:** verify `gh` is authenticated (`gh auth status`); if not, stop and tell the user to install/login (`winget install GitHub.cli` / `brew install gh` / `scoop install gh`).

1. Determine repo from `git remote get-url origin`
2. If `team11-coord` already exists on remote → tell user to use `connect join`
3. Create orphan branch `team11-coord` via GitHub API with an initial `hive.md`
4. Register this operator by creating `operators/{name}.json` on `team11-coord`
5. Save local `.team11/config.json`

Ask the user (via `AskUserQuestion`) for: display name (default git user.name), short prefix (2-3 chars), number of pairs (default 5).

## `/team11 connect join` Protocol

1. Verify `team11-coord` exists on remote — if not, tell user to ask a coworker to run `/team11 connect` first
2. Read existing operators to avoid prefix collision
3. Register this operator (same as connect step 4)
4. Download shared `project-prompt.md` + `knowledge/` if present
5. Save local `.team11/config.json`

## `/team11 disconnect` Protocol

Instant switch back to solo: (1) set local `config.json` `mode: "solo"`; (2) copy current shared hive to local hive (don't lose mid-task context); (3) remove this operator's active edits from the shared hive (courtesy cleanup); (4) the `team11-coord` branch stays on GitHub for coworkers.

## `/team11 operators` Output

```
TEAM11 OPERATORS — eoc-gengine/loopborn
| Operator | Prefix | Pairs | Last Active | Status |
|----------|--------|-------|-------------|--------|
| CyberStein | cs | 1-5 | 2026-04-01 14:32 | active (2 pairs running) |
| oldworldlab | owl | 1-5 | 2026-04-01 14:30 | active (1 pair running) |
```

## Hive Mind in Connected Mode

The hive table gains an **Operator** column:
```markdown
## Active Edits
| Operator | Pair | File | Action | Status | Timestamp |
|----------|------|------|--------|--------|-----------|
| cs | cs-pair-1 | client-game/src/ui/HUD.js | Refactoring layout | coding | 14:32 |
| owl | owl-pair-1 | nakama/src/combat.ts | Fix boss AI | auditing | 14:30 |
```

**File claim checking (core anti-regression mechanism):** before dispatching any pair, the CEO reads the shared hive — if ANY operator's pair (including other humans') already claims a file, BLOCK (wait, re-scope, or ask the human). No two agents across ANY operator touch the same file simultaneously.

## Connected Mode Changes to Operating Protocol

These are the ONLY changes to the dispatch protocol; everything else is identical.

- **Step 3 (Initialize State):** if `mode: "connected"` — read hive from `team11-coord` instead of local; use operator-prefixed pair names (`{prefix}-pair-{N}`) in all hive entries.
- **Step 4 (Dispatch):** sync hive from GitHub before reading; include operator prefix in pair identity; after writing the new pair's claim to the hive, push to GitHub.
- **Step 6 (Merge):** after merging to main and pushing, update the shared hive to remove the pair's file claims so other operators' CEOs see them freed on next sync.

## Shared Knowledge Sync

Project knowledge (`project-prompt.md` + `knowledge/`) is shared via `team11-coord`:
- **On connect/join:** download existing shared knowledge if present; upload local if shared is empty.
- **On proposal approval:** upload the updated knowledge file (and index if changed) to `team11-coord`.
- **On `/team11 sync`:** refresh local knowledge from shared.

## Security Notes

- `team11-coord` contains NO source code — only coordination state.
- Pair logs carry file paths + change descriptions, never file contents.
- `gh` uses the user's existing GitHub auth — no new credentials; operator identity = GitHub username (no shared secrets).
- The branch can be protected via GitHub branch-protection rules.

## Reading the Shared Hive

```bash
# Fetch hive.md from team11-coord branch — no checkout needed
REPO=$(jq -r '.repo' .team11/config.json)

HIVE_CONTENT=$(gh api repos/$REPO/contents/hive.md?ref=team11-coord \
  --jq '.content' | base64 -d)

HIVE_SHA=$(gh api repos/$REPO/contents/hive.md?ref=team11-coord \
  --jq '.sha')

# Cache locally for quick access
echo "$HIVE_CONTENT" > .team11/hive.md
echo "$HIVE_SHA" > .team11/.hive-sha
```

**When to read:**
- Before every pair dispatch (Step 4)
- Before checking file claims
- On `/team11 status` or `/team11 hive`
- On `/team11 sync` (manual force-refresh)

## Writing the Shared Hive

```bash
# Optimistic locking via SHA — prevents overwrites
REPO=$(jq -r '.repo' .team11/config.json)
CURRENT_SHA=$(cat .team11/.hive-sha)
NEW_CONTENT=$(base64 < .team11/hive.md)

RESULT=$(gh api repos/$REPO/contents/hive.md \
  -X PUT \
  -f message="hive: ${PREFIX}-pair-${N} claiming ${FILE}" \
  -f content="$NEW_CONTENT" \
  -f sha="$CURRENT_SHA" \
  -f branch="team11-coord" 2>&1)

if echo "$RESULT" | grep -q "409\|SHA does not match"; then
  # SHA conflict — someone else updated the hive since we read it
  # Re-read, merge our changes, retry
  echo "HIVE CONFLICT — re-reading and retrying..."
  # 1. Re-read hive (gets new SHA)
  # 2. Re-apply our changes on top of the new content
  # 3. Retry the PUT with the new SHA
fi
```

**When to write:**
- After adding a pair's file claims to the hive (Step 4)
- After removing a pair's file claims (after merge, Step 6)
- After updating pair status (coding → auditing → done)

## Conflict Resolution

The GitHub API uses SHA-based optimistic locking. If two CEOs try to update hive.md simultaneously:

1. First writer succeeds (their SHA matches)
2. Second writer gets a 409 conflict (their SHA is stale)
3. Second writer re-reads hive.md (gets the first writer's changes + new SHA)
4. Second writer re-applies their changes on top
5. Second writer retries the PUT with the new SHA

This is automatic and transparent. No data loss. The hive is always consistent.

**Max retries: 3.** If the hive is so contested that 3 retries fail, surface to the user:
```
HIVE SYNC CONFLICT — 3 retries failed
Another operator is rapidly updating the hive.
Options:
  A) Wait 10 seconds and retry
  B) Force-write (overwrites other operator's latest — DANGEROUS)
  C) Switch to solo mode temporarily
```

## Syncing Pair Logs

Pair logs are synced to `team11-coord` after each completed subtask:

```bash
PREFIX=$(jq -r '.operator.prefix' .team11/config.json)
REPO=$(jq -r '.repo' .team11/config.json)
LOG_FILE="logs/${PREFIX}-pair-${N}.md"

# Check if file exists on team11-coord
EXISTING_SHA=$(gh api repos/$REPO/contents/$LOG_FILE?ref=team11-coord --jq '.sha' 2>/dev/null || echo "")

if [ -z "$EXISTING_SHA" ]; then
  # Create new file
  gh api repos/$REPO/contents/$LOG_FILE \
    -X PUT \
    -f message="log: ${PREFIX}-pair-${N} update" \
    -f content="$(base64 < .team11/logs/${PREFIX}-pair-${N}.md)" \
    -f branch="team11-coord"
else
  # Update existing
  gh api repos/$REPO/contents/$LOG_FILE \
    -X PUT \
    -f message="log: ${PREFIX}-pair-${N} update" \
    -f content="$(base64 < .team11/logs/${PREFIX}-pair-${N}.md)" \
    -f sha="$EXISTING_SHA" \
    -f branch="team11-coord"
fi
```

**Frequency:** After each subtask completion (when the auditor writes findings). Not after every individual file edit — that would be too noisy.

## Syncing Project Prompt & Knowledge

Shared knowledge lives on `team11-coord`:

```
team11-coord branch:
  hive.md
  operators/
    cyberstein.json
    oldworldlab.json
  logs/
    cs-pair-1.md
    owl-pair-1.md
  project-prompt.md        # shared project knowledge
  knowledge/
    tech-stack.md
    gotchas.md
    ...
```

**On connect/join:** If `project-prompt.md` exists on `team11-coord`, download it to `.team11/project-prompt.md`. If it doesn't exist but the local one does, upload it.

**On proposal approval:** After a human approves a knowledge proposal, the CEO:
1. Saves it to the local `.team11/knowledge/` file
2. Uploads the updated knowledge file to `team11-coord`
3. Updates `project-prompt.md` index if needed, uploads that too

Both operators get the same project knowledge base.

## Reading Other Operators' Pair Logs

When the CEO needs detail about what another operator's pair is doing:

```bash
OTHER_PREFIX="owl"
OTHER_PAIR=1
gh api repos/$REPO/contents/logs/${OTHER_PREFIX}-pair-${OTHER_PAIR}.md?ref=team11-coord \
  --jq '.content' | base64 -d
```

Read-only — each operator only writes their own pair logs.

## Operator Heartbeat

Each time the CEO syncs the hive, update the operator's `last_active` timestamp:

```bash
OPERATOR_FILE="operators/${OPERATOR_NAME}.json"
CURRENT=$(gh api repos/$REPO/contents/$OPERATOR_FILE?ref=team11-coord)
SHA=$(echo "$CURRENT" | jq -r '.sha')
CONTENT=$(echo "$CURRENT" | jq -r '.content' | base64 -d | jq --arg ts "$(date -Iseconds)" '.last_active = $ts')

gh api repos/$REPO/contents/$OPERATOR_FILE \
  -X PUT \
  -f message="heartbeat: ${OPERATOR_NAME}" \
  -f content="$(echo "$CONTENT" | base64)" \
  -f sha="$SHA" \
  -f branch="team11-coord"
```

**Frequency:** Every 15 minutes or on each hive sync, whichever is less frequent.

## Offline / Degraded Mode

If the GitHub API is unreachable (network down, rate limited):
1. Fall back to local hive (solo mode behavior)
2. Log warning: `[CEO] WARNING: GitHub API unreachable — operating in degraded solo mode`
3. Retry on next dispatch
4. When connectivity returns, sync local hive to remote (merge, don't overwrite)

Network issues never block work. Temporary loss of cross-operator visibility is acceptable for short outages.

## Rate Limiting

GitHub API rate limit: 5000 requests/hour for authenticated users.

Team11 connected mode uses approximately:
- 2 API calls per hive read (content + SHA)
- 1 API call per hive write
- 1 API call per pair log sync
- 1 API call per heartbeat

With 5 pairs and hourly heartbeats: ~50-100 API calls/hour per operator. Well within limits.

If approaching rate limit: batch syncs, reduce heartbeat frequency, cache aggressively.
