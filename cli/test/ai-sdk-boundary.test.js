import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as aiSdk from "@love-moon/ai-sdk";

describe("ai-sdk boundary", () => {
  it("exposes runtime session entrypoints and the resume API", () => {
    assert.equal(typeof aiSdk.createAiSession, "function");
    assert.equal(typeof aiSdk.RemoteAiSession, "function");
    assert.equal(typeof aiSdk.buildResumeArgsForBackend, "function");
    assert.equal(typeof aiSdk.resolveResumeContext, "function");
    assert.equal(typeof aiSdk.resumeProviderForBackend, "function");
    assert.equal(typeof aiSdk.findSessionPath, "function");
    assert.equal(typeof aiSdk.resolveSessionRunDirectory, "function");
    assert.ok(Array.isArray(aiSdk.BUILT_IN_BACKENDS));
    assert.ok(aiSdk.BUILT_IN_BACKENDS.length > 0);
  });

  it("creates a codex session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("codex", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    await session.readyPromise;
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

    await session.readyPromise;
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

    await session.readyPromise;
    assert.equal(session.threadOptions.model, "opencode");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "opencode");
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    await session.close();
  });

  it("creates a copilot session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    await session.readyPromise;
    assert.equal(session.threadOptions.model, "copilot");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "copilot");
    assert.equal(session.getSnapshot().provider, "copilot-sdk");

    await session.close();
  });

  it("creates a kimi session without exposing provider-specific helpers", async () => {
    const session = aiSdk.createAiSession("kimi", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    await session.readyPromise;
    assert.equal(session.threadOptions.model, "kimi");
    assert.equal(session.usesSessionFileReplyStream(), true);
    assert.equal(session.getSnapshot().backend, "kimi");
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    await session.close();
  });
});
