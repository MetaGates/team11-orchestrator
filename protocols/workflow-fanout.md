# Workflow-Backed Fan-Out — Protocol
**Project:** Team11 (generic)
**Type:** protocol
**Last updated:** 2026-05-29

How the Team11 CEO delegates a **read-only, parallel fan-out phase** to the native `Workflow` tool, then feeds the validated results into the gated pair loop. Load this whenever a task has a scatter→gather phase (audit, research sweep, multi-file analysis, scoring, classification, list-curation-style scatter).

## The principle (benchmarked)
Output quality is **method-independent** — equal between a Workflow and a Team11 pair on the same task (spike 2026-05-29, [[project-workflow-vs-team11-spike]]). At **equal agent count** the native Workflow was **~31% faster and ~38% cheaper** (118K tok / ~5.8 min vs the pair's 191K / ~8.4 min). Team11's per-agent overhead (the long coder-auditor system prompt + pair logs / checkpoints / outbox / memory queries) is not waste — it buys durable artifacts, cross-run memory, role rotation, and crash recovery. So:

- **Workflow = the efficient engine** for read-only scatter→gather.
- **Team11 gated loop = the governed process** for writes.

## Cost model — what Workflow saves (and what it does NOT)
Workflow saves **wall-clock time** (parallelism) and **main-context budget** (subagents read in their own windows; only distilled results return). It does **NOT** save total tokens — for the same reads it costs **more** than serial (per-agent system-prompt overhead + duplicated reading). Its only token win is indirect: subagent reads are one-shot, so offloading bulk reading keeps the *recurring* main context lean. **The real token-savers are graphify (structural queries — no file reads) and disciplined grep.** Never reach for a Workflow to "save tokens" or to do a narrow lookup — there it is pure overhead.

## Decision rule (per phase, not per task) — the cost-tier ladder
Pick the **cheapest tool that fits the question shape**:

| Question shape | Tool | Why |
|---|---|---|
| Narrow / specific ("what does X do", "where is Y defined") | **grep + targeted read** | cheapest; always fresh; read only what you need |
| Repeated **structural** ("who calls X", "impact of changing Y", god-nodes, path A→B) | **graphify** (kept fresh, AST-trusted) | ~free per query; deterministic AST edges |
| **Broad / semantic / many similar items, read-only** | **Workflow fan-out** | parallel (time) + isolates main context — the engine for read-only scatter→gather |
| **Writes** / approval / role rotation / durable findings / cross-run memory | **Team11 pair loop** | governed process |

**Hybrid (most real tasks):** Workflow for the read-only fan-out → hand the **validated** results to the human gate → pair loop for the **writes**. A Workflow NEVER lands writes.

## Hard invariants
1. **A Workflow NEVER lands writes.** It has no human gate and no memory. Every write flows through the pair loop + `AskUserQuestion` gate ([[feedback_review_before_changes]]).
2. **Schema every agent.** Pass a JSON `schema` to each `agent()` so output is validated + auto-retried. The prompt MUST end with "your final action must be the StructuredOutput call" — a schema agent that ends in prose can abort the run. Prefer `parallel()` (a throwing thunk drops to `null`; `.filter(Boolean)` after) so one failure isn't fatal.
3. **Read-only means read-only.** Agent prompts must say "do NOT edit / write / build / run — read + analyze only."
4. **Structured output is a CLAIM, not truth.** A schema validates *shape*, not correctness or completeness; summarization is lossy and silent. So: (a) every findings schema MUST carry **evidence** (`file:line` + a verbatim quote) so claims are spot-checkable; (b) **verify load-bearing claims** before any consequential decision (grep / graphify / re-run tests / diff vs reference); (c) the fan-out is a **scout for triage/routing** — never make an irreversible call on the summary alone; (d) the **human gate receives the evidence**, not just the recommendation. "Right every time" comes from this verification layer, not the fan-out's precision.

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
