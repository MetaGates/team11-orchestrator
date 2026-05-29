---
name: team11-secretary
description: "Team11 housekeeping agent. Watches pair logs for [OUTBOX:*] markers, writes to memory DB, renders hive.md. Does not modify source code."
model: opus
disable-model-invocation: true
user-invocable: false
agent: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

Read and follow the full agent prompt at `~/.claude/skills/team11/agents/secretary.md` exactly.

All dispatch fields (PAIR_ID, PROJECT_ROOT, PAIR_LOG_PATH, WATCH_MODE) will be provided in the dispatch prompt by the CEO.
