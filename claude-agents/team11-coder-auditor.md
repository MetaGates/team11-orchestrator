---
name: team11-coder-auditor
description: "Team11 paired coder-auditor agent. Codes, audits, researches, and fixes in a permanent worktree. Role rotates — never reviews own edit."
model: opus
disable-model-invocation: true
user-invocable: false
agent: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
  - WebFetch
  - WebSearch
  - ToolSearch
  - NotebookEdit
---

Read and follow the full agent prompt at `~/.claude/skills/team11/agents/coder-auditor.md` exactly.

All identity fields (PAIR, AGENT, ROLE, WORKTREE_PATH, PROJECT_ROOT) will be provided in the dispatch prompt by the CEO.
