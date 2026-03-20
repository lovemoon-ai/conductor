import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findClaudeSessionPath,
  findCodexSessionPath,
  findCopilotSessionPath,
  findSessionPath,
  resolveResumeContext,
  resolveSessionRunDirectory,
  resumeProviderForBackend,
} from "../src/fire/resume.js";

describe("fire resume resolver", () => {
  it("maps backend name to resume provider", () => {
    assert.equal(resumeProviderForBackend("codex"), "codex");
    assert.equal(resumeProviderForBackend("code"), "codex");
    assert.equal(resumeProviderForBackend("claude"), "claude");
    assert.equal(resumeProviderForBackend("claude-code"), "claude");
    assert.equal(resumeProviderForBackend("copilot"), "copilot");
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
});
