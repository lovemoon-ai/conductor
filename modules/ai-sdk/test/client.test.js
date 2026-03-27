import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAiSession, RemoteAiSession } from "../src/index.js";
import { CodexAppServerSession } from "../src/session-factory.js";

describe("ai-sdk client boundary", () => {
  it("supports codex app-server sessions", async () => {
    const session = createAiSession("code", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    assert.equal(session.getSnapshot().backend, "codex");
    assert.equal(session.getSnapshot().provider, "codex-app-server");

    await session.close();
  });

  it("supports claude agent-sdk sessions", async () => {
    const session = createAiSession("claude-code", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    assert.equal(session.getSnapshot().backend, "claude");
    assert.equal(session.getSnapshot().provider, "claude-agent-sdk");

    await session.close();
  });

  it("supports opencode sdk sessions", async () => {
    const session = createAiSession("opencode", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    assert.equal(session.getSnapshot().backend, "opencode");
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    await session.close();
  });

  it("supports kimi cli wire sessions", async () => {
    const session = createAiSession("kimi-cli", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    assert.equal(session.getSnapshot().backend, "kimi");
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    await session.close();
  });

  it("preserves codex model metadata when thread info is replayed from notifications", () => {
    const session = new CodexAppServerSession("codex", { cwd: process.cwd(), logger: { log: () => {} } });

    session.applyThreadInfo(
      {
        thread: {
          id: "thread-1",
          path: "/tmp/thread-1.jsonl",
          modelProvider: "codex-thread",
        },
        model: "gpt-5.4",
        modelProvider: "codex",
        reasoningEffort: "high",
      },
      { resumeReady: false },
    );
    session.applyThreadInfo(
      {
        thread: {
          id: "thread-1",
          path: "/tmp/thread-1.jsonl",
        },
      },
      { resumeReady: false },
    );

    assert.deepEqual(session.getSessionInfo(), {
      backend: "codex",
      sessionId: "thread-1",
      sessionFilePath: "/tmp/thread-1.jsonl",
      model: "gpt-5.4",
      modelProvider: "codex",
      reasoningEffort: "high",
    });
    assert.deepEqual(session.threadOptions, {
      model: "gpt-5.4",
      modelProvider: "codex",
    });
  });

  it("rejects unsupported backends", () => {
    assert.throws(
      () =>
        createAiSession("gemini", {
          cwd: process.cwd(),
          logger: { log: () => {} },
        }),
      /Only codex app-server, claude agent-sdk, kimi cli wire, and opencode sdk are supported/,
    );
  });
});
