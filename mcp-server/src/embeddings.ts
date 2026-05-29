import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/** Canonical model name — import this instead of hardcoding the string. */
export const EMBEDDING_MODEL = "all-MiniLM-L6-v2";

/**
 * Embedding dimensionality. MUST match the vec0 column width in db.ts
 * (`findings_vec.embedding float[384]`). A vector of any other length would be
 * silently rejected/truncated by the vec table or, worse, mean-pooled against a
 * mismatched accumulator — so we assert it before storing or pooling.
 */
export const EMBEDDING_DIM = 384;

let embedder: FeatureExtractionPipeline | null = null;

/**
 * Initialize the embedding model. Downloads on first use (~22MB).
 * Uses all-MiniLM-L6-v2: 384-dimensional, fast, good for English text.
 */
export async function initEmbeddings(): Promise<void> {
  if (embedder) return;
  try {
    embedder = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")) as FeatureExtractionPipeline;
    console.error("[team11-memory] Embedding model loaded: all-MiniLM-L6-v2 (384d)");
  } catch (err) {
    console.error("[team11-memory] WARNING: Failed to load embedding model. Vector search disabled.", err);
    embedder = null;
  }
}

/** Max chars per chunk — roughly MiniLM's ~256-token window. */
const CHUNK_SIZE = 1000;
/** Cap chunks to bound compute on very long findings (5 * 1000 = 5000 chars). */
const MAX_CHUNKS = 5;

/**
 * Fail-fast guard: a model returning a vector whose width != EMBEDDING_DIM is a
 * configuration error (wrong model loaded) that would otherwise be written to
 * the float[384] vec0 column and corrupt vector search. Throwing here is caught
 * by embed()'s try/catch and surfaced as a null embedding plus a logged error,
 * which the callers (storeEmbedding, seed) already treat as "skip this row".
 */
function assertDim(vec: Float32Array, where: string): void {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `[team11-memory] embedding dimension mismatch in ${where}: got ${vec.length}, expected ${EMBEDDING_DIM}`,
    );
  }
}

/**
 * Generate embedding vector for text.
 * Returns Float32Array of 384 dimensions (for MiniLM-L6-v2).
 * Returns null if embeddings not initialized.
 *
 * Text longer than one chunk (~1000 chars) is split into sequential chunks
 * (capped at MAX_CHUNKS), each embedded separately, then mean-pooled
 * component-wise and re-normalized into a single unit vector. This preserves
 * the tail of long findings that a hard truncate would silently drop.
 * Text <= CHUNK_SIZE takes the single-embed path, identical to before.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!embedder) return null;
  try {
    // Short path: single embed, unchanged behavior (no averaging artifacts).
    if (text.length <= CHUNK_SIZE) {
      const output = await embedder(text, { pooling: "mean", normalize: true });
      const vec = new Float32Array(output.data as Float32Array);
      assertDim(vec, "short-path embed");
      return vec;
    }

    // Long path: chunk -> embed each -> mean-pool -> re-normalize.
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
      chunks.push(text.substring(i, i + CHUNK_SIZE));
    }

    // Size the accumulator from EMBEDDING_DIM (not the first chunk's length), and
    // assert every chunk vector matches it — a wrong-width vector must never be
    // pooled (it would either throw on index, or silently corrupt the result).
    const pooled = new Float32Array(EMBEDDING_DIM);
    for (const chunk of chunks) {
      const output = await embedder(chunk, { pooling: "mean", normalize: true });
      const vec = output.data as Float32Array;
      assertDim(vec, "long-path chunk embed");
      for (let d = 0; d < pooled.length; d++) {
        pooled[d] += vec[d];
      }
    }
    if (chunks.length === 0) return null;

    // Component-wise average.
    for (let d = 0; d < pooled.length; d++) {
      pooled[d] /= chunks.length;
    }

    // Re-normalize to unit length (averaging unit vectors shrinks the norm).
    let norm = 0;
    for (let d = 0; d < pooled.length; d++) {
      norm += pooled[d] * pooled[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < pooled.length; d++) {
        pooled[d] /= norm;
      }
    }

    return pooled;
  } catch (err) {
    console.error("[team11-memory] Embedding error:", err);
    return null;
  }
}

/**
 * Check if embeddings are available.
 */
export function embeddingsAvailable(): boolean {
  return embedder !== null;
}

/**
 * Get embedding dimensions.
 */
export function embeddingDimensions(): number {
  return EMBEDDING_DIM; // all-MiniLM-L6-v2
}
