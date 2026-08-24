# Team11 registered subagent stubs

Copy these four files into a project's **`.claude/agents/`** so Claude Code registers the
Team11 subagent types the CEO dispatches via the Agent tool:

- `team11-coder-auditor.md` — the pair's coder (messages `main` and its partner by name;
  Stop prompt-hook refuses a stop until the pair log carries `[OUTBOX:PHEROMONE]` +
  `[PROPOSAL-CHECK]`). The P2 rename to `team11-coder.md` is deliberately deferred —
  dispatch convention and in-flight docs use this filename.
- `team11-auditor.md` — the pair's ENFORCED read-only auditor: `disallowedTools`
  blocks Edit/Write/NotebookEdit, and a PreToolUse command hook runs
  `.team11/mcp-server/dist/scripts/auditor-bash-guard.js` (exit 2 blocks mutating Bash;
  writes allowed only into findings/logs/checkpoints/scratchpad). Trivial fixes are
  MESSAGED to the coder, never edited.
- `team11-researcher.md` — web research → structured report (Write is for the report
  file only; no code changes)
- `team11-secretary.md` — MANUAL PASS ONLY (the SubagentStop carrier is the Secretary)

Each stub uses the REAL agent-frontmatter keys (`tools`, `disallowedTools`, `memory`,
`background`, `hooks`, `model`) — not the skill-frontmatter keys (`allowed-tools`,
`disable-model-invocation`, `user-invocable`, `agent:`) the old stubs carried, which
Claude Code silently ignored. Notes:

- `model: fable` is the honest record; the actual control is
  `CLAUDE_CODE_SUBAGENT_MODEL=claude-fable-5` in `~/.claude/settings.json` env,
  which overrides every subagent's model.
- `memory: project` injects the first 200 lines / 25 KB of
  `.claude/agent-memory/<name>/MEMORY.md` into the agent's system prompt — the
  consuming project must seed `team11-coder-auditor/MEMORY.md` and
  `team11-auditor/MEMORY.md` (curated gotcha index; the carrier may regenerate it).
- The pair stubs keep a pointer to the **full agent prompt** in
  `~/.claude/skills/team11/agents/`.

So an install needs ALL of:

1. the skill at `~/.claude/skills/team11/` (this repo),
2. these stubs in the consuming project's `.claude/agents/`,
3. the per-project pieces set up separately: `.team11/` state + config.json,
   the `.team11/mcp-server/` build (the auditor stub's Bash guard lives in its
   `dist/scripts/`), MCP registration, and the `.claude/agent-memory/` seeds.

These are generic — no project-specific content.
