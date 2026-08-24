/**
 * log-derive.ts — pure helpers shared by the Secretary carrier
 * (scripts/process-pair-log.ts) and the one-off repair script
 * (scripts/repair-findings.ts). Kept dependency-free so the repair script can
 * regenerate titles with EXACTLY the function the carrier uses going forward.
 */

/** Hard cap on a derived title (chars, including the "..." suffix). */
export const TITLE_MAX = 80;
/**
 * A first sentence/clause shorter than this is not a title (e.g. "MAJOR",
 * "Pre", "cli") — fall back to the leading TITLE_MAX chars of the whole line.
 */
export const TITLE_MIN_SEGMENT = 20;

/**
 * Sentence boundaries ONLY. The previous implementation split on the character
 * class `[.:—–-]`, so any bare hyphen / colon / dot INSIDE a token cut the title
 * mid-word: "Text-containment chokepoint…" → "Text", "hive.md is stale" →
 * "hive", "discovery.py:367-379 sorts…" → "discovery". A boundary is now a
 * terminator FOLLOWED BY A SPACE (". ", ": ", "; ") or a spaced em-dash (" — ").
 * The ". " form is NOT a boundary after the common abbreviations "e.g." /
 * "i.e." / "etc." / "vs." / "cf." / "approx." (audit round 1, minor 1).
 */
const SENTENCE_BOUNDARY_RE = /(?<!\b(?:e\.g|i\.e|etc|vs|cf|approx))\. |: |; | — /;

/** Short title from a free-text prose line (first sentence/clause, capped). */
export function deriveTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return cleaned;
  const idx = firstBoundaryOutsideSpans(cleaned);
  let cut = idx !== -1 ? cleaned.slice(0, idx).trim() : cleaned;
  if (cut.length < TITLE_MIN_SEGMENT) cut = cleaned;
  if (cut.length <= TITLE_MAX) return cut;
  return capTitle(cut);
}

/**
 * Index of the first sentence boundary that is NOT inside an open code span
 * or an unclosed paren — `` `SELECT a: b` is slow `` must not split at ": "
 * and "foo (note: bar) baz" must not split at "note: ". A boundary skipped
 * this way falls through to the next one; -1 when none qualifies.
 */
function firstBoundaryOutsideSpans(cleaned: string): number {
  const re = new RegExp(SENTENCE_BOUNDARY_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const prefix = cleaned.slice(0, m.index);
    const inCode = (prefix.match(/`/g) ?? []).length % 2 === 1;
    const inParen = (prefix.match(/\(/g) ?? []).length > (prefix.match(/\)/g) ?? []).length;
    if (!inCode && !inParen) return m.index;
  }
  return -1;
}

/**
 * Cap at TITLE_MAX with a "..." suffix WITHOUT stopping inside a code span or
 * an unclosed paren: a title ending `` (`"call(" in src... `` carries an odd
 * backtick count and re-flags itself as "unbalanced" on every repair pass
 * (audit round 1, minor 2). First choice: cut back before the open span/paren
 * (capBeforeOpenSpan). When that is not viable (the whole title IS one long
 * code span), close what is open after the "..." instead, shrinking the slice
 * so the closers still fit inside TITLE_MAX.
 */
function capTitle(cut: string): string {
  let body = capBeforeOpenSpan(cut.slice(0, TITLE_MAX - 3));
  let closers = neededClosers(body);
  if (closers) {
    body = capBeforeOpenSpan(cut.slice(0, TITLE_MAX - 3 - closers.length));
    closers = neededClosers(body);
  }
  return `${body}...${closers}`;
}

/** The characters that would balance `s`: a backtick for an open code span, ")" per unmatched "(". */
function neededClosers(s: string): string {
  let closers = "";
  if ((s.match(/`/g) ?? []).length % 2 === 1) closers += "`";
  const open = (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
  if (open > 0) closers += ")".repeat(open);
  return closers;
}

/**
 * Cut back to just before the last opening backtick, then before the last
 * unmatched "(", each only while the result stays a usable title
 * (>= TITLE_MIN_SEGMENT); drop trailing separators the cut-back exposes.
 */
function capBeforeOpenSpan(slice: string): string {
  let s = slice;
  if ((s.match(/`/g) ?? []).length % 2 === 1) {
    const back = s.slice(0, s.lastIndexOf("`")).trimEnd();
    if (back.length >= TITLE_MIN_SEGMENT) s = back;
  }
  let depth = 0;
  let unmatchedOpen = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ")") depth++;
    else if (s[i] === "(") {
      if (depth === 0) {
        unmatchedOpen = i;
        break;
      }
      depth--;
    }
  }
  if (unmatchedOpen > 0) {
    const back = s.slice(0, unmatchedOpen).trimEnd();
    if (back.length >= TITLE_MIN_SEGMENT) s = back;
  }
  return s.replace(/[\s,;:]+$/, "");
}

/**
 * Pair id from a log path: the basename without its `.md` extension.
 *   ".team11/logs/pair-occdiet.md"   → "pair-occdiet"
 *   "C:\\x\\.team11\\logs\\audit-harness-r1.md" → "audit-harness-r1"
 * Returns null for a non-.md path or an empty stem. Used as the provenance
 * FALLBACK for `source_pair` — an explicit `pair` field in an [OUTBOX:*] JSON
 * object always wins.
 */
export function pairIdFromLogPath(logPath: string): string | null {
  const base = logPath.split(/[\\/]/).pop() ?? "";
  if (!/\.md$/i.test(base)) return null;
  const stem = base.slice(0, -3).trim();
  return stem.length > 0 ? stem : null;
}
