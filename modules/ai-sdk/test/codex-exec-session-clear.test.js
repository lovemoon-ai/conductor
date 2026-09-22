import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexExecSession } from "../src/providers/codex-exec-session.js";

function makeSession(options = {}) {
  return new CodexExecSession("codex", { cwd: process.cwd(), logger: { log: () => {} }, ...options });
}

describe("codex exec session - runClear", () => {
  it("advertises clear capability", () => {
    assert.equal(makeSession().getSnapshot().capabilities.clear, true);
  });

  it("drops the replayed history, which is the whole context for codex exec", async () => {
    const session = makeSession();
    session.history.push({ role: "user", content: "remember PINEAPPLE-42" });
    session.history.push({ role: "assistant", content: "OK" });
    assert.match(session.buildPrompt("what codeword?"), /PINEAPPLE-42/);

    const result = await session.runClear();

    assert.equal(result.clear.status, "cleared");
    assert.deepEqual(session.history, []);
    assert.doesNotMatch(session.buildPrompt("what codeword?"), /PINEAPPLE-42/);
  });

  it("is a noop when there is no history yet", async () => {
    const result = await makeSession().runClear();
    assert.equal(result.clear.status, "noop");
  });
});
