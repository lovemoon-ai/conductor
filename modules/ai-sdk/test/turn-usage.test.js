import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summarizeTurnUsage } from "../src/index.js";

describe("summarizeTurnUsage", () => {
  it("counts Claude input as fresh input plus cache writes and reads", () => {
    assert.deepEqual(
      summarizeTurnUsage({
        input_tokens: 4,
        cache_creation_input_tokens: 22098,
        cache_read_input_tokens: 21072,
        output_tokens: 94,
        service_tier: "standard",
      }),
      { tokens: 43268, inputTokens: 43174, cachedInputTokens: 21072 },
    );
    assert.deepEqual(summarizeTurnUsage({ input_tokens: 10, output_tokens: 5 }), {
      tokens: 15,
      inputTokens: 10,
      cachedInputTokens: 0,
    });
  });

  it("uses the Codex provider's per-turn deltas, whose input already includes cached tokens", () => {
    assert.deepEqual(
      summarizeTurnUsage({
        turnTotalTokens: 60,
        turnInputTokens: 50,
        turnCachedInputTokens: 40,
        total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 90 },
      }),
      { tokens: 60, inputTokens: 50, cachedInputTokens: 40 },
    );
    // A delta without the input split (e.g. only an overflow retry's tokens) keeps the count.
    assert.deepEqual(summarizeTurnUsage({ turnTotalTokens: 70 }), { tokens: 70 });
  });

  it("ignores unknown shapes", () => {
    assert.equal(summarizeTurnUsage({ total: { totalTokens: 150 } }), null);
    assert.equal(summarizeTurnUsage({ inputTokens: 5 }), null);
    assert.equal(summarizeTurnUsage(null), null);
    assert.equal(summarizeTurnUsage("usage"), null);
  });
});
