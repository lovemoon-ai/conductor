import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { OpencodeSdkSession } from "../src/providers/opencode-sdk-session.js";

class StubTransport extends EventEmitter {
  constructor() {
    super();
    this.bootCalls = 0;
    this.closeCalls = 0;
    this.pid = 4242;
  }

  async boot() {
    this.bootCalls += 1;
    return { url: "http://127.0.0.1:4096" };
  }

  async close() {
    this.closeCalls += 1;
  }
}

function makeSession(sessionOptions = {}) {
  const calls = { create: 0, get: 0, subscribe: 0 };
  const client = {
    event: {
      async subscribe() {
        calls.subscribe += 1;
        return { stream: { [Symbol.asyncIterator]: async function* () {} } };
      },
    },
    session: {
      async create() {
        calls.create += 1;
        return { id: `session-created-${calls.create}` };
      },
      async get() {
        calls.get += 1;
        return { id: sessionOptions.resumeSessionId };
      },
    },
  };
  const transport = new StubTransport();
  const session = new OpencodeSdkSession("opencode", {
    cwd: process.cwd(),
    logger: { log: () => {} },
    sdkModule: { createOpencodeClient: () => client },
    transport,
    ...sessionOptions,
  });
  return { session, calls, transport };
}

describe("opencode session - runClear", () => {
  it("advertises clear capability", () => {
    assert.equal(makeSession().session.getSnapshot().capabilities.clear, true);
  });

  it("creates a new session on the same server without restarting it", async () => {
    const { session, calls, transport } = makeSession({ resumeSessionId: "session-old" });
    await session.boot();
    assert.equal(session.sessionId, "session-old");
    session.history.push({ role: "user", content: "remember PINEAPPLE-42" });

    const result = await session.runClear();

    assert.deepEqual(result.clear, { status: "cleared", sessionId: "session-created-1" });
    assert.equal(session.sessionId, "session-created-1");
    assert.equal(calls.create, 1);
    assert.equal(transport.bootCalls, 1, "the opencode server process is reused");
    assert.equal(transport.closeCalls, 0);
    assert.deepEqual(session.history, []);
    assert.equal(session.resumeSessionId, "");
    await session.close();
  });

  it("is a noop on a brand-new session that never ran a turn", async () => {
    const { session, calls } = makeSession();

    const result = await session.runClear();

    assert.equal(result.clear.status, "noop");
    assert.equal(calls.create, 0);
    await session.close();
  });
});
