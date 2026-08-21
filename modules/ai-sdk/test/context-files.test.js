import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendContextFilesToPrompt, normalizeContextFiles } from "../src/context-files.js";

test("normalizes multiple local context files and appends an ordered manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-"));
  try {
    const spec = path.join(dir, "spec.md");
    const data = path.join(dir, "data.csv");
    fs.writeFileSync(spec, "# spec");
    fs.writeFileSync(data, "a,b\n1,2");
    const result = appendContextFilesToPrompt("Analyze", [
      { path: spec, mimeType: "text/markdown" },
      { path: data, mimeType: "text/csv" },
    ]);
    assert.deepEqual(result.contextFiles.map((entry) => entry.name), ["spec.md", "data.csv"]);
    assert.match(result.prompt, /1\. spec\.md/);
    assert.match(result.prompt, new RegExp(spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.prompt, /2\. data\.csv/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects remote paths and symbolic links", () => {
  assert.throws(
    () => normalizeContextFiles([{ path: "https://example.test/spec.md", mimeType: "text/markdown" }]),
    (error) => error.reason === "invalid_context_file",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-"));
  try {
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "link.txt");
    fs.writeFileSync(target, "context");
    fs.symlinkSync(target, link);
    assert.throws(
      () => normalizeContextFiles([{ path: link, mimeType: "text/plain" }]),
      (error) => error.reason === "invalid_context_file",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
