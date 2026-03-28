import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAiSession, RemoteAiSession } from "../src/index.js";
import { resetExternalProviderRegistryForTests } from "../src/external-provider-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "fake-external-provider.js");
const INVALID_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "invalid-external-provider.js");
const CONFLICTING_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "conflicting-external-provider.js");

function withExternalProvider(providerPath, fn) {
  const previousValue = process.env.AISDK_PROVIDER_PATH;
  if (providerPath) {
    process.env.AISDK_PROVIDER_PATH = providerPath;
  } else {
    delete process.env.AISDK_PROVIDER_PATH;
  }
  resetExternalProviderRegistryForTests();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousValue === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousValue;
      }
      resetExternalProviderRegistryForTests();
    });
}

afterEach(() => {
  delete process.env.AISDK_PROVIDER_PATH;
  delete process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER;
  resetExternalProviderRegistryForTests();
});

describe("ai-sdk client boundary", () => {
  it("supports codex app-server sessions", async () => {
    const session = createAiSession("code", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await session.readyPromise;
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
    await session.readyPromise;
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
    await session.readyPromise;
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
    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "kimi");
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    await session.close();
  });

  it("loads external providers from AISDK_PROVIDER_PATH", async () => {
    await withExternalProvider(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("test-external", {
        cwd: process.cwd(),
        resumeSessionId: "ext-123",
        logger: { log: () => {} },
      });

      assert.ok(session instanceof RemoteAiSession);
      await session.readyPromise;
      assert.equal(session.getSnapshot().backend, "test-external");
      assert.equal(session.getSnapshot().provider, "fake-external-provider");
      assert.equal(session.threadOptions.model, "test-external");

      const result = await session.runTurn("hello");
      assert.equal(result.text, "external:hello");

      const usage = await session.getSessionUsageSummary();
      assert.equal(usage.sessionId, "ext-123");
      assert.match(usage.manualResume.command, /external --resume ext-123/);

      await session.close();
    });
  });

  it("supports external provider aliases", async () => {
    await withExternalProvider(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("test-external-alias", {
        cwd: process.cwd(),
        logger: { log: () => {} },
      });

      await session.readyPromise;
      assert.equal(session.getSnapshot().backend, "test-external");
      assert.equal(session.getSnapshot().provider, "fake-external-provider");

      await session.close();
    });
  });

  it("keeps a stable session object when worker mode is disabled", async () => {
    await withExternalProvider(FIXTURE_EXTERNAL_PROVIDER, async () => {
      process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER = "1";
      const session = createAiSession("test-external-alias", {
        cwd: process.cwd(),
        resumeSessionId: "local-ext-1",
        logger: { log: () => {} },
      });

      assert.equal(typeof session.then, "undefined");
      assert.equal(typeof session.runTurn, "function");
      assert.equal(typeof session.close, "function");

      const turnPromise = session.runTurn("hello");
      await session.readyPromise;
      assert.equal(session.getSnapshot().backend, "test-external");
      assert.equal(session.getSnapshot().provider, "fake-external-provider");

      const result = await turnPromise;
      assert.equal(result.text, "external:hello");

      await session.close();
    });
  });

  it("rejects unsupported backends when no external provider is configured", async () => {
    const session = createAiSession("test-external", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    await assert.rejects(() => session.readyPromise, /Set AISDK_PROVIDER_PATH to load external providers/);
  });

  it("fails when external provider module is invalid", async () => {
    await withExternalProvider(INVALID_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("broken", {
        cwd: process.cwd(),
        logger: { log: () => {} },
      });

      await assert.rejects(() => session.readyPromise, /missing provider.createSession/);
    });
  });

  it("reloads an external provider after an initial descriptor failure", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-provider-"));
    const providerPath = path.join(tempDir, "retryable-provider.js");

    await withExternalProvider(providerPath, async () => {
      fs.writeFileSync(
        providerPath,
        'export const providers = [{ backend: "retryable-external", variant: "retryable-external-provider" }];\n',
        "utf8",
      );

      const brokenSession = createAiSession("retryable-external", {
        cwd: process.cwd(),
        logger: { log: () => {} },
      });
      await assert.rejects(() => brokenSession.readyPromise, /missing provider.createSession/);

      fs.writeFileSync(
        providerPath,
        [
          "class RetryableExternalSession {",
          "  constructor(backend, options = {}) {",
          "    this.backend = backend;",
          "    this.options = options;",
          "  }",
          "  getSnapshot() {",
          "    return {",
          "      backend: this.backend,",
          '      provider: "retryable-external-provider",',
          "      sessionId: this.options.resumeSessionId || undefined,",
          "      useSessionFileReplyStream: true,",
          "    };",
          "  }",
          "  async ensureSessionInfo() {",
          "    return { backend: this.backend, sessionId: this.options.resumeSessionId || 'retryable-session-1' };",
          "  }",
          "  async getSessionUsageSummary() {",
          "    return {",
          "      sessionId: this.options.resumeSessionId || 'retryable-session-1',",
          "      sessionFilePath: undefined,",
          "      totalCostUsd: undefined,",
          "      tokenUsagePercent: undefined,",
          "      contextUsagePercent: undefined,",
          "      usage: null,",
          "      modelUsage: null,",
          "      rateLimits: null,",
          "      manualResume: {",
          "        ready: true,",
          "        command: `retryable --resume ${this.options.resumeSessionId || 'retryable-session-1'}`,",
          "      },",
          "    };",
          "  }",
          "  setSessionMessageHandler() {}",
          "  setWorkingStatusHandler() {}",
          "  setSessionReplyTarget() {}",
          "  async runTurn(promptText) {",
          "    return {",
          "      text: `retryable:${promptText}`,",
          "      usage: null,",
          "      items: [],",
          "      events: [],",
          "      provider: this.backend,",
          "      metadata: {",
          '        source: "retryable-external-provider",',
          "        sessionId: this.options.resumeSessionId || 'retryable-session-1',",
          "      },",
          "    };",
          "  }",
          "  async close() {}",
          "}",
          "export const providers = [",
          "  {",
          '    backend: "retryable-external",',
          '    variant: "retryable-external-provider",',
          "    async createSession(backend, options) {",
          "      return new RetryableExternalSession(backend, options);",
          "    },",
          "  },",
          "];",
          "",
        ].join("\n"),
        "utf8",
      );

      const recoveredSession = createAiSession("retryable-external", {
        cwd: process.cwd(),
        resumeSessionId: "retryable-session-2",
        logger: { log: () => {} },
      });
      await recoveredSession.readyPromise;
      assert.equal(recoveredSession.getSnapshot().provider, "retryable-external-provider");

      const result = await recoveredSession.runTurn("hello");
      assert.equal(result.text, "retryable:hello");

      await recoveredSession.close();
    });
  });

  it("prefers built-in backends over conflicting external declarations", async () => {
    await withExternalProvider(CONFLICTING_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("codex", {
        cwd: process.cwd(),
        logger: { log: () => {} },
      });

      await session.readyPromise;
      assert.equal(session.getSnapshot().backend, "codex");
      assert.equal(session.getSnapshot().provider, "codex-app-server");

      await session.close();
    });
  });
});
