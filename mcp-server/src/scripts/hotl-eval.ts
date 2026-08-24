/**
 * hotl-eval.ts — HOTL gate step 3b, automated (operator decision D2,
 * 2026-08-24). Computes the auto-merge criteria for one audit round from the
 * findings file + the pair worktree's diff and appends ONE line to the shadow
 * log (`.team11/findings/hotl-shadow.jsonl`, existing schema). The manual
 * step was being skipped under load (last hand-written line 2026-08-10); a
 * script cannot forget.
 *
 * Usage:
 *   node dist/scripts/hotl-eval.js --pair <id> --round <n> --findings <path>
 *        [--worktree <path>] [--base <ref>] [--preverif pass|fail]
 *        [--decision <HUMAN_DECISION>] [--note <text>] [--backfill]
 *        [--project <root>]
 *   node dist/scripts/hotl-eval.js --update-decision --pair <id> --round <n>
 *        --decision <HUMAN_DECISION> [--note <text>] [--project <root>]
 *
 * Fail-closed rules (would_auto_merge=false with a reason):
 *   - findings file has no `## Summary` block with a `Critical: N | Major: N`
 *     line → "unparseable-findings"
 *   - no --worktree (or git diff fails) → files/lines unknown → "diff-unavailable"
 *   - no --preverif → "preverif-unknown" (the script cannot run ruff/lint
 *     itself; the CEO passes what the pair log proves)
 *   - any diff file matching `risk_files_always_gate` → "risk-file"
 *
 * `agreement` = would_auto_merge === (human decision reads as approved);
 * null while the decision is absent/PENDING. `--update-decision` rewrites the
 * LAST matching (pair, round) line in place.
 *
 * stdout: the verdict JSON (one line). stderr: human summary. Exit 0 on
 * success, 2 on bad arguments, 3 when --update-decision finds no line.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Args {
  projectRoot?: string;
  pair?: string;
  round?: number;
  findings?: string;
  worktree?: string;
  base?: string;
  preverif?: boolean;
  decision?: string;
  note?: string;
  backfill: boolean;
  updateDecision: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { backfill: false, updateDecision: false };
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pair") args.pair = value(a, ++i);
    else if (a === "--round") {
      const n = Number(value(a, ++i));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--round wants a positive integer`);
      args.round = n;
    } else if (a === "--findings") args.findings = value(a, ++i);
    else if (a === "--worktree") args.worktree = value(a, ++i);
    else if (a === "--base") args.base = value(a, ++i);
    else if (a === "--preverif") {
      const v = value(a, ++i).toLowerCase();
      if (v !== "pass" && v !== "fail") throw new Error(`--preverif wants pass|fail`);
      args.preverif = v === "pass";
    } else if (a === "--decision") args.decision = value(a, ++i);
    else if (a === "--note") args.note = value(a, ++i);
    else if (a === "--project") args.projectRoot = value(a, ++i);
    else if (a === "--backfill") args.backfill = true;
    else if (a === "--update-decision") args.updateDecision = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.pair || args.round === undefined) throw new Error("--pair and --round are required");
  if (args.updateDecision) {
    if (!args.decision) throw new Error("--update-decision requires --decision");
  } else if (!args.findings) {
    throw new Error("--findings is required (or use --update-decision)");
  }
  return args;
}

function findProjectRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.PROJECT_ROOT) return resolve(process.env.PROJECT_ROOT);
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team11"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find project root (no .team11/ directory found)");
}

// --- config ----------------------------------------------------------------

interface Criteria {
  max_critical_findings: number;
  max_major_security_findings: number;
  max_major_findings: number;
  max_files_changed: number;
  max_lines_changed: number;
  require_preverif_pass: string[];
  risk_files_always_gate: string[];
}

interface HotlConfig {
  enabled: boolean;
  mode: string;
  criteria: Criteria;
  shadowLog: string;
}

function loadConfig(projectRoot: string): HotlConfig {
  const raw = JSON.parse(readFileSync(join(projectRoot, ".team11", "config.json"), "utf8"));
  const gate = raw?.hotl_gate;
  if (!gate?.auto_merge_criteria) throw new Error("config.json has no hotl_gate.auto_merge_criteria");
  const c = gate.auto_merge_criteria;
  return {
    enabled: Boolean(gate.enabled),
    mode: String(gate.mode ?? "shadow"),
    criteria: {
      max_critical_findings: Number(c.max_critical_findings ?? 0),
      max_major_security_findings: Number(c.max_major_security_findings ?? 0),
      max_major_findings: Number(c.max_major_findings ?? 0),
      max_files_changed: Number(c.max_files_changed ?? 0),
      max_lines_changed: Number(c.max_lines_changed ?? 0),
      require_preverif_pass: Array.isArray(c.require_preverif_pass) ? c.require_preverif_pass : [],
      risk_files_always_gate: Array.isArray(c.risk_files_always_gate) ? c.risk_files_always_gate : [],
    },
    shadowLog: join(projectRoot, String(gate.shadow_log ?? ".team11/findings/hotl-shadow.jsonl")),
  };
}

// --- findings file ---------------------------------------------------------

interface FindingsParse {
  ok: boolean;
  reason?: string;
  critical: number | null;
  major: number | null;
  major_security: number | null;
  summary_line?: string;
}

const SUMMARY_HEADING_RE = /^#{2,4}\s*Summary\b/i;
const MAJOR_HEADER_RE = /^###\s*\[(?:SEVERITY:\s*)?major\b[^\]]*\]/i;
const CATEGORY_RE = /^\*\*Category:\*\*\s*(.*)$/i;

/**
 * Tolerates every variant seen in 716 real round files: `## Summary` /
 * `### Summary` / `## Summary — Round 2`; `- Critical: 0 | Major: 1 | Minor: 2`
 * with `|` or `·` separators, optional `| Nit: N` / `| Info: N` tails, a bold
 * wrapper, and a parenthetical after the number (`Major: 1 (CONFIRMED, …)`).
 * Primary: the line within 15 lines under the Summary heading. Fallback: the
 * first line ANYWHERE carrying both counts (6 of 716 files put it under a
 * "Verdict" section instead). Neither present → fail closed.
 */
function parseFindings(path: string): FindingsParse {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const h = lines.findIndex((l) => SUMMARY_HEADING_RE.test(l));
  const window = h === -1 ? lines : lines.slice(h + 1, h + 16);
  const hasCounts = (l: string): boolean => {
    const p = l.replace(/\*\*/g, "");
    return /Critical:\s*\d+/i.test(p) && /(?<![A-Za-z])Major:\s*\d+/i.test(p);
  };
  const summaryLine = window.find(hasCounts);
  if (!summaryLine) {
    const reason =
      h === -1
        ? "unparseable-findings: no '## Summary' heading and no 'Critical: N | Major: N' line anywhere"
        : "unparseable-findings: no 'Critical: N | Major: N' line within 15 lines under Summary";
    return { ok: false, reason, critical: null, major: null, major_security: null };
  }
  const plain = summaryLine.replace(/\*\*/g, "");
  const crit = /Critical:\s*(\d+)/i.exec(plain) as RegExpExecArray;
  const maj = /(?<![A-Za-z])Major:\s*(\d+)/i.exec(plain) as RegExpExecArray;

  // major_security: MAJOR finding blocks whose **Category:** mentions security.
  let majorSecurity = 0;
  let inMajor = false;
  for (const l of lines) {
    if (/^###\s/.test(l)) inMajor = MAJOR_HEADER_RE.test(l);
    else if (inMajor) {
      const m = CATEGORY_RE.exec(l);
      if (m && /security/i.test(m[1])) {
        majorSecurity++;
        inMajor = false;
      }
    }
  }

  return {
    ok: true,
    critical: Number(crit[1]),
    major: Number(maj[1]),
    major_security: majorSecurity,
    summary_line: `${h === -1 ? "[fallback-anywhere] " : ""}${plain.trim()}`,
  };
}

// --- diff ------------------------------------------------------------------

interface DiffStats {
  ok: boolean;
  reason?: string;
  base: string | null;
  files: string[];
  lines: number | null;
}

function git(worktree: string, argv: string[]): string {
  return execFileSync("git", ["-C", worktree, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function refExists(worktree: string, ref: string): boolean {
  try {
    git(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function diffStats(worktree: string | undefined, baseArg: string | undefined): DiffStats {
  if (!worktree) return { ok: false, reason: "diff-unavailable: no --worktree", base: null, files: [], lines: null };
  if (!existsSync(worktree)) return { ok: false, reason: `diff-unavailable: worktree not found ${worktree}`, base: null, files: [], lines: null };
  const base = baseArg ?? (refExists(worktree, "main") ? "main" : refExists(worktree, "origin/main") ? "origin/main" : null);
  if (!base) return { ok: false, reason: "diff-unavailable: neither main nor origin/main resolves", base: null, files: [], lines: null };
  let out: string;
  try {
    out = git(worktree, ["diff", "--numstat", `${base}...HEAD`]);
  } catch (err) {
    return { ok: false, reason: `diff-unavailable: git diff failed (${String((err as Error).message).split("\n")[0]})`, base, files: [], lines: null };
  }
  const files: string[] = [];
  let lines = 0;
  for (const row of out.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const [add, del, ...rest] = row.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    files.push(file);
    // binary files report "-" for both counts
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { ok: true, base, files, lines };
}

// --- glob ------------------------------------------------------------------

/** Minimal glob → RegExp: `**` any depth, `*` one segment, `?` one char. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function riskFilesTouched(files: string[], globs: string[]): string[] {
  const res = globs.map(globToRegExp);
  return files.filter((f) => res.some((r) => r.test(f.split("\\").join("/"))));
}

// --- verdict ---------------------------------------------------------------

const APPROVED_RE = /^(PRE[-_]?)?APPROVED|^MERGED|^PRE[-_]?AUTHORIZED/i;

function agreementFor(wouldAutoMerge: boolean, decision: string | undefined): boolean | null {
  if (!decision || /^PENDING/i.test(decision)) return null;
  return wouldAutoMerge === APPROVED_RE.test(decision);
}

interface ShadowLine {
  ts: string;
  pair: string;
  round: number;
  would_auto_merge: boolean;
  criteria: {
    critical: number | null;
    major_security: number | null;
    major: number | null;
    files: number | null;
    lines: number | null;
    preverif_all_pass: boolean | null;
    touched_risk_files: string[];
  };
  reason_blocked?: string;
  human_decision: string;
  agreement: boolean | null;
  evaluator: "hotl-eval";
  mode: string;
  backfill?: true;
  note?: string;
  decided_at?: string;
}

function evaluate(args: Args, cfg: HotlConfig): { line: ShadowLine; detail: Record<string, unknown> } {
  const c = cfg.criteria;
  const findingsPath = resolve(args.findings as string);
  const fp = parseFindings(findingsPath);
  const ds = diffStats(args.worktree, args.base);
  const risk = ds.ok ? riskFilesTouched(ds.files, c.risk_files_always_gate) : [];
  const blocked: string[] = [];

  if (!fp.ok) blocked.push(fp.reason as string);
  else {
    if ((fp.critical as number) > c.max_critical_findings) blocked.push(`critical ${fp.critical} > ${c.max_critical_findings}`);
    if ((fp.major_security as number) > c.max_major_security_findings) blocked.push(`major_security ${fp.major_security} > ${c.max_major_security_findings}`);
    if ((fp.major as number) > c.max_major_findings) blocked.push(`major ${fp.major} > ${c.max_major_findings}`);
  }
  if (!ds.ok) blocked.push(ds.reason as string);
  else {
    if (ds.files.length > c.max_files_changed) blocked.push(`files ${ds.files.length} > ${c.max_files_changed}`);
    if ((ds.lines as number) > c.max_lines_changed) blocked.push(`lines ${ds.lines} > ${c.max_lines_changed}`);
    if (risk.length > 0) blocked.push(`risk-file: ${risk.join(", ")}`);
  }
  if (args.preverif === undefined) blocked.push(`preverif-unknown (pass --preverif pass|fail; required: ${c.require_preverif_pass.join(", ")})`);
  else if (!args.preverif) blocked.push("preverif failed");

  const would = blocked.length === 0;
  const line: ShadowLine = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    pair: args.pair as string,
    round: args.round as number,
    would_auto_merge: would,
    criteria: {
      critical: fp.critical,
      major_security: fp.major_security,
      major: fp.major,
      files: ds.ok ? ds.files.length : null,
      lines: ds.lines,
      preverif_all_pass: args.preverif ?? null,
      touched_risk_files: risk,
    },
    ...(would ? {} : { reason_blocked: blocked.join("; ") }),
    human_decision: args.decision ?? "PENDING",
    agreement: agreementFor(would, args.decision),
    evaluator: "hotl-eval",
    mode: cfg.mode,
    ...(args.backfill ? { backfill: true as const } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
  return {
    line,
    detail: {
      findings_file: findingsPath,
      summary_line: fp.summary_line ?? null,
      diff_base: ds.base,
      diff_files: ds.files,
      gate_enabled: cfg.enabled,
    },
  };
}

// --- shadow log I/O --------------------------------------------------------

function appendLine(shadowPath: string, line: ShadowLine): void {
  let prefix = "";
  if (existsSync(shadowPath)) {
    const cur = readFileSync(shadowPath, "utf8");
    if (cur.length > 0 && !cur.endsWith("\n")) prefix = "\n";
  }
  appendFileSync(shadowPath, `${prefix}${JSON.stringify(line)}\n`);
}

function updateDecision(shadowPath: string, args: Args): ShadowLine {
  if (!existsSync(shadowPath)) throw Object.assign(new Error(`no shadow log at ${shadowPath}`), { exitCode: 3 });
  const raw = readFileSync(shadowPath, "utf8");
  const lines = raw.split("\n");
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o && o.pair === args.pair && Number(o.round) === args.round && "would_auto_merge" in o) idx = i;
    } catch {
      /* non-JSON or event line — skip */
    }
  }
  if (idx === -1) {
    throw Object.assign(new Error(`no shadow line for ${args.pair} round ${args.round}`), { exitCode: 3 });
  }
  const o = JSON.parse(lines[idx]) as ShadowLine;
  o.human_decision = args.decision as string;
  o.agreement = agreementFor(Boolean(o.would_auto_merge), args.decision);
  o.decided_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (args.note) o.note = args.note;
  lines[idx] = JSON.stringify(o);
  const tmp = `${shadowPath}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join("\n"));
  renameSync(tmp, shadowPath);
  return o;
}

// --- main ------------------------------------------------------------------

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[hotl-eval] ${(err as Error).message}`);
    process.exit(2);
  }
  const projectRoot = findProjectRoot(args.projectRoot);
  const cfg = loadConfig(projectRoot);

  if (args.updateDecision) {
    const updated = updateDecision(cfg.shadowLog, args);
    console.error(
      `[hotl-eval] ${updated.pair} r${updated.round}: decision=${updated.human_decision} would_auto_merge=${updated.would_auto_merge} agreement=${updated.agreement}`,
    );
    console.log(JSON.stringify(updated));
    return;
  }

  const { line, detail } = evaluate(args, cfg);
  appendLine(cfg.shadowLog, line);
  console.error(
    `[hotl-eval] ${line.pair} r${line.round} [${cfg.mode}${cfg.enabled ? "" : ", gate disabled"}]: would_auto_merge=${line.would_auto_merge}` +
      (line.reason_blocked ? ` — ${line.reason_blocked}` : "") +
      ` | files=${line.criteria.files ?? "?"} lines=${line.criteria.lines ?? "?"} crit=${line.criteria.critical ?? "?"} major=${line.criteria.major ?? "?"} sec=${line.criteria.major_security ?? "?"}` +
      ` | appended to ${cfg.shadowLog}`,
  );
  console.log(JSON.stringify({ ...line, detail }));
}

try {
  main();
} catch (err) {
  console.error("[hotl-eval] Fatal:", (err as Error).message);
  process.exit(Number((err as { exitCode?: number }).exitCode ?? 1));
}
