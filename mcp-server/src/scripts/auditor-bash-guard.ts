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
 * tests, and may WRITE only into the allowed segments — .team11/{findings,logs,
 * checkpoints,proposals} plus scratch space (a scratchpad/tmp/temp path segment)
 * and /dev/null|NUL. Everything mutating is blocked — a trivial fix is
 * MESSAGED to the coder, never applied by the auditor.
 *
 * Round-2 hardening (findings pair-t11defs-round-1.md, operator-approved):
 *  F1 git global options (-C/-c/--git-dir/--work-tree/…) are normalized away
 *     before subcommand matching, so `git -C . add .` cannot bypass the rules.
 *  F2 write-target checks are PATH-SEGMENT-anchored (no substring luck, no
 *     dot-dot traversal, no unexpanded $VAR/backtick targets); cp/ln/mklink/
 *     tee/dd/curl validate their DESTINATION argument, not the whole command.
 *  F3 interpreter evals (python -c, node -e/--eval, perl/ruby -e, shell -c,
 *     pwsh -Command) are scanned for write/exec markers (open(...,'w'),
 *     writeFileSync, os.system, subprocess, shutil, rmtree, unlink, fs.rm, …);
 *     read-only evals pass. Deny-rule prefix class includes quotes/backticks.
 *  F4 dd of=, rsync, install(1) denied; the `>|` noclobber operator is treated
 *     as a redirect.
 *  F5 the `git checkout -b` carve-out is REMOVED — checkout also moves HEAD
 *     (shared-worktree gotcha 3894); ALL checkout forms are blocked.
 *  F6 metatext mitigation: a QUOTED-delimiter heredoc body whose redirect
 *     target is an allowed path is stripped before scanning (inert text, no
 *     shell expansion), so findings that quote mutating commands can be
 *     written. Unquoted-delimiter heredocs (expansion active) and piped
 *     heredocs are still scanned in full.
 *  F7 `.team11/proposals/` added to the allowed write segments (the protocol
 *     grants auditors proposal writes).
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

// ---------------------------------------------------------------------------
// Allowed write targets — PATH-SEGMENT anchored (F2, F7).
// ---------------------------------------------------------------------------
function isAllowedWriteTarget(rawTarget: string): boolean {
  let t = rawTarget.trim().replace(/^["']+|["']+$/g, "");
  if (!t) return false;
  if (/[$`]/.test(t)) return false; // unexpanded variable / substitution — cannot verify
  t = t.replace(/\\/g, "/");
  if (/^\/dev\/null$/i.test(t) || /^nul$/i.test(t)) return true;
  if (/(^|\/)\.\.(\/|$)/.test(t)) return false; // dot-dot traversal
  if (/(^|\/)\.team11\/(findings|logs|checkpoints|proposals)(\/|$)/i.test(t)) return true;
  if (/(^|\/)scratchpad(\/|$)/i.test(t)) return true;
  if (/(^|\/)(tmp|temp)(\/|$)/i.test(t)) return true; // scratch space (incl. AppData/Local/Temp)
  return false;
}

// ---------------------------------------------------------------------------
// F6: strip QUOTED-delimiter heredoc bodies destined for allowed targets.
// A quoted delimiter (<<'EOF' or <<"EOF") disables shell expansion, so the
// body is inert text; if it is being written to an allowed path (and not
// piped anywhere), quoting mutating commands inside it is safe.
// ---------------------------------------------------------------------------
function stripSafeHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hd = /<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    out.push(line);
    if (!hd) continue;
    const delim = hd[2];
    // Only strip when the operator line writes to an allowed target and has no pipe.
    let safe = !line.includes("|");
    if (safe) {
      const rt = /(\d|&)?>>?\s*([^\s;|&<]+)/.exec(line.replace(/\d*>\s*&\s*\d+/g, " "));
      safe = !!rt && isAllowedWriteTarget(rt[2]);
    }
    if (!safe) continue; // body stays in place and is scanned in full
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== delim) j++;
    if (j < lines.length) out.push(lines[j]); // keep the delimiter line
    i = j;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// F1: normalize git global options away so `git -C . add .`, `git -c k=v
// commit`, `git --git-dir=X push` … hit the subcommand rules.
// ---------------------------------------------------------------------------
function normalizeGit(cmd: string): string {
  const OPT =
    "(?:-C\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)" +
    "|-c\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)" +
    "|--git-dir(?:=\\S+|\\s+\\S+)" +
    "|--work-tree(?:=\\S+|\\s+\\S+)" +
    "|--namespace(?:=\\S+|\\s+\\S+)" +
    "|--no-pager|-P|--paginate|-p|--no-optional-locks|--literal-pathspecs|--noglob-pathspecs|--glob-pathspecs|--icase-pathspecs)";
  const re = new RegExp("\\bgit\\s+(?:" + OPT + "\\s+)+", "g");
  return cmd.replace(re, "git ");
}

const scan = stripSafeHeredocs(command);
const gitScan = normalizeGit(scan);

// ---------------------------------------------------------------------------
// 1. Flat deny rules — mutating commands, blocked outright. Run against BOTH
//    the heredoc-stripped command and its git-normalized twin (normalization
//    can only remove text, so scanning both misses nothing).
//    Prefix class includes quotes and backtick (F3b) so `bash -c "rm …"` and
//    backtick substitution are caught.
// ---------------------------------------------------------------------------
const PRE = "(^|[\\s;|&(`'\"])";
const DENY: Array<[RegExp, string]> = [
  [/\bgit\s+(commit|add|merge(?!-base)|push|pull|reset|restore|switch|stash|clean|rebase|revert|cherry-pick|rm|mv|am|apply|update-ref|symbolic-ref|filter-branch|gc|prune|replace)\b/, "mutating git subcommand"],
  [/\bgit\s+checkout\b/, "git checkout rewrites the worktree and/or moves HEAD (F5: no carve-outs — auditors never need checkout)"],
  [/\bgit\s+branch\b[^|;&]*(\s-(d|D|f|m|M|c|C)\b|--(delete|force|move|copy|set-upstream))/, "git branch with a delete/move/force flag"],
  [/\bgit\s+worktree\s+(add|remove|move|prune|repair|lock|unlock)\b/, "git worktree mutation"],
  [/\bgit\s+tag\b(?!\s*($|-l\b|--list\b))/, "git tag creation"],
  [/\bgit\s+remote\s+(add|remove|rm|set-url|rename|prune)\b/, "git remote mutation"],
  [/\bgit\s+config\b(?!\s+(--get\b|--get-all\b|--get-regexp\b|--list\b|-l\b))/, "git config write"],
  [new RegExp(PRE + "(rm|rmdir|del|erase|rd|truncate|shred|unlink)(\\.exe)?\\s", "i"), "file/dir deletion"],
  [/\bfind\b[^|;&]*\s-(delete|exec\s)/, "find -delete/-exec"],
  [new RegExp(PRE + "mv(\\.exe)?\\s"), "mv (rename/overwrite)"],
  [new RegExp(PRE + "(rsync|install)(\\.exe)?\\s", "i"), "rsync/install write to arbitrary paths (F4)"],
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
  if (re.test(scan) || re.test(gitScan)) block(reason);
}

// ---------------------------------------------------------------------------
// 2. Output redirects (incl. the >| noclobber form, F4): target must be an
//    allowed segment. fd duplication and /dev/null|NUL are masked first.
// ---------------------------------------------------------------------------
const masked = scan
  .replace(/\d*>\s*&\s*\d+/g, " ") // 2>&1, >&2, 1>&2
  .replace(/&?\d*>>?\|?\s*\/dev\/null\b/gi, " ")
  .replace(/&?\d*>>?\|?\s*NUL\b/gi, " ");
const redirect = /(\d|&)?>>?\s*\|?\s*([^\s;|&<]+)/g;
let m: RegExpExecArray | null;
while ((m = redirect.exec(masked)) !== null) {
  const target = m[2];
  if (!isAllowedWriteTarget(target)) {
    block(`output redirect to '${target}' (writes are allowed only under .team11/{findings,logs,checkpoints,proposals} or scratch space)`);
  }
}

// ---------------------------------------------------------------------------
// 3. Destination-argument checks for the file-writing utilities (F2, F4):
//    cp/ln (last arg = destination), mklink (first non-flag arg = link),
//    tee (every non-flag arg), dd (of=), curl (-o target; -O always blocked),
//    per pipeline/chain segment so `cd x && cp a b` is still seen.
// ---------------------------------------------------------------------------
function tokenize(seg: string): string[] {
  return seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}
const segments = scan.split(/&&|\|\||;|\||\n/);
for (const segRaw of segments) {
  const seg = segRaw.trim();
  if (!seg) continue;
  const tokens = tokenize(seg);
  if (tokens.length === 0) continue;
  const head = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();

  if ((head === "cp" || head === "ln") && tokens.length >= 3) {
    const dest = tokens[tokens.length - 1];
    if (!isAllowedWriteTarget(dest)) block(`${head} destination '${dest}' is outside the allowed write segments`);
  }
  if (head === "tee") {
    for (const t of tokens.slice(1)) {
      if (t.startsWith("-")) continue;
      if (!isAllowedWriteTarget(t)) block(`tee target '${t}' is outside the allowed write segments`);
    }
  }
  if (head === "dd") {
    const of = tokens.find((t) => /^of=/i.test(t));
    if (of && !isAllowedWriteTarget(of.slice(3))) block(`dd of=${of.slice(3)} writes outside the allowed segments (F4)`);
  }
  if (head === "curl") {
    if (tokens.some((t) => t === "-O" || t === "--remote-name")) block("curl -O writes into the cwd (use WebFetch or an explicit scratch path)");
    const oi = tokens.findIndex((t) => t === "-o" || t === "--output");
    if (oi !== -1) {
      const dest = tokens[oi + 1] ?? "";
      if (!isAllowedWriteTarget(dest)) block(`curl output '${dest}' is outside the allowed write segments`);
    }
  }
  const mki = tokens.findIndex((t) => /^mklink$/i.test(t.replace(/^.*[\\/]/, "")));
  if (mki !== -1) {
    const rest = tokens.slice(mki + 1).filter((t) => !/^\/[DHJ]$/i.test(t));
    const link = rest[0] ?? "";
    if (!isAllowedWriteTarget(link)) block(`mklink link '${link}' is outside the allowed write segments`);
  }

  // -------------------------------------------------------------------------
  // F3: interpreter eval payloads — block write/exec markers, allow read-only.
  // -------------------------------------------------------------------------
  const EVAL_HEADS = new Set(["python", "python3", "node", "perl", "ruby", "bash", "sh", "zsh", "dash", "pwsh", "powershell"]);
  if (EVAL_HEADS.has(head)) {
    const fi = tokens.findIndex((t) => t === "-c" || t === "-e" || t === "--eval" || /^-Command$/i.test(t));
    if (fi !== -1) {
      const payloadStr = tokens
        .slice(fi + 1)
        .join(" ")
        .replace(/^["']+|["']+$/g, "");
      if (!payloadStr.trim()) block(`${head} ${tokens[fi]} with no extractable payload (conservative default)`);
      const WRITE_MARKERS =
        /open\s*\([^)]*,\s*['"][wax]|write_text|write_bytes|writeFileSync|writeFile\s*\(|appendFile|fs\.(rm|unlink|rename|mkdir|writeFile|copyFile)|rmSync|unlinkSync|renameSync|mkdirSync|copyFileSync|child_process|execSync|spawnSync|os\.(system|popen|remove|unlink|rmdir|rename|replace|makedirs|removedirs)|subprocess|shutil|rmtree|\bunlink\b|System\.IO|\.Delete\(|\.WriteAll/i;
      if (WRITE_MARKERS.test(payloadStr)) {
        block(`${head} ${tokens[fi]} payload contains write/exec markers (read-only evals pass; when in doubt the guard blocks)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. tsc: compile only to scratch (never the live dist/), or pure --noEmit.
// ---------------------------------------------------------------------------
if (/\btsc\b/.test(scan) && !/--noEmit\b/.test(scan)) {
  const outDir = /--outDir\s+("[^"]+"|\S+)/.exec(scan);
  if (!outDir || !isAllowedWriteTarget(outDir[1])) {
    block("tsc must compile with --outDir into scratch space (dist/ is executed live) or use --noEmit");
  }
}

// Everything else — git log/show/diff/status/branch/merge-base/ls-files/
// check-ignore (with or without -C/-c global options), node <script> --dry-run,
// pytest, grep/rg/ls/cat, read-only interpreter one-liners, etc. — passes.
allow();
