/**
 * Composite scoring engine for Team11 Memory MCP.
 * Formula: BM25(40%) + Importance(25%) + Recency(20%) + Access Frequency(15%)
 */

interface ScoredFields {
  bm25_score: number;
  importance: number;
  updated_at?: string;
  created_at: string;
  access_count: number;
  confidence_score?: number;
}

/**
 * Compute composite score for a search result.
 * All sub-scores are normalized to 0-1 before weighting.
 */
export function computeCompositeScore(result: ScoredFields): number {
  // BM25: FTS5 returns negative values (lower = better match).
  // Normalize absolute value into 0-1 range, capping at 20.
  const bm25 = Math.min(1.0, Math.abs(result.bm25_score) / 20);

  // Importance: already 0-1 in the schema, default 0.4.
  const importance = result.importance ?? 0.4;

  // Recency: 1.0 for today, linear decay to 0 over 90 days.
  const daysSinceUpdate = daysBetween(
    result.updated_at ?? result.created_at,
    new Date(),
  );
  const recency = Math.max(0, 1.0 - daysSinceUpdate / 90);

  // Access frequency: caps at 10 accesses for full score.
  const accessFreq = Math.min((result.access_count ?? 0) / 10, 1.0);

  // Confidence: multiplicative gate — low confidence entries get deprioritized.
  const confidence = result.confidence_score ?? 1.0;

  const rawScore =
    bm25 * 0.4 + importance * 0.25 + recency * 0.2 + accessFreq * 0.15;
  return rawScore * confidence;
}

function daysBetween(dateStr: string, now: Date): number {
  const date = new Date(dateStr);
  const ms = now.getTime() - date.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Estimate token count for a piece of text.
 * Rough approximation: 1 token ~ 4 characters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
