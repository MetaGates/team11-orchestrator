/**
 * Pre-process text for FTS5 indexing.
 * Splits camelCase, PascalCase, snake_case, kebab-case, and file paths
 * into separate searchable tokens.
 */
export function tokenizeForFts(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")       // camelCase -> camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTMLParser -> HTML Parser
    .replace(/_/g, " ")                          // snake_case -> snake case
    .replace(/-/g, " ")                          // kebab-case -> kebab case
    .replace(/[\/\\.]/g, " ")                    // file/paths -> file paths
    .replace(/\s+/g, " ")                        // collapse whitespace
    .trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same",
  "than", "too", "very", "just", "because", "if", "when", "where",
  "how", "what", "which", "who", "whom", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "it", "its", "they", "them", "their",
]);

/**
 * Extract search keywords from a natural language query.
 * Removes stopwords and applies tokenization.
 */
export function extractKeywords(text: string): string[] {
  const tokenized = tokenizeForFts(text);
  return tokenized
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Build an FTS5 MATCH query from keywords.
 * Uses OR logic so partial matches still return results.
 */
export function buildFtsQuery(keywords: string[]): string {
  if (keywords.length === 0) return "";
  // Escape special FTS5 characters
  const escaped = keywords.map((k) => k.replace(/['"(){}[\]*:^~!@#$%&]/g, ""));
  return escaped.filter((k) => k.length > 0).join(" OR ");
}
