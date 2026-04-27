import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAiSession, RemoteAiSession } from "../src/index.js";
import { resetExternalProviderRegistryForTests } from "../src/external-provider-registry.js";
import { CodexAppServerSession } from "../src/session-factory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "fake-external-provider.js");
const INVALID_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "invalid-external-provider.js");
const CONFLICTING_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "conflicting-external-provider.js");
const tempPaths = [];

function makeTempDir(prefix = "ai-sdk-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

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

async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function startFakeRemoteAgentServer(options = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readJsonRequest(req);
      calls.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization || "",
        body,
      });

      if (req.method === "POST" && req.url === "/internal/agent/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          sessionId: "agent-remote-1",
          backend: "codex",
          snapshot: {
            backend: "codex",
            provider: "codex-app-server",
            sessionId: "thread-remote-1",
            remoteOnlySecret: "do-not-copy",
            sessionInfo: {
              backend: "codex",
              sessionId: "thread-remote-1",
              model: "gpt-remote",
              modelProvider: "codex",
            },
          },
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/internal/agent/sessions/agent-remote-1/request") {
        const result = body.method === "ensureSessionInfo"
          ? {
              backend: "codex",
              sessionId: "thread-remote-1",
              model: "gpt-remote",
              modelProvider: "codex",
            }
          : body.method === "getSessionUsageSummary"
            ? { sessionId: "thread-remote-1", usage: null }
            : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          result,
          snapshot: {
            backend: "codex",
            provider: "codex-app-server",
            sessionId: "thread-remote-1",
            remoteOnlySecret: "do-not-copy",
          },
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/internal/agent/sessions/agent-remote-1/run-turn") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        if (options.runTurnError) {
          res.write(`${JSON.stringify({
            type: "error",
            error: options.runTurnError,
          })}\n`);
          res.end();
          return;
        }
        res.write(`${JSON.stringify({
          type: "event",
          name: "working_status",
          payload: {
            phase: "remote_phase",
            status_line: "remote is working",
          },
        })}\n`);
        res.write(`${JSON.stringify({
          type: "progress",
          payload: {
            phase: "remote_progress",
            status_line: "remote progress",
          },
        })}\n`);
        res.write(`${JSON.stringify({
          type: "result",
          result: {
            text: `remote:${body.promptText}`,
            usage: null,
            sessionId: "thread-remote-1",
          },
          snapshot: {
            backend: "codex",
            provider: "codex-app-server",
            sessionId: "thread-remote-1",
            remoteOnlySecret: "do-not-copy",
          },
        })}\n`);
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    })().catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startLegacyServeAiServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "route_not_found",
        message: `route not found: ${req.method} ${req.url}`,
      },
    }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(() => {
  delete process.env.AISDK_PROVIDER_PATH;
  delete process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER;
  resetExternalProviderRegistryForTests();
  while (tempPaths.length > 0) {
    fs.rmSync(tempPaths.pop(), { recursive: true, force: true });
  }
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

  it("switches codex sessions to exec when structured output is requested", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "codex");
    assert.equal(session.getSnapshot().provider, "codex-exec");

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

  it("supports copilot sdk sessions", async () => {
    const session = createAiSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "copilot");
    assert.equal(session.getSnapshot().provider, "copilot-sdk");

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

  it("switches kimi sessions to print mode when structured output is requested", async () => {
    const session = createAiSession("kimi", {
      cwd: process.cwd(),
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "kimi");
    assert.equal(session.getSnapshot().provider, "kimi-cli-print");

    await session.close();
  });

  it("supports codex remote sessions over conductor serve-ai agent API", async (t) => {
    const remote = await startFakeRemoteAgentServer();
    let session = null;
    const logs = [];
    t.after(async () => {
      await session?.close?.().catch(() => {});
      await remote.close().catch(() => {});
    });

    session = createAiSession("codex-remote", {
      cwd: "/local/workspace",
      remoteCwd: "/remote/workspace",
      remoteBaseUrl: remote.url,
      remoteApiKey: "agent-key",
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: (message) => logs.push(message) },
    });

    assert.ok(session instanceof RemoteAiSession);
    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "codex-remote");
    assert.equal(session.getSnapshot().provider, "codex-remote");
    assert.equal(session.getSnapshot().remoteSnapshot, undefined);
    assert.equal(session.getSnapshot().remoteOnlySecret, undefined);
    assert.ok(logs.some((message) => String(message).includes("remoteCwd is ignored")));

    const workingStatuses = [];
    const progressEvents = [];
    session.setWorkingStatusHandler((payload) => {
      workingStatuses.push(payload);
    });

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.backend, "codex-remote");
    assert.equal(sessionInfo.remoteBackend, "codex");
    assert.equal(sessionInfo.sessionId, "thread-remote-1");

    const result = await session.runTurn("hello", {
      onProgress: (payload) => {
        progressEvents.push(payload);
      },
    });
    assert.equal(result.text, "remote:hello");
    assert.equal(workingStatuses[0].status_line, "remote is working");
    assert.equal(progressEvents[0].status_line, "remote progress");

    const createCall = remote.calls.find((call) => call.path === "/internal/agent/sessions");
    assert.equal(createCall.authorization, "Bearer agent-key");
    assert.equal(createCall.body.backend, "codex");
    assert.equal(createCall.body.options.cwd, undefined);
    assert.equal(createCall.body.options.outputFormat, undefined);
    assert.equal(createCall.body.options.jsonSchema, undefined);

    const runTurnCall = remote.calls.find((call) => call.path === "/internal/agent/sessions/agent-remote-1/run-turn");
    assert.equal(runTurnCall.body.options.jsonSchema.type, "object");

    await session.close();
    session = null;
  });

  it("supports claude remote sessions over conductor serve-ai agent API", async (t) => {
    const remote = await startFakeRemoteAgentServer();
    let session = null;
    t.after(async () => {
      await session?.close?.().catch(() => {});
      await remote.close().catch(() => {});
    });

    session = createAiSession("claude-remote", {
      remoteBaseUrl: remote.url,
      logger: { log: () => {} },
    });

    await session.readyPromise;
    assert.equal(session.getSnapshot().backend, "claude-remote");
    assert.equal(session.getSnapshot().provider, "claude-remote");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.backend, "claude-remote");
    assert.equal(sessionInfo.remoteBackend, "claude");

    const createCall = remote.calls.find((call) => call.path === "/internal/agent/sessions");
    assert.equal(createCall.body.backend, "claude");

    await session.close();
    session = null;
  });

  it("rethrows remote agent NDJSON errors", async (t) => {
    const remote = await startFakeRemoteAgentServer({
      runTurnError: {
        name: "Error",
        message: "agent failed",
        code: "agent_failed",
      },
    });
    let session = null;
    t.after(async () => {
      await session?.close?.().catch(() => {});
      await remote.close().catch(() => {});
    });

    session = createAiSession("codex-remote", {
      remoteBaseUrl: remote.url,
      logger: { log: () => {} },
    });

    await session.readyPromise;
    await assert.rejects(
      () => session.runTurn("hello"),
      (error) => error?.message === "agent failed" && error?.code === "agent_failed",
    );

    await session.close();
    session = null;
  });

  it("surfaces old serve-ai servers without the internal agent API", async (t) => {
    const remote = await startLegacyServeAiServer();
    let session = null;
    t.after(async () => {
      await session?.close?.().catch(() => {});
      await remote.close().catch(() => {});
    });

    session = createAiSession("codex-remote", {
      remoteBaseUrl: remote.url,
      logger: { log: () => {} },
    });

    await session.readyPromise;
    await assert.rejects(
      () => session.ensureSessionInfo(),
      /route not found: POST \/internal\/agent\/sessions|HTTP 404/,
    );
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

  it("loads external providers from comma-delimited AISDK_PROVIDER_PATH", async () => {
    await withExternalProvider(`${FIXTURE_EXTERNAL_PROVIDER},${FIXTURE_EXTERNAL_PROVIDER}`, async () => {
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

  it("loads external providers from config file AISDK_PROVIDER_PATH lists", async () => {
    const tempDir = makeTempDir("ai-sdk-config-provider-");
    const providerPath = path.join(tempDir, "yaml-list-provider.js");
    const configFile = path.join(tempDir, "config.yaml");
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;

    try {
      process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
      fs.writeFileSync(
        providerPath,
        [
          "class YamlListExternalSession {",
          "  constructor(backend, options = {}) {",
          "    this.backend = backend;",
          "    this.options = options;",
          "  }",
          "  getSnapshot() {",
          "    return {",
          "      backend: this.backend,",
          '      provider: "yaml-list-external-provider",',
          "      sessionId: this.options.resumeSessionId || undefined,",
          "      useSessionFileReplyStream: true,",
          "    };",
          "  }",
          "  async ensureSessionInfo() {",
          "    return { backend: this.backend, sessionId: this.options.resumeSessionId || 'yaml-list-session-1' };",
          "  }",
          "  async getSessionUsageSummary() {",
          "    return {",
          "      sessionId: this.options.resumeSessionId || 'yaml-list-session-1',",
          "      sessionFilePath: undefined,",
          "      usage: null,",
          "      rateLimits: null,",
          "      manualResume: {",
          "        ready: true,",
          "        command: `yaml-list --resume ${this.options.resumeSessionId || 'yaml-list-session-1'}`,",
          "      },",
          "    };",
          "  }",
          "  setSessionMessageHandler() {}",
          "  setWorkingStatusHandler() {}",
          "  setSessionReplyTarget() {}",
          "  async runTurn(promptText) {",
          "    return {",
          "      text: `yaml-list:${promptText}`,",
          "      usage: null,",
          "      items: [],",
          "      events: [],",
          "      provider: this.backend,",
          "      metadata: {",
          '        source: "yaml-list-external-provider",',
          "        sessionId: this.options.resumeSessionId || 'yaml-list-session-1',",
          "      },",
          "    };",
          "  }",
          "  async close() {}",
          "}",
          "export const providers = [",
          "  {",
          '    backend: "yaml-list-external",',
          '    aliases: ["yaml-list-alias"],',
          '    variant: "yaml-list-external-provider",',
          "    async createSession(backend, options) {",
          "      return new YamlListExternalSession(backend, options);",
          "    },",
          "  },",
          "];",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        configFile,
        [
          "envs:",
          "  AISDK_PROVIDER_PATH:",
          `    - ${JSON.stringify(providerPath)}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const primary = createAiSession("test-external", {
        cwd: process.cwd(),
        configFile,
        resumeSessionId: "ext-yaml-1",
        logger: { log: () => {} },
      });
      await primary.readyPromise;
      assert.equal(primary.getSnapshot().provider, "fake-external-provider");

      const secondary = createAiSession("yaml-list-alias", {
        cwd: process.cwd(),
        configFile,
        resumeSessionId: "yaml-list-2",
        logger: { log: () => {} },
      });
      await secondary.readyPromise;
      assert.equal(secondary.getSnapshot().backend, "yaml-list-external");
      assert.equal(secondary.getSnapshot().provider, "yaml-list-external-provider");

      const result = await secondary.runTurn("hello");
      assert.equal(result.text, "yaml-list:hello");

      await primary.close();
      await secondary.close();
    } finally {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetExternalProviderRegistryForTests();
    }
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

  it("keeps a stable session object when disableWorker is requested explicitly", async () => {
    await withExternalProvider(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("test-external-alias", {
        cwd: process.cwd(),
        disableWorker: true,
        logger: { log: () => {} },
      });

      assert.equal(typeof session.then, "undefined");
      assert.equal(typeof session.runTurn, "function");
      await session.readyPromise;
      assert.equal(session.getSnapshot().backend, "test-external");

      await session.close();
    });
  });

  it("interrupts a worker-backed turn through the control lane", async () => {
    await withExternalProvider(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const session = createAiSession("test-external-alias", {
        cwd: process.cwd(),
        logger: { log: () => {} },
      });

      await session.readyPromise;
      const turnPromise = session.runTurn("hello [wait-for-interrupt]");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await session.interruptCurrentTurn();

      await assert.rejects(
        () => turnPromise,
        (error) => error?.reason === "turn_interrupted",
      );

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
