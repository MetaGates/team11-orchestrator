#!/usr/bin/env node
/**
 * auditor-bash-guard.ts — PreToolUse command hook (matcher: Bash) for the
 * enforced read-only auditor agent (.claude/agents/team11-auditor.md).
 *
 * Hook contract (Claude Code hooks): the hook JSON arrives on stdin
 * ({ tool_name, tool_input: { command }, ... }). Exit 0 ALLOWS the Bash call;
 * exit 2 BLOCKS it and stderr is shown to the agent as the reason.
 *
 * Policy: the auditor is read-only. It may run reads, compiles-to-scratch and
 * tests, and may WRITE only under scratchpad / findings / logs / checkpoints
 * (its findings file, pair log, checkpoint). Everything mutating is blocked —
 * a trivial fix is MESSAGED to the coder, never applied by the auditor.
 *
 * Conservative by design: when unsure, BLOCK with a clear reason — the auditor
 * can ask the CEO. False positives are acceptable; false negatives are not.
 * This file has no imports beyond node:fs and touches no DB.
 */

import { readFileSync } from "node:fs";

const ASK = "if this read is legitimate, ask the CEO (main) to run it";

function block(reason: string): never {
  process.stderr.write(`auditor-bash-guard BLOCKED: ${reason} — auditors are read-only; message the coder for fixes; ${ASK}.\n`);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  block("could not read hook input from stdin (conservative default)");
}

let command = "";
try {
  const payload = JSON.parse(raw) as {
    tool_name?: string;
    tool_input?: { command?: unknown };
  };
  if (payload.tool_name && payload.tool_name !== "Bash") allow();
  command = String(payload.tool_input?.command ?? "");
} catch {
  block("could not parse hook JSON on stdin (conservative default)");
}

if (!command.trim()) allow();

/** Directories the auditor may write into (per the Team11 protocol). */
const ALLOWED_DIR = /(scratchpad|findings|logs|checkpoints)/i;
/** Scratch-ish locations acceptable for compile output / copies / links. */
const SCRATCHISH = /(scratchpad|findings|logs|checkpoints|te?mp\b|[\\/]tmp[\\/])/i;

// ---------------------------------------------------------------------------
// 1. Flat deny rules — mutating commands, blocked outright.
//    NOTE the spec'd carve-out: `git checkout -b` (pure branch creation) is
//    the ONLY checkout form allowed; everything else rewrites the worktree.
// ---------------------------------------------------------------------------
const DENY: Array<[RegExp, string]> = [
  [/\bgit\s+(commit|add|merge(?!-base)|push|pull|reset|restore|switch|stash|clean|rebase|revert|cherry-pick|rm|mv|am|apply|update-ref|symbolic-ref|filter-branch|gc|prune|replace)\b/, "mutating git subcommand"],
  [/\bgit\s+checkout\b(?!\s+-b\b)/, "git checkout rewrites the worktree (only `git checkout -b` is exempt)"],
  [/\bgit\s+branch\b[^|;&]*(\s-(d|D|f|m|M|c|C)\b|--(delete|force|move|copy|set-upstream))/, "git branch with a delete/move/force flag"],
  [/\bgit\s+worktree\s+(add|remove|move|prune|repair|lock|unlock)\b/, "git worktree mutation"],
  [/\bgit\s+tag\b(?!\s*($|-l\b|--list\b))/, "git tag creation"],
  [/\bgit\s+remote\s+(add|remove|rm|set-url|rename|prune)\b/, "git remote mutation"],
  [/\bgit\s+config\b(?!\s+(--get\b|--get-all\b|--get-regexp\b|--list\b|-l\b))/, "git config write"],
  [/(^|[\s;|&(])(rm|rmdir|del|erase|rd|truncate|shred|unlink)(\.exe)?\s/i, "file/dir deletion"],
  [/\bfind\b[^|;&]*\s-(delete|exec\s)/, "find -delete/-exec"],
  [/(^|[\s;|&(])mv(\.exe)?\s/, "mv (rename/overwrite)"],
  [/\b(npm|pnpm|yarn)\s+(i|install|ci|add|remove|uninstall|update|upgrade|link|publish)\b/, "package install/publish"],
  [/\b(npm|pnpm|yarn)\s+run\s+build\b/, "npm run build (dist/ is executed live by the SubagentStop hook)"],
  [/\bpip3?\s+install\b|\buv\s+pip\s+install\b|\buv\s+(add|sync|remove)\b/, "python package install"],
  [/\balembic\s+(upgrade|downgrade|revision|merge|stamp|init|edit)\b/, "alembic migration write (only current/history/heads/show/check are reads)"],
  [/(^|\s)--execute\b/, "--execute is this repo's write switch (dry-run is the default everywhere)"],
  [/\bsed(\.exe)?\s+(-\w+\s+)*-i\b/, "sed -i in-place edit"],
  [/\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Rename-Item)\b/i, "PowerShell write cmdlet"],
  [/\bwget\b/, "wget writes files (use WebFetch)"],
];

for (const [re, reason] of DENY) {
  if (re.test(command)) block(reason);
}

// ---------------------------------------------------------------------------
// 2. Output redirects: allowed only into scratchpad/findings/logs/checkpoints
//    (plus /dev/null, NUL and fd duplication). Everything else — including a
//    redirect onto any tracked file — is blocked.
// ---------------------------------------------------------------------------
const masked = command
  .replace(/\d*>\s*&\s*\d+/g, " ") // 2>&1, >&2, 1>&2
  .replace(/&?\d*>>?\s*\/dev\/null\b/gi, " ")
  .replace(/&?\d*>>?\s*NUL\b/gi, " ");
const redirect = /(\d|&)?>>?\s*([^\s;|&]+)/g;
let m: RegExpExecArray | null;
while ((m = redirect.exec(masked)) !== null) {
  const target = m[2];
  if (!ALLOWED_DIR.test(target)) {
    block(`output redirect to '${target}' (writes are allowed only under scratchpad/findings/logs/checkpoints)`);
  }
}

// tee writes files like a redirect does.
if (/\btee\b/.test(command) && !ALLOWED_DIR.test(command)) {
  block("tee writes files (allowed only under scratchpad/findings/logs/checkpoints)");
}

// cp / link creation: allowed only when clearly aimed at scratch space.
if (/(^|[\s;|&(])(cp(\.exe)?\s|ln\s|mklink\b)/.test(command) && !SCRATCHISH.test(command)) {
  block("cp/ln/mklink outside scratch space can overwrite tracked files");
}

// curl may fetch, but not write files outside scratch space.
if (/\bcurl\b/.test(command) && /(\s-o\b|\s-O\b|--output\b|--remote-name\b)/.test(command) && !SCRATCHISH.test(command)) {
  block("curl with an output flag outside scratch space");
}

// ---------------------------------------------------------------------------
// 3. tsc: compile only to scratch (never the live dist/), or pure --noEmit.
// ---------------------------------------------------------------------------
if (/\btsc\b/.test(command) && !/--noEmit\b/.test(command)) {
  const outDir = /--outDir\s+("[^"]+"|\S+)/.exec(command);
  if (!outDir || !SCRATCHISH.test(outDir[1])) {
    block("tsc must compile with --outDir into the scratchpad (dist/ is executed live) or use --noEmit");
  }
}

// Everything else — git log/show/diff/status/branch/merge-base/ls-files/
// check-ignore, node <script> --dry-run, pytest, grep/rg/ls/cat, etc. — passes.
allow();
