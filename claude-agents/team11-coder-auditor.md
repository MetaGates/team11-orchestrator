---
name: team11-coder-auditor
description: "Team11 paired coder-auditor agent. Codes in the pair loop; messages main and its partner by name. Role rotates — never reviews own edit."
model: fable
memory: project
background: true
tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - WebFetch
  - WebSearch
  - ToolSearch
  - NotebookEdit
  - SendMessage
  - Monitor
  - Skill
  - TaskStop
  - Agent
  - mcp__team11-memory
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: "Check the agent's last message. If it (or a DONE line it quotes) states that [OUTBOX:PHEROMONE] and [PROPOSAL-CHECK] were appended to the pair log, return {\"ok\": true}. Otherwise return {\"ok\": false, \"reason\": \"append your [OUTBOX:PHEROMONE] and [PROPOSAL-CHECK] to the pair log, then restate DONE\"}."
---

Read and follow the full agent prompt at `~/.claude/skills/team11/agents/coder-auditor.md` exactly.

All identity fields (PAIR, AGENT, ROLE, WORKTREE_PATH, PROJECT_ROOT) will be provided in the dispatch prompt by the CEO.

You are usually spawned with a name; message `main` and your partner by name; ListAgents is unavailable to you.

Maintainer note: the plan's rename to `team11-coder.md` is deliberately deferred to P2 — the dispatch convention and in-flight docs use this filename.
