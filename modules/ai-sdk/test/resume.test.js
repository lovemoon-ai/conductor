import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildResumeArgsForBackend,
  findSessionPath,
  resolveResumeContext,
  resolveSessionRunDirectory,
  resumeProviderForBackend,
} from "../src/resume/index.js";
import { findSessionPath as findSessionPathViaIndex } from "../src/index.js";
import { resetExternalProviderRegistryForTests } from "../src/external-provider-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "fake-external-provider.js");
const FIXTURE_RESUME_CAPABLE_PROVIDER = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "fake-resume-capable-provider.js",
);

async function withClearedProviderEnv(fn) {
  const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
  delete process.env.AISDK_PROVIDER_PATH;
  resetExternalProviderRegistryForTests();
  try {
    return await fn();
  } finally {
    resetExternalProviderRegistryForTests();
    if (previousProviderPath === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previousProviderPath;
    }
  }
}

function createCopilotResumeSdkModule({ sessions = [], listSessions = null, stopError = null } = {}) {
  const state = {
    startCalls: 0,
    stopCalls: 0,
    forceStopCalls: 0,
    listSessionsCalls: 0,
    clientOptions: [],
  };

  class FakeCopilotClient {
    constructor(options = {}) {
      state.clientOptions.push(options);
    }

    async start() {
      state.startCalls += 1;
    }

    async stop() {
      state.stopCalls += 1;
      if (stopError) {
        throw stopError;
      }
      return [];
    }

    async forceStop() {
      state.forceStopCalls += 1;
    }

    async listSessions() {
      state.listSessionsCalls += 1;
      if (typeof listSessions === "function") {
        return await listSessions();
      }
      return sessions;
    }
  }

  return { sdkModule: { CopilotClient: FakeCopilotClient }, state };
}

describe("ai-sdk resume API", () => {
  it("guarantees every built-in backend has a resume module", async () => {
    const { BUILT_IN_BACKENDS } = await import("../src/built-in-backends.js");
    for (const entry of BUILT_IN_BACKENDS) {
      const provider = resumeProviderForBackend(entry.backend);
      assert.equal(
        provider,
        entry.backend,
        `built-in backend "${entry.backend}" must have a registered resume module`,
      );
      // Calling buildResumeArgsForBackend on each backend must not throw,
      // proving every built-in provider participates in resume dispatch.
      const args = buildResumeArgsForBackend(entry.backend, "sanity-check");
      assert.ok(Array.isArray(args) && args.length > 0);
    }
  });

  it("maps backend name to resume provider", () => {
    assert.equal(resumeProviderForBackend("codex"), "codex");
    assert.equal(resumeProviderForBackend("code"), "codex");
    assert.equal(resumeProviderForBackend("claude"), "claude");
    assert.equal(resumeProviderForBackend("claude-code"), "claude");
    assert.equal(resumeProviderForBackend("copilot"), "copilot");
    assert.equal(resumeProviderForBackend("kimi"), "kimi");
    assert.equal(resumeProviderForBackend("kimi-cli"), "kimi");
    assert.equal(resumeProviderForBackend("opencode"), "opencode");
    assert.equal(resumeProviderForBackend("open-code"), "opencode");
    assert.equal(resumeProviderForBackend("unknown"), null);
  });

  it("builds resume CLI args per backend", () => {
    assert.deepEqual(buildResumeArgsForBackend("codex", "abc"), ["resume", "abc"]);
    assert.deepEqual(buildResumeArgsForBackend("code", "abc"), ["resume", "abc"]);
    assert.deepEqual(buildResumeArgsForBackend("claude", "abc"), ["--resume", "abc"]);
    assert.deepEqual(buildResumeArgsForBackend("copilot", "abc"), ["--resume=abc"]);
    assert.deepEqual(buildResumeArgsForBackend("kimi", "abc"), ["--session", "abc"]);
    assert.deepEqual(buildResumeArgsForBackend("opencode", "abc"), ["--session", "abc"]);
    assert.deepEqual(buildResumeArgsForBackend("codex", ""), []);
    assert.throws(() => buildResumeArgsForBackend("nope", "abc"), /not supported/);
  });

  it("finds codex session path from ~/.codex/sessions and dispatches via findSessionPath", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const sessionId = "019cb2a4-de18-70b0-816b-a9b0d99400bb";
    const codexDir = path.join(tmpRoot, ".codex", "sessions", "2026", "03");
    await fsp.mkdir(codexDir, { recursive: true });
    const filePath = path.join(codexDir, `session-${sessionId}.jsonl`);
    await fsp.writeFile(filePath, "", "utf8");

    assert.equal(await findSessionPath("codex", sessionId, { homeDir: tmpRoot }), filePath);
    assert.equal(await findSessionPathViaIndex("codex", sessionId, { homeDir: tmpRoot }), filePath);
    await assert.rejects(
      () => findSessionPath("unknown-provider", "abc", { homeDir: tmpRoot }),
      /Unsupported provider/,
    );
  });

  it("finds claude session path from project history and tasks fallback", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const projectDir = path.join(tmpRoot, ".claude", "projects", "demo-project");
    await fsp.mkdir(projectDir, { recursive: true });
    const historyPath = path.join(projectDir, "history.jsonl");
    const projectSessionId = "9c761ab9-e360-4488-af51-dd7788a22cdb";
    await fsp.writeFile(
      historyPath,
      `${JSON.stringify({
        sessionId: projectSessionId,
        timestamp: 1,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
      "utf8",
    );

    const taskSessionId = "1485b57d-cc3d-4361-b0e1-54c982f4d381";
    const taskDir = path.join(tmpRoot, ".claude", "tasks", taskSessionId);
    await fsp.mkdir(taskDir, { recursive: true });
    await fsp.writeFile(path.join(taskDir, "1.json"), "{}", "utf8");

    assert.equal(await findSessionPath("claude", projectSessionId, { homeDir: tmpRoot }), historyPath);
    assert.equal(await findSessionPath("claude", taskSessionId, { homeDir: tmpRoot }), taskDir);
  });

  it("finds kimi session path from hashed ~/.kimi/sessions directories", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const workspaceDir = path.join(tmpRoot, "workspace-kimi");
    const sessionId = "kimi-session-42";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tmpRoot, ".kimi", "sessions", workspaceHash, sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    assert.equal(await findSessionPath("kimi", sessionId, { homeDir: tmpRoot }), sessionDir);
  });

  it("resolves session run directory from file and directory paths", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const fileDir = path.join(tempDir, "nested");
    fs.mkdirSync(fileDir, { recursive: true });
    const filePath = path.join(fileDir, "session-1.jsonl");
    fs.writeFileSync(filePath, "", "utf8");

    assert.equal(await resolveSessionRunDirectory(filePath), fileDir);
    assert.equal(await resolveSessionRunDirectory(fileDir), fileDir);
  });

  it("resolves codex resume context with cwd from session metadata", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const sessionId = "019cb2a4-de18-70b0-816b-a9b0d99400bb";
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "03");
    const workspaceDir = path.join(tempDir, "workspace-codex");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFilePath = path.join(sessionsDir, `session-${sessionId}.jsonl`);
    fs.writeFileSync(
      sessionFilePath,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: workspaceDir },
      })}\n`,
      "utf8",
    );

    const resolved = await resolveResumeContext("codex", sessionId, { homeDir: tempDir });
    assert.equal(resolved.provider, "codex");
    assert.equal(resolved.sessionPath, sessionFilePath);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "session");

    await assert.rejects(
      () => resolveResumeContext("codex", "missing-session-id", { homeDir: tempDir }),
      /Invalid --resume session id/,
    );
  });

  it("resolves claude resume context with cwd from message entries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const sessionId = "9c761ab9-e360-4488-af51-dd7788a22cdb";
    const workspaceDir = path.join(tempDir, "workspace-claude");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const projectDir = path.join(tempDir, ".claude", "projects", "demo-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionFilePath = path.join(projectDir, "history.jsonl");
    fs.writeFileSync(
      sessionFilePath,
      `${JSON.stringify({
        sessionId,
        cwd: workspaceDir,
        message: { role: "user", content: "hello" },
      })}\n`,
      "utf8",
    );

    const resolved = await resolveResumeContext("claude", sessionId, { homeDir: tempDir });
    assert.equal(resolved.provider, "claude");
    assert.equal(resolved.sessionPath, sessionFilePath);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "session");
  });

  it("resolves copilot resume context via the Copilot SDK", async () => {
    const sessionId = "38395aba-10fe-4a9e-863e-c7ed750e0809";
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-copilot-"));
    const harness = createCopilotResumeSdkModule({
      sessions: [
        {
          sessionId,
          context: { cwd: workspaceDir, repository: "owner/repo" },
        },
      ],
    });

    const resolved = await resolveResumeContext("copilot", sessionId, {
      copilotSdkModule: harness.sdkModule,
      commandLine: "copilot --allow-all-paths --allow-all-tools --trace",
      env: { PATH: "" },
    });
    assert.equal(resolved.provider, "copilot");
    assert.equal(resolved.sessionPath, null);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "sdk_list_sessions");
    assert.equal(harness.state.startCalls, 1);
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.clientOptions[0]?.cliPath, undefined);
    assert.deepEqual(harness.state.clientOptions[0]?.cliArgs, ["--trace"]);
  });

  it("times out Copilot resume SDK lookup and force-stops on cleanup failure", async () => {
    const harness = createCopilotResumeSdkModule({
      listSessions: () => new Promise(() => {}),
      stopError: new Error("stop failed"),
    });

    await assert.rejects(
      () => resolveResumeContext("copilot", "copilot-session-hangs", {
        copilotSdkModule: harness.sdkModule,
        copilotResumeTimeoutMs: 10,
      }),
      /copilot resume lookup timed out/,
    );

    assert.equal(harness.state.startCalls, 1);
    assert.equal(harness.state.listSessionsCalls, 1);
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.forceStopCalls, 1);
  });

  it("resolves kimi resume context from the current working directory hash", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const workspaceDir = path.join(tempDir, "workspace-kimi");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const sessionId = "kimi-session-current-cwd";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tempDir, ".kimi", "sessions", workspaceHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    const resolved = await resolveResumeContext("kimi", sessionId, {
      homeDir: tempDir,
      cwd: workspaceDir,
    });
    assert.equal(resolved.provider, "kimi");
    assert.equal(resolved.sessionPath, sessionDir);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "session");
  });

  it("resolves kimi resume context via lookupWorkspaceByHash callback", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const workspaceDir = path.join(tempDir, "workspace-kimi-store");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const sessionId = "kimi-session-from-store";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tempDir, ".kimi", "sessions", workspaceHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    const resolved = await resolveResumeContext("kimi", sessionId, {
      homeDir: tempDir,
      cwd: path.join(tempDir, "elsewhere"),
      lookupWorkspaceByHash: async (hash) => (hash === workspaceHash ? workspaceDir : null),
    });
    assert.equal(resolved.provider, "kimi");
    assert.equal(resolved.sessionPath, sessionDir);
    assert.equal(resolved.cwd, workspaceDir);
  });

  it("rejects kimi resume when the workspace cannot be reconstructed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
    const workspaceDir = path.join(tempDir, "workspace-kimi-missing");
    const sessionId = "kimi-session-missing-workspace";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tempDir, ".kimi", "sessions", workspaceHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    await assert.rejects(
      () =>
        resolveResumeContext("kimi", sessionId, {
          homeDir: tempDir,
          cwd: path.join(tempDir, "different-workspace"),
        }),
      /Could not resolve workspace for Kimi session/,
    );
  });

  it("resolves opencode resume context from the provided cwd", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-opencode-"));
    const sessionId = "opencode-session-1";

    const resolved = await resolveResumeContext("opencode", sessionId, { cwd: tempDir });
    assert.equal(resolved.provider, "opencode");
    assert.equal(resolved.sessionPath, null);
    assert.equal(resolved.cwd, tempDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "options_cwd");
  });

  it("rejects opencode resume when the explicit cwd is missing", async () => {
    await assert.rejects(
      () =>
        resolveResumeContext("opencode", "opencode-missing", {
          cwd: "/this/path/does/not/exist/for/sure",
        }),
      /Resume workspace path does not exist/,
    );
  });

  it("returns unsupported for external providers without resolveResumeContext", async () => {
    await withClearedProviderEnv(async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-"));
      process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;

      await assert.rejects(
        () => resolveResumeContext("test-external", "ext-1", { homeDir: tempDir }),
        /not supported/,
      );
    });
  });

  it("routes to external providers that expose resolveResumeContext (including via alias)", async () => {
    await withClearedProviderEnv(async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-resume-external-"));
      process.env.AISDK_PROVIDER_PATH = FIXTURE_RESUME_CAPABLE_PROVIDER;

      const resolved = await resolveResumeContext("resume-capable-external", "ext-rc-1", {
        cwd: tempDir,
      });
      assert.equal(resolved.provider, "resume-capable-external");
      assert.equal(resolved.sessionId, "ext-rc-1");
      assert.equal(resolved.cwd, tempDir);
      assert.equal(resolved.debugMetadata?.cwdSource, "fake-resume-capable-provider");

      const viaAlias = await resolveResumeContext("resume-capable-alias", "ext-rc-2", {
        cwd: tempDir,
      });
      assert.equal(viaAlias.provider, "resume-capable-external");
      assert.equal(viaAlias.sessionId, "ext-rc-2");
      assert.equal(viaAlias.cwd, tempDir);
    });
  });
});
