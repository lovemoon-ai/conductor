import fs from "node:fs";
import path from "node:path";

import { SessionDiskStore } from "@love-moon/conductor-sdk";

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 500;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

function clampPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function normalizeSince(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function inferLevel(message) {
  const normalized = String(message || "").toLowerCase();
  if (normalized.includes("error") || normalized.includes("failed")) {
    return "ERROR";
  }
  if (normalized.includes("warn")) {
    return "WARN";
  }
  return "INFO";
}

function parseLogLine(line) {
  const content = String(line || "").trim();
  if (!content) {
    return null;
  }

  const rfcMatch = content.match(/^\[([^\]]+)\]\s+\[([A-Z]+)\]\s+(.*)$/);
  if (rfcMatch) {
    const timestamp = Date.parse(rfcMatch[1]);
    if (Number.isFinite(timestamp)) {
      return {
        timestamp: new Date(timestamp).toISOString(),
        level: rfcMatch[2],
        message: rfcMatch[3],
      };
    }
  }

  const conductorMatch = content.match(/^\[([^\]]+?)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\]\s+(.*)$/);
  if (conductorMatch) {
    const timestamp = Date.parse(conductorMatch[2]);
    if (Number.isFinite(timestamp)) {
      return {
        timestamp: new Date(timestamp).toISOString(),
        level: inferLevel(conductorMatch[3]),
        message: `[${conductorMatch[1]}] ${conductorMatch[3]}`,
      };
    }
  }

  return {
    timestamp: null,
    level: inferLevel(content),
    message: content,
  };
}

function readTailText(filePath, maxBytes) {
  const stats = fs.statSync(filePath);
  const bytesToRead = Math.min(stats.size, maxBytes);
  const start = Math.max(0, stats.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return {
    text,
    truncatedByBytes: start > 0,
  };
}

export class DaemonLogCollector {
  constructor(backendUrl, options = {}) {
    this.sessionStore = options.sessionStore || SessionDiskStore.forBackendUrl(backendUrl);
    this.readTailText = options.readTailText || readTailText;
    this.existsSync = options.existsSync || fs.existsSync;
  }

  collect(taskId, options = {}) {
    const normalizedTaskId = String(taskId || "").trim();
    const collectedAt = new Date().toISOString();
    if (!normalizedTaskId) {
      return {
        projectPath: null,
        logPath: null,
        entries: [],
        truncated: false,
        error: "task_id is required",
        collectedAt,
      };
    }

    const record = this.sessionStore.findByTaskId(normalizedTaskId);
    if (!record) {
      return {
        projectPath: null,
        logPath: null,
        entries: [],
        truncated: false,
        error: "Task not found in session store",
        collectedAt,
      };
    }

    const projectPath = path.resolve(record.projectPath);
    const logPath = path.join(projectPath, "conductor.log");
    if (!this.existsSync(logPath)) {
      return {
        projectPath,
        logPath,
        entries: [],
        truncated: false,
        error: "Log file not found",
        collectedAt,
      };
    }

    const tailLines = clampPositiveInt(options.tailLines, DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
    const maxBytes = clampPositiveInt(options.maxBytes, DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES);
    const sinceMs = normalizeSince(options.since);
    const { text, truncatedByBytes } = this.readTailText(logPath, maxBytes);
    let anchorTimestampMs = null;
    const allEntries = [];
    for (const line of text.split(/\r?\n/)) {
      const entry = parseLogLine(line);
      if (!entry) {
        continue;
      }
      const entryTimestampMs =
        typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : anchorTimestampMs;
      if (typeof entry.timestamp === "string" && Number.isFinite(entryTimestampMs)) {
        anchorTimestampMs = entryTimestampMs;
      }
      if (sinceMs !== null) {
        if (!Number.isFinite(entryTimestampMs)) {
          continue;
        }
        if (entryTimestampMs < sinceMs) {
          continue;
        }
      }
      allEntries.push(entry);
    }
    const entries = allEntries.slice(-tailLines);

    return {
      projectPath,
      logPath,
      entries,
      truncated: truncatedByBytes || allEntries.length > entries.length,
      error: null,
      collectedAt,
    };
  }
}
