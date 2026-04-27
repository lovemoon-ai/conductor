import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { startServeAiServer } from "../src/serve-ai/index.js";

function createTestServer(overrides = {}) {
  const calls = [];
  const sessionClosures = [];
  const effectiveAllowCliList = overrides.allowCliList || {
    codex: "codex",
    claude: "claude",
    "kimi-local": "kimi",
  };
  const serverPromise = startServeAiServer(
    {
      host: "127.0.0.1",
      port: 0,
      backend: "codex",
      apiKey: overrides.apiKey || "",
      ...(overrides.options || {}),
    },
    {
      loadServeAiRuntimeConfig: async () => ({
        conductorConfigPath: "/tmp/config.yaml",
        serveAiConfigPath: "/tmp/config-ai-serve.yaml",
        activeConfigPath: "/tmp/config-ai-serve.yaml",
        source: "serve-ai",
        allowCliList: effectiveAllowCliList,
        envs: {
          TEST_ENV_FLAG: "1",
        },
        defaults: {
          backend: "codex",
        },
      }),
      listAdvertisedBackends: async () => ({
        supportedBackends: ["codex", "kimi-local"],
      }),
      normalizeRuntimeBackendAlias: async (backend) => {
        if (backend === "kimi-local") {
          return "kimi";
        }
        return backend;
      },
      resolveConfiguredRuntimeBackend: async (backend) => {
        if (!Object.prototype.hasOwnProperty.call(effectiveAllowCliList, backend)) {
          return null;
        }
        if (backend === "codex" || backend === "claude") {
          return {
            requestedBackend: backend,
            runtimeBackend: backend,
            commandLine: backend,
          };
        }
        if (backend === "kimi-local") {
          return {
            requestedBackend: backend,
            runtimeBackend: "kimi",
            commandLine: "kimi",
          };
        }
        if (typeof overrides.resolveConfiguredRuntimeBackend === "function") {
          return overrides.resolveConfiguredRuntimeBackend(backend);
        }
        return null;
      },
      isRuntimeSupportedBackend: async (backend) => backend === "codex" || backend === "kimi",
      resolveAiSessionCommandLine: (backend) => (backend === "kimi-local" ? "kimi" : ""),
      resolveAiSessionOptions: () => ({}),
      createAiSession: (backend, options) => {
        const call = {
          backend,
          options,
          runTurnCalls: [],
        };
        calls.push(call);
        return {
          runTurn: async (promptText, runOptions) => {
            call.runTurnCalls.push({ promptText, runOptions });
            if (typeof overrides.onRunTurn === "function") {
              return overrides.onRunTurn({ backend, options, promptText, runOptions, call });
            }
            return {
              text: "OK from serve-ai",
              usage: {
                input_tokens: 11,
                output_tokens: 7,
                total_tokens: 18,
              },
            };
          },
          close: async () => {
            sessionClosures.push(call);
          },
        };
      },
      logger: {
        log: () => {},
        error: () => {},
      },
      ...overrides.deps,
    },
  );

  return serverPromise.then((server) => {
    return {
      server,
      calls,
      sessionClosures,
    };
  });
}

function postJson(urlString, payload) {
  const targetUrl = new URL(urlString);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

describe("serve-ai", { concurrency: false }, () => {
  it("lists advertised models", async (t) => {
    const { server } = await createTestServer();
    t.after(async () => {
      await server.close().catch(() => {});
    });
    const response = await fetch(`${server.url}/v1/models`);

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "list");
    assert.deepEqual(
      body.data.map((item) => item.id),
      ["codex", "kimi-local"],
    );
  });

  it("maps chat completions requests into ai-sdk sessions with structured output", async (t) => {
    const { server, calls, sessionClosures } = await createTestServer({
      onRunTurn: () => ({
        text: "{\"ok\":true}",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      }),
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-local",
        messages: [
          {
            role: "system",
            content: "Return a JSON object.",
          },
          {
            role: "user",
            content: "Say hi",
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reply",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "kimi-local");
    assert.equal(body.choices[0].message.content, "{\"ok\":true}");
    assert.deepEqual(body.usage, {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].backend, "kimi");
    assert.equal(calls[0].options.commandLine, "kimi");
    assert.equal(calls[0].options.env.TEST_ENV_FLAG, "1");
    assert.equal(calls[0].options.structuredOutput, true);
    assert.equal(calls[0].options.outputFormat.type, "json_schema");
    assert.equal(calls[0].options.initialHistory.length, 1);
    assert.match(calls[0].options.initialHistory[0].content, /\[System\]/);
    assert.equal(calls[0].runTurnCalls.length, 1);
    assert.equal(calls[0].runTurnCalls[0].promptText, "Say hi");
    assert.equal(calls[0].runTurnCalls[0].runOptions.jsonSchema.type, "object");
    assert.equal(sessionClosures.length, 1);
  });

  it("normalizes backend structured output from metadata", async (t) => {
    const { server } = await createTestServer({
      onRunTurn: () => ({
        text: "",
        metadata: {
          structuredOutput: {
            ok: true,
          },
        },
      }),
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "Say hi" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reply",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "{\"ok\":true}");
  });

  it("normalizes structured output wrapped in prose or code fences", async (t) => {
    const responses = [
      'Inspecting the image now {"ok":true}',
      "```json\n{\"ok\":true}\n```",
    ];
    const { server } = await createTestServer({
      onRunTurn: () => ({
        text: responses.shift() || "{\"ok\":true}",
        usage: null,
      }),
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codex",
          messages: [{ role: "user", content: "Say hi" }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "reply",
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.choices[0].message.content, "{\"ok\":true}");
    }
  });

  it("materializes image inputs and cleans them up after the turn", async (t) => {
    let observedImagePath = "";
    const { server, calls } = await createTestServer({
      onRunTurn: ({ options, runOptions }) => {
        observedImagePath = options.initialImages[0];
        assert.equal(runOptions.useInitialImages, true);
        assert.equal(fs.existsSync(observedImagePath), true);
        return {
          text: "image ok",
          usage: null,
        };
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe it" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmh0AAAAASUVORK5CYII=" } },
            ],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "image ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.ignoreCodexApiKey, true);
    assert.equal(calls[0].options.initialImages.length, 1);
    for (let attempt = 0; attempt < 10 && fs.existsSync(observedImagePath); attempt += 1) {
      await delay(10);
    }
    assert.equal(fs.existsSync(observedImagePath), false);
  });

  it("rejects unsupported stream requests", async (t) => {
    const { server } = await createTestServer();
    t.after(async () => {
      await server.close().catch(() => {});
    });
    const response = await postJson(`${server.url}/v1/chat/completions`, {
        model: "codex",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.error.code, "unsupported_stream");
  });

  it("enforces bearer auth when api key is configured", async (t) => {
    const { server } = await createTestServer({
      apiKey: "local-dev-key",
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const unauthorized = await fetch(`${server.url}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${server.url}/v1/models`, {
      headers: {
        authorization: "Bearer local-dev-key",
      },
    });
    assert.equal(authorized.status, 200);

    const unauthorizedAgent = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(unauthorizedAgent.status, 401);
  });

  it("serves internal agent sessions for remote ai-sdk providers", async (t) => {
    const agentCalls = [];
    const { server } = await createTestServer({
      deps: {
        createAgentSession: (backend, options) => {
          const session = new EventEmitter();
          agentCalls.push({ backend, options, replyTargets: [], runTurnCalls: [] });
          const call = agentCalls.at(-1);
          session.getSnapshot = () => ({
            backend,
            provider: `${backend}-provider`,
            sessionId: "thread-agent-1",
            sessionInfo: session.getSessionInfo(),
          });
          session.getSessionInfo = () => ({
            backend,
            sessionId: "thread-agent-1",
            model: "agent-model",
          });
          session.ensureSessionInfo = async () => session.getSessionInfo();
          session.getSessionUsageSummary = async () => ({ sessionId: "thread-agent-1", usage: null });
          session.getCurrentTurnStatus = () => ({ status_line: "agent current" });
          session.usesSessionFileReplyStream = () => true;
          session.setSessionReplyTarget = (replyTarget) => {
            call.replyTargets.push(replyTarget);
          };
          session.interruptCurrentTurn = async () => true;
          session.runTurn = async (promptText, runOptions) => {
            call.runTurnCalls.push({ promptText, runOptions });
            session.emit("working_status", {
              status_line: "agent is working",
            });
            runOptions.onProgress?.({
              status_line: "agent progress",
            });
            return {
              text: `agent:${promptText}`,
              usage: null,
              sessionId: "thread-agent-1",
            };
          };
          session.close = async () => {
            call.closed = true;
          };
          return session;
        },
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const createResponse = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        backend: "codex",
        options: {
          cwd: "/remote/project",
          allowedTools: ["Bash"],
          permissionMode: "bypassPermissions",
          model: "agent-model-override",
          resumeSessionId: "thread-agent-0",
          outputFormat: { type: "json_schema", schema: { type: "object" } },
        },
      }),
    });

    assert.equal(createResponse.status, 200);
    const createBody = await createResponse.json();
    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0].backend, "codex");
    assert.equal(agentCalls[0].options.cwd, process.cwd());
    assert.equal(agentCalls[0].options.ignoreCodexApiKey, true);
    assert.equal(agentCalls[0].options.model, "agent-model-override");
    assert.equal(agentCalls[0].options.resumeSessionId, "thread-agent-0");
    assert.equal(agentCalls[0].options.allowedTools, undefined);
    assert.equal(agentCalls[0].options.permissionMode, undefined);
    assert.equal(agentCalls[0].options.outputFormat, undefined);
    assert.equal(agentCalls[0].options.env.TEST_ENV_FLAG, "1");

    const replyResponse = await fetch(`${server.url}/internal/agent/sessions/${createBody.sessionId}/request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "setSessionReplyTarget",
        args: ["reply-agent-1"],
      }),
    });
    assert.equal(replyResponse.status, 200);
    assert.deepEqual(agentCalls[0].replyTargets, ["reply-agent-1"]);

    const runResponse = await fetch(`${server.url}/internal/agent/sessions/${createBody.sessionId}/run-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        promptText: "hello",
        options: {
          jsonSchema: { type: "object" },
        },
      }),
    });
    assert.equal(runResponse.status, 200);
    const lines = (await runResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "event");
    assert.equal(lines[0].name, "working_status");
    assert.equal(lines[1].type, "progress");
    assert.equal(lines[2].type, "result");
    assert.equal(lines[2].result.text, "agent:hello");
    assert.deepEqual(agentCalls[0].runTurnCalls[0].runOptions.jsonSchema, { type: "object" });

    const closeResponse = await fetch(`${server.url}/internal/agent/sessions/${createBody.sessionId}/request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "close",
        args: [],
      }),
    });
    assert.equal(closeResponse.status, 200);
    assert.equal(agentCalls[0].closed, true);
  });

  it("rejects internal agent backends that are not allow-listed", async (t) => {
    const { server, calls } = await createTestServer({
      allowCliList: {
        kimi: "kimi",
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const response = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        backend: "codex",
      }),
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "model_not_found");
    assert.equal(calls.length, 0);
  });

  it("rejects unsupported internal agent backend names", async (t) => {
    const { server, calls } = await createTestServer();
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const response = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        backend: "kimi",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "unsupported_agent_backend");
    assert.equal(calls.length, 0);
  });

  it("creates internal agent sessions without ai-sdk worker subprocesses", async (t) => {
    const previousWorkerFlag = process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER;
    delete process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER;
    t.after(() => {
      if (previousWorkerFlag === undefined) {
        delete process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER;
      } else {
        process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER = previousWorkerFlag;
      }
    });
    let observedDisableWorker = false;
    let observedWorkerFlag = "";
    const { server } = await createTestServer({
      deps: {
        createAiSession: (_backend, options) => {
          observedDisableWorker = options.disableWorker === true;
          observedWorkerFlag = process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER || "";
          return {
            getSnapshot: () => ({ backend: "codex", provider: "codex-provider" }),
            getSessionInfo: () => null,
            close: async () => {},
          };
        },
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const response = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });

    assert.equal(response.status, 200);
    assert.equal(observedDisableWorker, true);
    assert.equal(observedWorkerFlag, "");
  });

  it("streams internal agent errors without stack traces", async (t) => {
    const { server } = await createTestServer({
      deps: {
        createAgentSession: () => {
          const session = new EventEmitter();
          session.runTurn = async () => {
            const error = new Error("agent failed");
            error.code = "agent_failed";
            throw error;
          };
          session.close = async () => {};
          return session;
        },
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const createResponse = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    const { sessionId } = await createResponse.json();

    const runResponse = await fetch(`${server.url}/internal/agent/sessions/${sessionId}/run-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ promptText: "hello" }),
    });

    assert.equal(runResponse.status, 200);
    const lines = (await runResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "error");
    assert.equal(lines[0].error.message, "agent failed");
    assert.equal(lines[0].error.code, "agent_failed");
    assert.equal(lines[0].error.stack, undefined);
  });

  it("enforces internal agent session caps and reaps idle sessions", async (t) => {
    let now = 1000;
    const { server, calls, sessionClosures } = await createTestServer({
      options: {
        agentSessionMaxCount: 1,
        agentSessionIdleTtlMs: 1,
        agentSessionSweepIntervalMs: 60_000,
      },
      deps: {
        now: () => now,
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const first = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(first.status, 200);
    assert.equal(calls.length, 1);

    const blocked = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(calls.length, 1);

    now += 2;
    const second = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(sessionClosures.length, 1);
  });

  it("reserves internal agent session slots during concurrent creates", async (t) => {
    const { server, calls } = await createTestServer({
      options: {
        agentSessionMaxCount: 1,
        agentSessionIdleTtlMs: 60_000,
        agentSessionSweepIntervalMs: 60_000,
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${server.url}/internal/agent/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ backend: "codex" }),
        }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.equal(statuses.filter((status) => status === 429).length, 7);
    assert.equal(calls.length, 1);
  });

  it("closes an internal agent session when a run-turn client disconnects", async (t) => {
    let createdSessionId = "";
    let resolveRunStarted = null;
    const runStarted = new Promise((resolve) => {
      resolveRunStarted = resolve;
    });
    let closed = false;
    let interrupted = false;
    let resolveClosed = null;
    const sessionClosed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    let resolveRunTurn = null;
    const { server } = await createTestServer({
      deps: {
        createAgentSession: () => {
          const session = new EventEmitter();
          session.runTurn = async () => {
            resolveRunStarted();
            session.emit("working_status", { status_line: "agent is working" });
            return await new Promise((resolve) => {
              resolveRunTurn = resolve;
            });
          };
          session.close = async () => {
            closed = true;
            resolveRunTurn?.({ text: "closed", usage: null });
            resolveClosed();
          };
          session.interruptCurrentTurn = async () => {
            interrupted = true;
          };
          return session;
        },
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const createResponse = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(createResponse.status, 200);
    createdSessionId = (await createResponse.json()).sessionId;

    await new Promise((resolve, reject) => {
      const targetUrl = new URL(`${server.url}/internal/agent/sessions/${createdSessionId}/run-turn`);
      const body = JSON.stringify({ promptText: "hello" });
      const req = http.request(
        {
          method: "POST",
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.once("error", (error) => {
        if (error.code === "ECONNRESET") {
          resolve();
          return;
        }
        reject(error);
      });
      req.end(body);
    });

    await runStarted;
    await Promise.race([
      sessionClosed,
      delay(1000).then(() => {
        throw new Error("timed out waiting for disconnected agent session to close");
      }),
    ]);
    assert.equal(interrupted, true);
    assert.equal(closed, true);
  });

  it("closes a disconnected agent session even when interrupt hangs", async (t) => {
    let createdSessionId = "";
    let resolveRunStarted = null;
    const runStarted = new Promise((resolve) => {
      resolveRunStarted = resolve;
    });
    let closed = false;
    let interrupted = false;
    let resolveClosed = null;
    const sessionClosed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    let resolveRunTurn = null;
    const { server } = await createTestServer({
      options: {
        agentSessionInterruptTimeoutMs: 5,
      },
      deps: {
        createAgentSession: () => {
          const session = new EventEmitter();
          session.runTurn = async () => {
            resolveRunStarted();
            session.emit("working_status", { status_line: "agent is working" });
            return await new Promise((resolve) => {
              resolveRunTurn = resolve;
            });
          };
          session.close = async () => {
            closed = true;
            resolveRunTurn?.({ text: "closed", usage: null });
            resolveClosed();
          };
          session.interruptCurrentTurn = async () => {
            interrupted = true;
            return await new Promise(() => {});
          };
          return session;
        },
      },
    });
    t.after(async () => {
      await server.close().catch(() => {});
    });

    const createResponse = await fetch(`${server.url}/internal/agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "codex" }),
    });
    assert.equal(createResponse.status, 200);
    createdSessionId = (await createResponse.json()).sessionId;

    await new Promise((resolve, reject) => {
      const targetUrl = new URL(`${server.url}/internal/agent/sessions/${createdSessionId}/run-turn`);
      const body = JSON.stringify({ promptText: "hello" });
      const req = http.request(
        {
          method: "POST",
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.once("error", (error) => {
        if (error.code === "ECONNRESET") {
          resolve();
          return;
        }
        reject(error);
      });
      req.end(body);
    });

    await runStarted;
    await Promise.race([
      sessionClosed,
      delay(1000).then(() => {
        throw new Error("timed out waiting for hung-interrupt agent session to close");
      }),
    ]);
    assert.equal(interrupted, true);
    assert.equal(closed, true);
  });
});
