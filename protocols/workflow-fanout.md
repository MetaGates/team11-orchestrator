# Workflow-Backed Fan-Out — Protocol
**Project:** Team11 (generic)
**Type:** protocol
**Last updated:** 2026-05-29

How the Team11 CEO delegates a **read-only, parallel fan-out phase** to the native `Workflow` tool, then feeds the validated results into the gated pair loop. Load this whenever a task has a scatter→gather phase (audit, research sweep, multi-file analysis, scoring, classification, list-curation-style scatter).

## The principle (benchmarked)
Output quality is **method-independent** — equal between a Workflow and a Team11 pair on the same task (spike 2026-05-29, [[project-workflow-vs-team11-spike]]). At **equal agent count** the native Workflow was **~31% faster and ~38% cheaper** (118K tok / ~5.8 min vs the pair's 191K / ~8.4 min). Team11's per-agent overhead (the long coder-auditor system prompt + pair logs / checkpoints / outbox / memory queries) is not waste — it buys durable artifacts, cross-run memory, role rotation, and crash recovery. So:

- **Workflow = the efficient engine** for read-only scatter→gather.
- **Team11 gated loop = the governed process** for writes.

## Decision rule (per phase, not per task)
- **Read-only** (audit / research / analyze / score / classify), schema-shaped, many similar items, no writes → **Workflow**.
- **Writes** / needs human approval / role rotation / durable findings / cross-run memory → **Team11 pair loop**.
- **Hybrid** (most real tasks) → **Workflow for the fan-out, hand the validated results to the human gate, then the pair loop for the writes.**

## Hard invariants
1. **A Workflow NEVER lands writes.** It has no human gate and no memory. Every write flows through the pair loop + `AskUserQuestion` gate ([[feedback_review_before_changes]]).
2. **Schema every agent.** Pass a JSON `schema` to each `agent()` so output is validated + auto-retried. The prompt MUST end with "your final action must be the StructuredOutput call" — a schema agent that ends in prose can abort the run. Prefer `parallel()` (a throwing thunk drops to `null`; `.filter(Boolean)` after) so one failure isn't fatal.
3. **Read-only means read-only.** Agent prompts must say "do NOT edit / write / build / run — read + analyze only."

## How the CEO invokes it
1. Identify the fan-out: the item list (files, sources, venues, dimensions) + the per-item read-only task.
2. Author a Workflow script: `meta` block + a JSON `schema` for findings + `parallel(items.map(() => agent(prompt, {schema})))` for the scatter + one synthesis `agent()` for the gather (dedupe + rank).
3. Call the `Workflow` tool. It returns a `runId`; watch via `/workflows`; you're notified on completion.
4. Take the returned **structured** results → present to the human via `AskUserQuestion` (the gate) → dispatch the **pair loop** for any approved writes.

## Repeatability — what it does and does NOT mean
Workflow "repeatability" = **harness/process reproducibility**, not output determinism:
- The orchestration is a **versioned `.js` script** (commit it, diff it, re-run on new inputs via `args`).
- `runId` journals every run; `resumeFromRunId` replays the unchanged prefix from cache (byte-identical) and re-runs only edited/downstream steps (crash recovery, cheap iteration).
- Schema contracts keep downstream logic stable across runs (no parse drift).
- Execution is **unattended**.

It does **NOT** make the model deterministic — a fresh re-run produces different agent text, same as Team11. And "hands-off" **trades away the human gate**, which for writes you WANT (judgment beats mechanical repeatability). It pays off at **scale / recurrence** (nightly audit, migrate N files, review every PR, re-run on new cities via `args`) — not one-shots. Team11's analogous strength is different: **governed consistency** (human-enforced quality + accumulating hive memory), which doesn't replay but compounds over time.

## Canonical example
The first Team11 Workflow-backed fan-out (2026-05-29): a **read-only QA audit of the mcp-server source** — one agent per source group (`core` / `tools` / `scripts` / `cli`), schema'd findings, automatic synthesis (runId `wf_96ed0251-942`). Pattern:

```js
const audits = await parallel(GROUPS.map((g) => () =>
  agent(readOnlyAuditPrompt(g), { label: `audit:${g.key}`, phase: 'Audit', schema: FINDINGS })))
const all = audits.filter(Boolean).flatMap((a) => a.findings)
const synthesis = await agent(`Dedupe + rank: ${JSON.stringify(all)}`, { phase: 'Synthesize', schema: SYNTH })
return { synthesis }   // → CEO presents to the human gate; no writes landed by the Workflow
```
