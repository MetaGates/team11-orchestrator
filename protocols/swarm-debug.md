# Team11 Swarm Debugging Protocol

Two related patterns for hard bugs: competing-hypothesis (single-pair, structured retry) and swarm (all pairs, parallel investigation).

Loaded by the CEO only on `/team11 swarm-debug <bug>` or when a pair has been stuck on the same error for 3+ attempts.

## Competing-Hypothesis Debugging

When an agent is stuck (same error after 3 attempts), switch to evidence-driven debugging:

1. **Generate 3+ hypotheses** for why the failure is happening
2. **Design a test for each** — what would confirm or eliminate this hypothesis?
3. **Run the cheapest test first** — the one that eliminates the most hypotheses with the least effort
4. **Document findings** — log each hypothesis + evidence in the pair log
5. **If still stuck after 5 hypotheses**, surface to human with all evidence collected

This prevents agents from spinning on the same approach repeatedly.

## Swarm Debugging Mode

Swarm debugging is a special mode where ALL available pairs independently investigate a single bug from different angles. Each pair writes findings to the hive mind. When pairs converge on root causes, a **mandatory human review gate** decides which hypothesis to pursue. Agents **never** auto-resolve disagreements about root causes.

### Trigger

The CEO enters swarm debug mode when:
1. The user explicitly requests it: `/team11 swarm-debug <bug description>`
2. The CEO assesses a bug as high-complexity (multiple possible root causes, cross-cutting concerns, intermittent behavior)
3. A pair has been stuck on a bug for more than 1 round without progress (CEO suggests swarm mode to user)

The CEO **never** auto-enters swarm mode. It always requires user confirmation via `AskUserQuestion`:
```
This bug looks complex enough for swarm debugging.
Swarm mode dispatches ALL available pairs to investigate independently.
Estimated cost: ~3-5x a single-pair investigation.

Options (via AskUserQuestion):
  - Enter swarm-debug mode
  - Stick with single-pair investigation
  - Cancel
```

### Agent Dispatch

Each pair gets a distinct investigation angle. The CEO assigns angles based on pair pheromone history (pairs familiar with relevant subsystems get priority angles):

| Pair | Investigation Angle | Typical Actions |
|------|-------------------|-----------------|
| Pair 1 | **Stack trace analysis** | Trace execution path top-down, identify where behavior diverges from expected |
| Pair 2 | **Codebase pattern search** | Search for similar patterns, related bugs, shared utility functions that might be involved |
| Pair 3 | **Git history analysis** | `git log`, `git blame`, bisect for the commit that introduced the regression |
| Pair 4 | **Minimal reproduction** | Write a minimal test case that reproduces the bug, isolate the exact trigger conditions |
| Pair 5 | **Dependency/environment audit** | Check library versions, configuration, environment differences, external service behavior |

If fewer than 5 pairs are available, the CEO combines angles (e.g., Pair 1 does stack trace + git history).

Dispatch template addition for swarm mode:
```
MODE: swarm-debug
BUG: [exact bug description with reproduction steps]
YOUR ANGLE: [assigned investigation angle]
OTHER PAIRS: [what angles other pairs are investigating]
HIVE MIND: [current state including other pairs' early findings]

SWARM RULES:
1. Read the hive mind's Discovered Facts before starting — another pair may have already found a clue
2. Write findings to your pair log immediately as you discover them (use [SWARM-FINDING] prefix)
3. Do NOT attempt to fix the bug. Investigate only. The fix comes after convergence.
4. If you find a root cause, write it clearly with EVIDENCE (file paths, line numbers, reproduction)
5. If another pair's finding changes your hypothesis, note it and adjust
6. Time-box: 15 minutes of investigation. If no progress, write what you tried and STOP.
```

### Convergence

The CEO monitors all pair logs in real-time during swarm debugging. As findings come in:

1. **CEO reads each pair's `[SWARM-FINDING]` entries** from their pair logs
2. **CEO promotes findings to hive.md Discovered Facts** with the source pair noted
3. **CEO watches for convergence**: multiple pairs pointing to the same root cause
4. **CEO watches for divergence**: pairs pointing to DIFFERENT root causes

Convergence states:
- **UNANIMOUS**: All pairs (or all that found a root cause) agree. CEO presents to human with high confidence.
- **MAJORITY**: 3+ pairs agree, 1-2 disagree. CEO presents the majority hypothesis AND the minority hypothesis, with evidence for each.
- **SPLIT**: Pairs disagree roughly equally. CEO presents ALL hypotheses with evidence. Human picks.
- **INCONCLUSIVE**: No pair found a root cause. CEO reports what was tried, what was eliminated, and recommends next steps (more targeted investigation, additional logging, or reproduction in a different environment).

### HUMAN GATE — MANDATORY

**When agents have different root causes, the CEO presents ALL hypotheses with evidence to the user via `AskUserQuestion`. The user picks which to pursue. Agents do NOT auto-resolve disagreements about root causes.**

Presentation format:
```
SWARM DEBUG RESULTS — HUMAN DECISION REQUIRED

Bug: [description]
Pairs investigated: [N]
Time spent: [total investigation time]

## Hypothesis A (Pairs 1, 3)
Root cause: [description]
Evidence:
  - Pair 1: [stack trace finding with file:line references]
  - Pair 3: [git blame finding showing when it was introduced]
Confidence: HIGH (convergent evidence from different angles)

## Hypothesis B (Pair 2)
Root cause: [description]
Evidence:
  - Pair 2: [pattern search finding]
Confidence: MEDIUM (single source, plausible but unverified)

## Eliminated
- Pair 4: Reproduction confirms bug but didn't isolate root cause
- Pair 5: Dependencies and environment checked clean

## CEO Recommendation
[Which hypothesis seems strongest based on evidence weight — but the human decides]

AskUserQuestion options:
  - Pursue Hypothesis A
  - Pursue Hypothesis B
  - Request more investigation (specify angle)
  - Cancel swarm-debug
```

### Resolution

After the human selects a hypothesis:
1. **Assign one pair** (preferably the pair that found the selected root cause) to implement the fix
2. **Assign a second pair** to audit the fix (standard audit protocol)
3. **Other pairs**: if the human wants, they can audit from their original angle (e.g., Pair 4 verifies the fix resolves their reproduction case)
4. Normal merge flow follows (Step 6 of dispatch protocol)

### What Swarm Debug Is NOT

- It is NOT a general parallelization strategy. It is specifically for hard bugs where the root cause is uncertain.
- It is NOT free. 5 pairs investigating costs ~5x one pair. Only use for bugs that justify the cost.
- It is NOT autonomous. The human always decides which root cause to pursue. Always.
- It is NOT a replacement for good debugging practices. If a bug is obvious from the stack trace, one pair is enough.
