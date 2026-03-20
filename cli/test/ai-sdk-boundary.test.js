import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as aiSdk from "@love-moon/ai-sdk";

describe("ai-sdk boundary", () => {
  it("only exposes runtime session entrypoints", () => {
    assert.equal(typeof aiSdk.createAiSession, "function");
    assert.equal(typeof aiSdk.RemoteAiSession, "function");
    assert.equal("buildResumeArgsForBackend" in aiSdk, false);
    assert.equal("resolveResumeContext" in aiSdk, false);
  });

  it("creates a codex session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("codex", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.equal(session.threadOptions.model, "codex");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "codex");

    await session.close();
  });

  it("creates a claude session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.equal(session.threadOptions.model, "claude");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "claude");
    assert.equal(session.getSnapshot().provider, "claude-agent-sdk");

    await session.close();
  });

  it("creates an opencode session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("opencode", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.equal(session.threadOptions.model, "opencode");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "opencode");
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    await session.close();
  });
});
