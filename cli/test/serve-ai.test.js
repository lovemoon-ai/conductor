import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { startServeAiServer } from "../src/serve-ai/index.js";

function createTestServer(overrides = {}) {
  const calls = [];
  const sessionClosures = [];
  const serverPromise = startServeAiServer(
    {
      host: "127.0.0.1",
      port: 0,
      backend: "codex",
      apiKey: overrides.apiKey || "",
    },
    {
      loadServeAiRuntimeConfig: async () => ({
        conductorConfigPath: "/tmp/config.yaml",
        serveAiConfigPath: "/tmp/config-ai-serve.yaml",
        activeConfigPath: "/tmp/config-ai-serve.yaml",
        source: "serve-ai",
        allowCliList: {
          "kimi-local": "kimi",
        },
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
        if (backend === "kimi-local") {
          return {
            requestedBackend: backend,
            runtimeBackend: "kimi",
            commandLine: "kimi",
          };
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
  });
});
