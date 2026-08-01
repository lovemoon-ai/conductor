import fs from "node:fs";
import path from "node:path";

const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_CONTEXT_BYTES = 200 * 1024 * 1024;

export function normalizeContextFiles(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw createContextFileError("contextFiles must be an array");
  if (value.length > MAX_CONTEXT_FILES) {
    throw createContextFileError(`contextFiles cannot contain more than ${MAX_CONTEXT_FILES} files`, {
      reason: "context_file_limit_exceeded",
    });
  }
  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createContextFileError(`contextFiles[${index}] must be an object`, { contextFileIndex: index });
    }
    const filePath = typeof item.path === "string" ? item.path.trim() : "";
    if (!filePath || !path.isAbsolute(filePath)) {
      throw createContextFileError(`contextFiles[${index}] path must be absolute`, { contextFileIndex: index });
    }
    let stat;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink()) throw new Error("symbolic links are not allowed");
      stat = fs.statSync(filePath);
    } catch {
      throw createContextFileError(`contextFiles[${index}] file does not exist`, { contextFileIndex: index });
    }
    if (!stat.isFile()) {
      throw createContextFileError(`contextFiles[${index}] path must reference a file`, { contextFileIndex: index });
    }
    if (stat.size > MAX_CONTEXT_FILE_BYTES) {
      throw createContextFileError(`contextFiles[${index}] exceeds the file size limit`, {
        reason: "context_file_limit_exceeded",
        contextFileIndex: index,
        maxBytes: MAX_CONTEXT_FILE_BYTES,
      });
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_CONTEXT_BYTES) {
      throw createContextFileError("contextFiles exceeds the total size limit", {
        reason: "context_file_limit_exceeded",
        maxBytes: MAX_TOTAL_CONTEXT_BYTES,
      });
    }
    return {
      path: filePath,
      name: typeof item.name === "string" && item.name.trim() ? path.basename(item.name.trim()) : path.basename(filePath),
      mimeType: typeof item.mimeType === "string" && item.mimeType.trim()
        ? item.mimeType.trim().toLowerCase()
        : "application/octet-stream",
      sizeBytes: stat.size,
    };
  });
}

export function appendContextFilesToPrompt(promptText, value) {
  const files = normalizeContextFiles(value);
  const prompt = String(promptText || "").trim();
  if (files.length === 0) return { prompt, contextFiles: files };
  const manifest = files.map((file, index) => [
    `${index + 1}. ${file.name}`,
    `   Path: ${file.path}`,
    `   MIME: ${file.mimeType}`,
  ].join("\n")).join("\n\n");
  return {
    contextFiles: files,
    prompt: [
      prompt,
      "The following user-provided context files are available locally. Read them when relevant to the request:",
      manifest,
    ].filter(Boolean).join("\n\n"),
  };
}

export function createContextFileError(message, extras = {}) {
  const error = new Error(message);
  error.reason = extras.reason || "invalid_context_file";
  Object.assign(error, extras);
  return error;
}
