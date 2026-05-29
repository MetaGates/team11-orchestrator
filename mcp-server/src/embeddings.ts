import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/** Canonical model name — import this instead of hardcoding the string. */
export const EMBEDDING_MODEL = "all-MiniLM-L6-v2";

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
      return new Float32Array(output.data as Float32Array);
    }

    // Long path: chunk -> embed each -> mean-pool -> re-normalize.
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
      chunks.push(text.substring(i, i + CHUNK_SIZE));
    }

    let pooled: Float32Array | null = null;
    for (const chunk of chunks) {
      const output = await embedder(chunk, { pooling: "mean", normalize: true });
      const vec = output.data as Float32Array;
      if (!pooled) {
        pooled = new Float32Array(vec.length);
      }
      for (let d = 0; d < pooled.length; d++) {
        pooled[d] += vec[d];
      }
    }
    if (!pooled) return null;

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
  return 384; // all-MiniLM-L6-v2
}
