import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { listSessionsForBackend } from "../src/resume/index.js";
import { listSessions as listClaudeSessions } from "../src/resume/claude.js";
import { listSessions as listCodexSessions } from "../src/resume/codex.js";
import { listSessions as listKimiSessions } from "../src/resume/kimi.js";

const DAY = (n) => new Date(Date.UTC(2026, 0, n));

async function touch(targetPath, date) {
  await fsp.utimes(targetPath, date, date);
}

async function writeClaudeSessionFile(projectDir, sessionId, { text, cwd, date }) {
  await fsp.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId }),
    JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  ];
  await fsp.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  await touch(filePath, date);
  return filePath;
}

describe("ai-sdk listSessions", () => {
  it("lists claude sessions newest first with title/cwd, skipping agent files", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-claude-"));
    const projectDir = path.join(tmpRoot, ".claude", "projects", "demo-project");
    const workspaceDir = path.join(tmpRoot, "workspace");

    const oldPath = await writeClaudeSessionFile(projectDir, "session-old", {
      text: "old prompt",
      cwd: workspaceDir,
      date: DAY(1),
    });
    const longText = `fix the flaky resume test\nplease look at ${"x".repeat(100)}`;
    const newPath = await writeClaudeSessionFile(projectDir, "session-new", {
      text: longText,
      cwd: workspaceDir,
      date: DAY(3),
    });
    // Corrupt file: still listed (id comes from the file name), title/cwd degrade to null.
    const corruptPath = path.join(projectDir, "session-corrupt.jsonl");
    await fsp.writeFile(corruptPath, "not json at all\n{broken", "utf8");
    await touch(corruptPath, DAY(2));
    // Subagent transcript: must never show up.
    const agentPath = path.join(projectDir, "agent-123.jsonl");
    await fsp.writeFile(agentPath, "", "utf8");
    await touch(agentPath, DAY(9));

    const sessions = await listClaudeSessions({ homeDir: tmpRoot });
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ["session-new", "session-corrupt", "session-old"],
    );
    assert.equal(sessions[0].sessionFilePath, newPath);
    assert.equal(sessions[0].cwd, workspaceDir);
    assert.equal(sessions[0].title.length, 80);
    assert.ok(sessions[0].title.startsWith("fix the flaky resume test please look at"));
    assert.ok(!sessions[0].title.includes("\n"));
    assert.equal(sessions[0].updatedAt, DAY(3).getTime());
    assert.equal(sessions[1].sessionFilePath, corruptPath);
    assert.equal(sessions[1].title, null);
    assert.equal(sessions[1].cwd, null);
    assert.equal(sessions[2].sessionFilePath, oldPath);
    assert.equal(sessions[2].title, "old prompt");

    const limited = await listClaudeSessions({ homeDir: tmpRoot, limit: 1 });
    assert.deepEqual(limited.map((s) => s.sessionId), ["session-new"]);
  });

  it("merges claude sessions from $CLAUDE_CONFIG_DIR and the home fallback", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-claude-cfg-"));
    const configDir = path.join(tmpRoot, "shared", "claude-sessions");
    await writeClaudeSessionFile(path.join(configDir, "projects", "proj"), "cfg-session", {
      text: "from config dir",
      cwd: tmpRoot,
      date: DAY(2),
    });
    await writeClaudeSessionFile(path.join(tmpRoot, ".claude", "projects", "proj"), "home-session", {
      text: "from home dir",
      cwd: tmpRoot,
      date: DAY(1),
    });

    const sessions = await listClaudeSessions({
      env: { CLAUDE_CONFIG_DIR: configDir, HOME: tmpRoot },
    });
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ["cfg-session", "home-session"],
    );
  });

  it("lists codex sessions with metadata from session_meta and filename fallback", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-codex-"));
    const workspaceDir = path.join(tmpRoot, "workspace-codex");
    const dayOne = path.join(tmpRoot, ".codex", "sessions", "2026", "03", "01");
    const dayTwo = path.join(tmpRoot, ".codex", "sessions", "2026", "03", "02");
    await fsp.mkdir(dayOne, { recursive: true });
    await fsp.mkdir(dayTwo, { recursive: true });

    const metaId = "019cb2a4-de18-70b0-816b-a9b0d99400bb";
    const metaPath = path.join(dayOne, `rollout-2026-03-01T10-00-00-${metaId}.jsonl`);
    await fsp.writeFile(
      metaPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: metaId, cwd: workspaceDir } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "hello\ncodex" },
        }),
      ].join("\n"),
      "utf8",
    );
    await touch(metaPath, DAY(1));

    // No session_meta: the id is recovered from the file name.
    const nameId = "11111111-2222-4333-8444-555555555555";
    const namePath = path.join(dayTwo, `session-${nameId}.jsonl`);
    await fsp.writeFile(namePath, "not json\n", "utf8");
    await touch(namePath, DAY(2));

    // Neither meta nor uuid in the name: skipped, next candidate backfills.
    const junkPath = path.join(dayTwo, "junk.jsonl");
    await fsp.writeFile(junkPath, "not json\n", "utf8");
    await touch(junkPath, DAY(3));

    const sessions = await listCodexSessions({ homeDir: tmpRoot });
    assert.deepEqual(sessions.map((s) => s.sessionId), [nameId, metaId]);
    assert.equal(sessions[0].sessionFilePath, namePath);
    assert.equal(sessions[0].cwd, null);
    assert.equal(sessions[0].title, null);
    assert.equal(sessions[1].sessionFilePath, metaPath);
    assert.equal(sessions[1].cwd, workspaceDir);
    assert.equal(sessions[1].title, "hello codex");
    assert.equal(sessions[1].updatedAt, DAY(1).getTime());

    const limited = await listCodexSessions({ homeDir: tmpRoot, limit: 1 });
    assert.deepEqual(limited.map((s) => s.sessionId), [nameId]);
  });

  it("lists kimi sessions from the session index, excluding deleted and stale records", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-kimi-"));
    const kimiCodeHome = path.join(tmpRoot, ".kimi-code");
    const sessionsDir = path.join(kimiCodeHome, "sessions");
    const workspaceA = path.join(tmpRoot, "workspace-a");
    const workspaceB = path.join(tmpRoot, "workspace-b");

    const dirA = path.join(sessionsDir, "hash1", "ses_a");
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.writeFile(
      path.join(dirA, "state.json"),
      JSON.stringify({ workDir: workspaceA, title: "fix the bug" }),
      "utf8",
    );
    await touch(dirA, DAY(1));

    const dirB = path.join(sessionsDir, "hash1", "ses_b");
    await fsp.mkdir(dirB, { recursive: true });
    await touch(dirB, DAY(2));

    const dirC = path.join(sessionsDir, "hash2", "ses_c");
    await fsp.mkdir(dirC, { recursive: true });

    await fsp.writeFile(
      path.join(kimiCodeHome, "session_index.jsonl"),
      [
        JSON.stringify({ sessionId: "ses_a", sessionDir: dirA, workDir: path.join(tmpRoot, "stale") }),
        JSON.stringify({ sessionId: "ses_b", sessionDir: dirB, workDir: workspaceB, title: "b title" }),
        JSON.stringify({ sessionId: "ses_c", sessionDir: dirC, workDir: workspaceB }),
        JSON.stringify({ sessionId: "ses_c", deleted: true }),
        JSON.stringify({ sessionId: "ses_gone", sessionDir: path.join(sessionsDir, "hash2", "ses_gone") }),
        "{broken json",
      ].join("\n"),
      "utf8",
    );

    const sessions = await listKimiSessions({ homeDir: tmpRoot });
    assert.deepEqual(sessions.map((s) => s.sessionId), ["ses_b", "ses_a"]);
    // No state.json for ses_b: metadata comes from the index record.
    assert.equal(sessions[0].sessionFilePath, null);
    assert.equal(sessions[0].cwd, workspaceB);
    assert.equal(sessions[0].title, "b title");
    assert.equal(sessions[0].updatedAt, DAY(2).getTime());
    // state.json wins over the stale index workDir for ses_a.
    assert.equal(sessions[1].sessionFilePath, path.join(dirA, "state.json"));
    assert.equal(sessions[1].cwd, workspaceA);
    assert.equal(sessions[1].title, "fix the bug");

    const limited = await listKimiSessions({ homeDir: tmpRoot, limit: 1 });
    assert.deepEqual(limited.map((s) => s.sessionId), ["ses_b"]);
  });

  it("falls back to scanning kimi session directories and honors KIMI_CODE_HOME", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-kimi-scan-"));
    const customHome = path.join(tmpRoot, "custom-kimi-home");
    const workspaceDir = path.join(tmpRoot, "workspace");

    const dirX = path.join(customHome, "sessions", "hash1", "ses_x");
    await fsp.mkdir(dirX, { recursive: true });
    await fsp.writeFile(path.join(dirX, "state.json"), JSON.stringify({ workDir: workspaceDir }), "utf8");
    await touch(dirX, DAY(2));

    const dirY = path.join(customHome, "sessions", "hash1", "ses_y");
    await fsp.mkdir(dirY, { recursive: true });
    await touch(dirY, DAY(1));

    const sessions = await listKimiSessions({
      homeDir: tmpRoot,
      env: { KIMI_CODE_HOME: customHome },
    });
    assert.deepEqual(sessions.map((s) => s.sessionId), ["ses_x", "ses_y"]);
    assert.equal(sessions[0].cwd, workspaceDir);
    assert.equal(sessions[0].sessionFilePath, path.join(dirX, "state.json"));
    assert.equal(sessions[1].cwd, null);
    assert.equal(sessions[1].sessionFilePath, null);
    assert.equal(sessions[1].title, null);
  });

  it("falls back to scanning when the kimi index only holds stale records", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-kimi-rot-"));
    const kimiCodeHome = path.join(tmpRoot, ".kimi-code");
    const sessionsDir = path.join(kimiCodeHome, "sessions");

    // Real session on disk that the index knows nothing about.
    const dirReal = path.join(sessionsDir, "hash1", "ses_real");
    await fsp.mkdir(dirReal, { recursive: true });
    await touch(dirReal, DAY(1));

    // Index exists but every record points at a deleted directory.
    await fsp.writeFile(
      path.join(kimiCodeHome, "session_index.jsonl"),
      JSON.stringify({ sessionId: "ses_gone", sessionDir: path.join(sessionsDir, "hash9", "ses_gone") }),
      "utf8",
    );

    const sessions = await listKimiSessions({ homeDir: tmpRoot });
    assert.deepEqual(sessions.map((s) => s.sessionId), ["ses_real"]);
  });

  it("returns [] when session roots are missing", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-empty-"));
    assert.deepEqual(await listClaudeSessions({ homeDir: tmpRoot }), []);
    assert.deepEqual(await listCodexSessions({ homeDir: tmpRoot }), []);
    assert.deepEqual(await listKimiSessions({ homeDir: tmpRoot }), []);
  });

  it("dispatches listSessionsForBackend through backend aliases", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-sdk-list-dispatch-"));
    const projectDir = path.join(tmpRoot, ".claude", "projects", "proj");
    await writeClaudeSessionFile(projectDir, "alias-session", {
      text: "hi",
      cwd: tmpRoot,
      date: DAY(1),
    });

    const viaAlias = await listSessionsForBackend("claude-code", { homeDir: tmpRoot });
    assert.deepEqual(viaAlias.map((s) => s.sessionId), ["alias-session"]);

    // Backends without listSessions and unknown backends both yield [].
    assert.deepEqual(await listSessionsForBackend("opencode", { homeDir: tmpRoot }), []);
    assert.deepEqual(await listSessionsForBackend("unknown-backend", { homeDir: tmpRoot }), []);
  });
});
