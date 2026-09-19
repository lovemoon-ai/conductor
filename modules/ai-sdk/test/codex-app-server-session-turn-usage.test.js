import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

const usage = (turnId, total, last) => [
  "thread/tokenUsage/updated",
  {
    threadId: "thread-1",
    turnId,
    tokenUsage: { total: { totalTokens: total }, last: { totalTokens: last }, modelContextWindow: 1000 },
  },
];

// One codex turn: started, `[threadTotal, lastResponse]` usage updates, completed.
const turn = (turnId, updates, status = "completed", error = null) => [
  ["turn/started", { turn: { id: turnId } }],
  ...updates.map(([total, last]) => usage(turnId, total, last)),
  ["turn/completed", { turn: { id: turnId, status, error } }],
];

// `onRequest(method)` returns the notifications codex sends after that request.
function makeSession(onRequest) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-usage-"));
  const session = new CodexAppServerSession("codex", { cwd, logger: { log: () => {} } });
  session.boot = async () => {};
  session.sessionId = "thread-1";
  session.transport = {
    request: async (method) => {
      const notifications = onRequest(method) || [];
      setImmediate(async () => {
        for (const [name, params] of notifications) {
          await session.handleNotification(name, params);
        }
      });
      return {};
    },
  };
  return session;
}

function makeTurnSession(turns) {
  let index = 0;
  return makeSession((method) => (method === "turn/start" ? turns[index++] : []));
}

describe("codex app-server session - per-turn token usage", () => {
  it("reports each turn's share of the thread total", async () => {
    const session = makeTurnSession([
      turn("turn-1", [[60, 60], [90, 30]]),
      turn("turn-2", [[150, 60]]),
    ]);
    const first = await session.runTurn("one");
    assert.equal(first.usage.turnTotalTokens, 90);
    assert.equal(first.usage.total.totalTokens, 90);
    const second = await session.runTurn("two");
    assert.equal(second.usage.turnTotalTokens, 60);
  });

  it("excludes totals a resumed thread carried over from before", async () => {
    const session = makeTurnSession([turn("turn-1", [[1060, 60], [1100, 40]])]);
    const result = await session.runTurn("resumed");
    assert.equal(result.usage.turnTotalTokens, 100);
  });

  it("uses the total codex replays after thread/resume as the baseline", async () => {
    // The replay lands after the turn is installed but before turn/started.
    const session = makeTurnSession([[usage("turn-old", 1000, 300), ...turn("turn-1", [[1100, 100]])]]);
    const result = await session.runTurn("resumed");
    assert.equal(result.usage.turnTotalTokens, 100);
  });

  it("attaches the spent tokens to a failed or interrupted turn", async () => {
    const session = makeTurnSession([turn("turn-1", [[80, 80]], "interrupted")]);
    await assert.rejects(session.runTurn("stop me"), (error) => {
      assert.equal(error.usage.turnTotalTokens, 80);
      return true;
    });
  });

  it("reports unknown usage for a turn that ended before any response completed", async () => {
    const session = makeTurnSession([turn("turn-1", [[60, 60]]), turn("turn-2", [], "interrupted")]);
    await session.runTurn("one");
    await assert.rejects(session.runTurn("stop me early"), (error) => {
      assert.equal(error.usage.turnTotalTokens, undefined);
      return true;
    });
  });

  it("counts a context-overflow attempt's tokens into the retried turn", async () => {
    const overflow = { message: "context_length_exceeded: input too long" };
    const session = makeTurnSession([
      turn("turn-1", [[500, 500]], "failed", overflow),
      turn("turn-2", [[30, 30]]),
    ]);
    const result = await session.runTurn("big");
    assert.equal(result.usage.turnTotalTokens, 530);
  });

  it("counts a compaction's own tokens", async () => {
    const session = makeSession((method) =>
      method === "turn/start"
        ? turn("turn-1", [[60, 60]])
        : method === "thread/compact/start"
          ? turn("turn-c", [[80, 20]])
          : [],
    );
    await session.runTurn("one");
    const result = await session.runCompact();
    assert.equal(result.compact.status, "compacted");
    assert.equal(result.usage.turnTotalTokens, 20);
  });

  it("includes usage that arrives after the terminal goal status", async () => {
    const session = makeSession((method) =>
      method === "thread/goal/set"
        ? [...turn("turn-g1", [[60, 60]]), ["thread/goal/updated", { goal: { objective: "ship", status: "complete" } }]]
        : [],
    );
    const emitWorkingStatus = session.emitWorkingStatus.bind(session);
    let late = false;
    session.emitWorkingStatus = async (payload) => {
      if (!late && String(payload?.status_done_line || "").startsWith("codex goal")) {
        late = true;
        await session.handleNotification(...usage("turn-g1", 130, 70));
      }
      return emitWorkingStatus(payload);
    };
    const result = await session.runGoal({ objective: "ship" });
    assert.equal(late, true);
    assert.equal(result.usage.turnTotalTokens, 130);
  });

  it("reports a whole goal's tokens", async () => {
    const session = makeSession((method) =>
      method === "thread/goal/set"
        ? [
            ...turn("turn-g1", [[60, 60]]),
            ...turn("turn-g2", [[100, 40]]),
            ["thread/goal/updated", { goal: { objective: "ship", status: "complete" } }],
          ]
        : [],
    );
    const result = await session.runGoal({ objective: "ship" });
    assert.equal(result.usage.turnTotalTokens, 100);
  });

  it("drops the baseline when rolling onto a fresh thread", () => {
    const session = makeSession(() => []);
    session.turnTokenBaseline = 500;
    session.rollOntoFreshThread();
    assert.equal(session.turnTokenBaseline, null);
  });
});
