import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { DaemonLogCollector } from "../src/log-collector.js";

describe("DaemonLogCollector", () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("tails log entries and applies since filtering", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-log-collector-"));
    tempDirs.push(root);

    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "conductor.log"),
      [
        "[2026-03-10T10:00:00+08:00] [INFO] boot",
        "[2026-03-10T10:04:00+08:00] [INFO] waiting for task",
        "[2026-03-10T10:05:00+08:00] [WARN] retrying backend call",
        "[2026-03-10T10:06:00+08:00] [ERROR] task failed",
      ].join("\n"),
      "utf8",
    );

    const collector = new DaemonLogCollector("http://localhost:6152", {
      sessionStore: {
        findByTaskId: (taskId) =>
          taskId === "task-1"
            ? {
                projectPath,
              }
            : undefined,
      },
    });

    const result = collector.collect("task-1", {
      tailLines: 2,
      since: "2026-03-10T10:04:30+08:00",
    });

    assert.strictEqual(result.projectPath, path.resolve(projectPath));
    assert.strictEqual(result.logPath, path.join(path.resolve(projectPath), "conductor.log"));
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.entries, [
      {
        timestamp: "2026-03-10T02:05:00.000Z",
        level: "WARN",
        message: "retrying backend call",
      },
      {
        timestamp: "2026-03-10T02:06:00.000Z",
        level: "ERROR",
        message: "task failed",
      },
    ]);
  });

  it("does not treat untimestamped lines as freshly collected during since filtering", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-log-collector-"));
    tempDirs.push(root);

    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "conductor.log"),
      [
        "[2026-03-10T10:04:00+08:00] [INFO] before threshold",
        "raw old output",
        "[2026-03-10T10:06:00+08:00] [INFO] after threshold",
        "raw recent output",
      ].join("\n"),
      "utf8",
    );

    const collector = new DaemonLogCollector("http://localhost:6152", {
      sessionStore: {
        findByTaskId: (taskId) =>
          taskId === "task-2"
            ? {
                projectPath,
              }
            : undefined,
      },
    });

    const result = collector.collect("task-2", {
      since: "2026-03-10T10:05:00+08:00",
    });

    assert.deepStrictEqual(result.entries, [
      {
        timestamp: "2026-03-10T02:06:00.000Z",
        level: "INFO",
        message: "after threshold",
      },
      {
        timestamp: null,
        level: "INFO",
        message: "raw recent output",
      },
    ]);
  });
});
