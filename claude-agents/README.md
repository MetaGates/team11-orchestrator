# Team11 registered subagent stubs

Copy these three files into a project's **`.claude/agents/`** so Claude Code registers the
Team11 subagent types the CEO dispatches via the Agent tool:

- `team11-coder-auditor.md` — the paired coder/auditor (role rotates; never reviews own edit)
- `team11-researcher.md` — web research → structured report (no code changes)
- `team11-secretary.md` — OUTBOX → memory-DB carrier + hive render (no source changes)

Each stub is a thin registration: frontmatter (`allowed-tools`, `model: opus`) plus a pointer to
the **full agent prompt** in `~/.claude/skills/team11/agents/`. So an install needs BOTH:

1. the skill at `~/.claude/skills/team11/` (this repo), and
2. these stubs in the consuming project's `.claude/agents/`.

These are generic — no project-specific content. The per-project pieces (config.json,
`.team11/mcp-server/` build, MCP registration) are set up separately per project.
