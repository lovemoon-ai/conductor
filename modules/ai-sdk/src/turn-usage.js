/**
 * @typedef {object} TurnUsageSummary
 * @property {number} tokens Everything the turn read and wrote.
 * @property {number} [inputTokens] All input the model read, cached or not.
 * @property {number} [cachedInputTokens] The part of `inputTokens` served from the prompt cache.
 */

/**
 * Normalizes one turn's provider usage; the input cache hit ratio is
 * `cachedInputTokens / inputTokens`. Claude's `input_tokens` excludes cache
 * reads and writes, so its input is all three; the Codex provider reports
 * per-turn deltas whose `turnInputTokens` already include the cached ones.
 * Unknown shapes → null.
 *
 * @param {unknown} usage
 * @returns {TurnUsageSummary | null}
 */
export function summarizeTurnUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const read = (key) => {
    const value = Number(/** @type {Record<string, unknown>} */ (usage)[key]);
    return Number.isFinite(value) ? value : null;
  };
  const turnTotal = read("turnTotalTokens");
  if (turnTotal !== null) {
    const inputTokens = read("turnInputTokens");
    const cachedInputTokens = read("turnCachedInputTokens");
    return inputTokens !== null && cachedInputTokens !== null
      ? { tokens: turnTotal, inputTokens, cachedInputTokens }
      : { tokens: turnTotal };
  }
  const [input, cacheWrite, cacheRead, output] = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
  ].map(read);
  if ([input, cacheWrite, cacheRead, output].every((value) => value === null)) {
    return null;
  }
  const inputTokens = (input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0);
  return { tokens: inputTokens + (output ?? 0), inputTokens, cachedInputTokens: cacheRead ?? 0 };
}
