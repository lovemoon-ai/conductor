import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findClaudeSessionPath,
  findCodexSessionPath,
  findCopilotSessionPath,
  findKimiSessionPath,
  findSessionPath,
  resolveResumeContext,
  resolveSessionRunDirectory,
  resumeProviderForBackend,
} from "../src/fire/resume.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-external-provider.js",
);

async function withClearedProviderEnv(fn) {
  const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
  delete process.env.AISDK_PROVIDER_PATH;
  try {
    return await fn();
  } finally {
    if (previousProviderPath === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previousProviderPath;
    }
  }
}

describe("fire resume resolver", () => {
  it("maps backend name to resume provider", () => {
    assert.equal(resumeProviderForBackend("codex"), "codex");
    assert.equal(resumeProviderForBackend("code"), "codex");
    assert.equal(resumeProviderForBackend("claude"), "claude");
    assert.equal(resumeProviderForBackend("claude-code"), "claude");
    assert.equal(resumeProviderForBackend("copilot"), "copilot");
    assert.equal(resumeProviderForBackend("kimi"), "kimi");
    assert.equal(resumeProviderForBackend("kimi-cli"), "kimi");
    assert.equal(resumeProviderForBackend("unknown"), null);
  });

  it("finds codex session path from ~/.codex/sessions", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fire-resume-"));
    const sessionId = "019cb2a4-de18-70b0-816b-a9b0d99400bb";
    const codexDir = path.join(tmpRoot, ".codex", "sessions", "2026", "03");
    await fsp.mkdir(codexDir, { recursive: true });
    const filePath = path.join(codexDir, `session-${sessionId}.jsonl`);
    await fsp.writeFile(filePath, "", "utf8");

    const resolved = await findCodexSessionPath(sessionId, { homeDir: tmpRoot });
    assert.equal(resolved, filePath);
  });

  it("finds claude session path from project history and tasks fallback", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fire-resume-"));

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

    assert.equal(await findClaudeSessionPath(projectSessionId, { homeDir: tmpRoot }), historyPath);
    assert.equal(await findClaudeSessionPath(taskSessionId, { homeDir: tmpRoot }), taskDir);
  });

  it("finds copilot session path from session-state file and directory", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fire-resume-"));
    const stateDir = path.join(tmpRoot, ".copilot", "session-state");
    await fsp.mkdir(stateDir, { recursive: true });

    const fileSessionId = "38395aba-10fe-4a9e-863e-c7ed750e0809";
    const filePath = path.join(stateDir, `${fileSessionId}.jsonl`);
    await fsp.writeFile(filePath, "", "utf8");

    const dirSessionId = "ff9c50e7-3bc9-4cb1-8271-bc0e2afcad6b";
    const sessionDir = path.join(stateDir, dirSessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(path.join(sessionDir, "events.jsonl"), "", "utf8");

    assert.equal(await findCopilotSessionPath(fileSessionId, { homeDir: tmpRoot }), filePath);
    assert.equal(await findCopilotSessionPath(dirSessionId, { homeDir: tmpRoot }), sessionDir);
  });

  it("finds kimi session path from hashed ~/.kimi/sessions directories", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fire-resume-"));
    const workspaceDir = path.join(tmpRoot, "workspace-kimi");
    const sessionId = "kimi-session-42";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tmpRoot, ".kimi", "sessions", workspaceHash, sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    assert.equal(await findKimiSessionPath(sessionId, { homeDir: tmpRoot }), sessionDir);
    assert.equal(await findSessionPath("kimi", sessionId, { homeDir: tmpRoot }), sessionDir);
  });

  it("dispatches provider path lookup via findSessionPath", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fire-resume-"));
    const sessionId = "codex-session-dispatch-1";
    const codexDir = path.join(tmpRoot, ".codex", "sessions");
    await fsp.mkdir(codexDir, { recursive: true });
    const filePath = path.join(codexDir, `${sessionId}.jsonl`);
    await fsp.writeFile(filePath, "", "utf8");

    assert.equal(await findSessionPath("codex", sessionId, { homeDir: tmpRoot }), filePath);
    await assert.rejects(
      () => findSessionPath("unknown-provider", "abc", { homeDir: tmpRoot }),
      /Unsupported provider/,
    );
  });

  it("resolves session run directory from file and directory paths", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
    const fileDir = path.join(tempDir, "nested");
    fs.mkdirSync(fileDir, { recursive: true });
    const filePath = path.join(fileDir, "session-1.jsonl");
    fs.writeFileSync(filePath, "", "utf8");

    assert.equal(await resolveSessionRunDirectory(filePath), fileDir);
    assert.equal(await resolveSessionRunDirectory(fileDir), fileDir);
  });

  it("resolves codex resume context with cwd from session metadata", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
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

  it("resolves copilot resume context with cwd from workspace.yaml", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
    const sessionId = "38395aba-10fe-4a9e-863e-c7ed750e0809";
    const workspaceDir = path.join(tempDir, "workspace-copilot");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const sessionDir = path.join(tempDir, ".copilot", "session-state", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "workspace.yaml"),
      `id: ${sessionId}\ncwd: ${workspaceDir}\n`,
      "utf8",
    );

    const resolved = await resolveResumeContext("copilot", sessionId, { homeDir: tempDir });
    assert.equal(resolved.provider, "copilot");
    assert.equal(resolved.sessionPath, sessionDir);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "session");
  });

  it("resolves kimi resume context from the current working directory hash", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
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

  it("resolves kimi resume context from conductor session bindings", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
    const workspaceDir = path.join(tempDir, "workspace-kimi-store");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const sessionId = "kimi-session-from-store";
    const workspaceHash = crypto.createHash("md5").update(workspaceDir).digest("hex");
    const sessionDir = path.join(tempDir, ".kimi", "sessions", workspaceHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "wire.jsonl"), "", "utf8");

    const conductorSessionsDir = path.join(tempDir, ".conductor", "sessions");
    fs.mkdirSync(conductorSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(conductorSessionsDir, "backend.yaml"),
      `sessions:\n  - project_id: project-kimi\n    task_id:\n      - task-kimi-1\n    project_path: ${JSON.stringify(workspaceDir)}\n    session_id: ${sessionId}\n    backend_type: kimi\n`,
      "utf8",
    );

    const resolved = await resolveResumeContext("kimi", sessionId, {
      homeDir: tempDir,
      cwd: path.join(tempDir, "somewhere-else"),
    });
    assert.equal(resolved.provider, "kimi");
    assert.equal(resolved.sessionPath, sessionDir);
    assert.equal(resolved.cwd, workspaceDir);
    assert.equal(resolved.debugMetadata?.cwdSource, "session");
  });

  it("rejects kimi resume when the original workspace cannot be reconstructed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
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

  it("resolves external resume context from conductor session bindings", async () => {
    await withClearedProviderEnv(async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
      const workspaceDir = path.join(tempDir, "workspace-external");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const conductorSessionsDir = path.join(tempDir, ".conductor", "sessions");
      fs.mkdirSync(conductorSessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(conductorSessionsDir, "external.yaml"),
        `sessions:\n  - project_id: project-external\n    task_id:\n      - task-external-1\n    project_path: ${JSON.stringify(workspaceDir)}\n    session_id: ext-123\n    backend_type: test-external\n`,
        "utf8",
      );

      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        `envs:\n  AISDK_PROVIDER_PATH: ${FIXTURE_EXTERNAL_PROVIDER}\n`,
        "utf8",
      );

      const resolved = await resolveResumeContext("test-external-alias", "ext-123", {
        homeDir: tempDir,
        configFilePath: configPath,
      });
      assert.equal(resolved.provider, "test-external");
      assert.equal(resolved.cwd, workspaceDir);
      assert.equal(resolved.debugMetadata?.cwdSource, "conductor_session_record");
    });
  });

  it("resolves external resume context when session bindings store a configured alias", async () => {
    await withClearedProviderEnv(async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
      const workspaceDir = path.join(tempDir, "workspace-external-configured-alias");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const conductorSessionsDir = path.join(tempDir, ".conductor", "sessions");
      fs.mkdirSync(conductorSessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(conductorSessionsDir, "external-configured-alias.yaml"),
        `sessions:\n  - project_id: project-external\n    task_id:\n      - task-external-1\n    project_path: ${JSON.stringify(workspaceDir)}\n    session_id: ext-configured-alias-1\n    backend_type: my-external\n`,
        "utf8",
      );

      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        `envs:\n  AISDK_PROVIDER_PATH: ${FIXTURE_EXTERNAL_PROVIDER}\nallow_cli_list:\n  my-external: test-external\n`,
        "utf8",
      );

      const resolved = await resolveResumeContext("test-external", "ext-configured-alias-1", {
        homeDir: tempDir,
        configFilePath: configPath,
      });
      assert.equal(resolved.provider, "test-external");
      assert.equal(resolved.cwd, workspaceDir);
      assert.equal(resolved.debugMetadata?.cwdSource, "conductor_session_record");
    });
  });

  it("falls back to the current working directory for external resume when no session record exists", async () => {
    await withClearedProviderEnv(async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-"));
      const workspaceDir = path.join(tempDir, "workspace-external-fallback");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        `envs:\n  AISDK_PROVIDER_PATH: ${FIXTURE_EXTERNAL_PROVIDER}\n`,
        "utf8",
      );

      const resolved = await resolveResumeContext("test-external", "ext-fallback-1", {
        homeDir: tempDir,
        cwd: workspaceDir,
        configFilePath: configPath,
      });
      assert.equal(resolved.provider, "test-external");
      assert.equal(resolved.cwd, workspaceDir);
      assert.equal(resolved.sessionPath, null);
      assert.equal(resolved.debugMetadata?.cwdSource, "current_working_directory");
    });
  });
});
