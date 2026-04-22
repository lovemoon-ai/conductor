import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONDUCTOR_CLI = path.resolve(__dirname, "..", "bin", "conductor.js");
const SUPPORTED_BACKENDS = ["codex", "claude", "kimi"];
const RUN_REAL_AI_E2E = /^(1|true|yes)$/i.test(String(process.env.CONDUCTOR_RUN_REAL_AI_E2E || "").trim());

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function createSolidColorPngDataUrl(width, height, red, green, blue) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
    }
    rows.push(row);
  }

  const png = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const RED_SQUARE_PNG_DATA_URL = createSolidColorPngDataUrl(64, 64, 255, 0, 0);

function makeTempDir(prefix = "serve-ai-e2e-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseRequestedBackends() {
  const raw = String(process.env.CONDUCTOR_REAL_AI_E2E_BACKENDS || "").trim();
  if (!raw) {
    return [...SUPPORTED_BACKENDS];
  }
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter((value) => !SUPPORTED_BACKENDS.includes(value));
  if (invalid.length > 0) {
    throw new Error(`Unsupported CONDUCTOR_REAL_AI_E2E_BACKENDS values: ${invalid.join(", ")}`);
  }
  return [...new Set(values)];
}

function findExecutableOnPath(name) {
  const pathEntries = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const candidateNames =
    process.platform === "win32"
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];
  for (const entry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(entry, candidateName);
      try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return candidatePath;
      } catch {
        // try next candidate
      }
    }
  }
  return "";
}

function writeServeAiConfig(tempDir) {
  const configPath = path.join(tempDir, "config.yaml");
  const config = {
    serve_ai: {
      host: "127.0.0.1",
      port: 0,
      backend: "codex",
    },
    allow_cli_list: {
      codex: "codex",
      kimi: "kimi",
      claude: "claude",
    },
  };
  fs.writeFileSync(configPath, yaml.dump(config), "utf8");
  return configPath;
}

function createStartupError(message, stdout, stderr) {
  return new Error(`${message}\nstdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`);
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timeoutId);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeoutId);
      resolve();
    }
  });
}

async function startServeAiProcess(configPath) {
  const child = spawn(
    process.execPath,
    [CONDUCTOR_CLI, "serve-ai", "--config-file", configPath, "--port", "0"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(async () => {
      if (settled) {
        return;
      }
      settled = true;
      await stopChildProcess(child);
      reject(createStartupError("Timed out waiting for serve-ai to start", stdout, stderr));
    }, 10_000);

    const settle = async (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if (error) {
        await stopChildProcess(child);
        reject(error);
        return;
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/OpenAI-compatible server listening at (http:\/\/\S+)/);
      if (!match) {
        return;
      }
      void settle(null, {
        child,
        url: match[1],
        getOutput: () => ({ stdout, stderr }),
        stop: async () => {
          await stopChildProcess(child);
        },
      });
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      void settle(
        createStartupError(
          `serve-ai exited before startup (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          stdout,
          stderr,
        ),
      );
    });

    child.once("error", (error) => {
      void settle(createStartupError(`serve-ai failed to spawn: ${error.message}`, stdout, stderr));
    });
  });
}

async function postChatCompletion(serverUrl, body) {
  const response = await fetch(`${serverUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected 200 from serve-ai, got ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function parseAssistantJson(body) {
  const content = body?.choices?.[0]?.message?.content;
  assert.equal(typeof content, "string");
  return JSON.parse(content);
}

function formatImageUrlForLog(imageUrl) {
  const normalized = String(imageUrl || "");
  if (!normalized) {
    return "[image_url empty]";
  }
  if (normalized.startsWith("data:")) {
    const [header, payload = ""] = normalized.split(",", 2);
    return `[image_url ${header}, payload_length=${payload.length}]`;
  }
  return `[image_url ${normalized}]`;
}

function formatMessageContentForLog(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part?.type === "image_url") {
        if (typeof part.image_url === "string") {
          return formatImageUrlForLog(part.image_url);
        }
        return formatImageUrlForLog(part?.image_url?.url);
      }
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function formatMessagesForLog(messages) {
  return messages
    .map((message) => {
      const role = String(message?.role || "user");
      const content = formatMessageContentForLog(message?.content);
      return `${role}:\n${content}`;
    })
    .join("\n\n");
}

function logE2EResult({ scenario, backend, requestBody, responseBody }) {
  const responseText = responseBody?.choices?.[0]?.message?.content || "";
  console.log(
    [
      "",
      `=== serve-ai e2e ${scenario} | backend=${backend} ===`,
      "[prompt]",
      formatMessagesForLog(requestBody?.messages || []),
      "[response]",
      responseText,
      "=== end ===",
    ].join("\n"),
  );
}

function resolveRealE2EBackendsOrSkip(t) {
  if (!RUN_REAL_AI_E2E) {
    t.skip(
      "Set CONDUCTOR_RUN_REAL_AI_E2E=1 to run live serve-ai tests against authenticated codex/claude/kimi CLIs.",
    );
    return null;
  }
  const backends = parseRequestedBackends();
  for (const backend of backends) {
    const executablePath = findExecutableOnPath(backend);
    assert.ok(executablePath, `Expected ${backend} to be installed on PATH for real serve-ai e2e`);
  }
  return backends;
}

describe("conductor serve-ai e2e", { concurrency: false }, () => {
  it("returns structured text output for codex, claude, and kimi using real tools", async (t) => {
    const backends = resolveRealE2EBackendsOrSkip(t);
    if (!backends) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = writeServeAiConfig(tempDir);
    const server = await startServeAiProcess(configPath);
    t.after(async () => {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    for (const backend of backends) {
      const requestBody = {
        model: backend,
        messages: [
          {
            role: "system",
            content: "Return only compact JSON that satisfies the response schema.",
          },
          {
            role: "user",
            content: `Return the literal backend name "${backend}" and ok=true.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "backend_reply",
            schema: {
              type: "object",
              properties: {
                backend: { type: "string", enum: [backend] },
                ok: { type: "boolean" },
              },
              required: ["backend", "ok"],
              additionalProperties: false,
            },
          },
        },
      };
      const body = await postChatCompletion(server.url, requestBody);
      logE2EResult({
        scenario: "text",
        backend,
        requestBody,
        responseBody: body,
      });

      assert.equal(body.model, backend);
      assert.deepEqual(parseAssistantJson(body), { backend, ok: true });
    }
  });

  it("returns structured image output for codex, claude, and kimi using real tools", async (t) => {
    const backends = resolveRealE2EBackendsOrSkip(t);
    if (!backends) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = writeServeAiConfig(tempDir);
    const server = await startServeAiProcess(configPath);
    t.after(async () => {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    for (const backend of backends) {
      const requestBody = {
        model: backend,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Inspect the attached image and return JSON. The image is intended to be a solid single-color square. ` +
                  `Return backend="${backend}" and dominant_color as the common English color name.`,
              },
              {
                type: "image_url",
                image_url: {
                  url: RED_SQUARE_PNG_DATA_URL,
                },
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "image_reply",
            schema: {
              type: "object",
              properties: {
                backend: { type: "string", enum: [backend] },
                dominant_color: { type: "string", enum: ["red"] },
              },
              required: ["backend", "dominant_color"],
              additionalProperties: false,
            },
          },
        },
      };
      const body = await postChatCompletion(server.url, requestBody);
      logE2EResult({
        scenario: "image",
        backend,
        requestBody,
        responseBody: body,
      });

      assert.equal(body.model, backend);
      assert.deepEqual(parseAssistantJson(body), { backend, dominant_color: "red" });
    }
  });
});
