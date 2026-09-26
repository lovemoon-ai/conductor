/**
 * `conductor remote mcp` (RFC 0040).
 *
 * The workspace tests run every tool's real remote script through the real
 * daemon-side exec handler against a temp directory, so the bash/rg/awk
 * plumbing is exercised for real; only the HTTP relay is skipped. The file
 * transfer seam is covered by `remote-cp-roundtrip.test.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  buildRemoteWorkspaceTools,
  createMcpServer,
  createRemoteWorkspace,
  parseMcpArgs,
  serveStdio,
} from "../src/remote/mcp.js";
import {
  REMOTE_WORKTREE_ENV,
  buildRemoteWorktreeSessionOptions,
  readRemoteWorktreeBinding,
  remoteWorktreeFireEnv,
  resolveRemoteWorktreeBinding,
} from "../src/remote/mcp-launch.js";
import { createRemoteExecHandlers } from "../src/remote-exec-handlers.js";

const REMOTE_SCRIPT = fileURLToPath(new URL("../bin/conductor-remote.js", import.meta.url));

const hasRg = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A PATH that has everything the remote scripts use except ripgrep, to drive
 * the grep/globstar fallbacks on a machine that does have rg installed.
 */
async function pathWithoutRg(dir) {
  const bin = path.join(dir, "bin-no-rg");
  await fsp.mkdir(bin, { recursive: true });
  for (const tool of ["bash", "sh", "grep", "wc", "tr", "tail", "head", "mktemp", "rm", "mv", "cat", "dirname", "env"]) {
    const found = execFileSync("bash", ["-c", `command -v ${tool}`]).toString().trim();
    await fsp.symlink(found, path.join(bin, tool));
  }
  return bin;
}

/** Drive the real daemon-side exec handler the way `execRemote` drives it over HTTP. */
function makeExec(handlers, { env } = {}) {
  const calls = [];
  const exec = async ({ command, args, workspace, timeoutMs }) => {
    calls.push({ command, args, workspace });
    const outcome = await handlers.dispatch({
      action: "exec",
      args: { command, args, workspace, timeoutMs, ...(env ? { env } : {}) },
    });
    if (outcome.error) throw new Error(outcome.error);
    return outcome.result;
  };
  const wait = async (runId, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let run;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outcome = await handlers.dispatch({ action: "status", args: { runId } });
      if (outcome.error) throw new Error(outcome.error);
      run = outcome.result;
    } while (run.status === "running" && Date.now() < deadline);
    return run;
  };
  return { exec, wait, calls };
}

async function setup({ env, cwdSub = "" } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conductor-mcp-test-"));
  const root = path.join(dir, "worktree");
  const cwd = cwdSub ? path.join(root, cwdSub) : root;
  const outside = path.join(dir, "outside.txt");
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.writeFile(outside, "not yours\n");

  const handlers = createRemoteExecHandlers({ defaultWorkspace: dir });
  const { exec, wait, calls } = makeExec(handlers, { env });
  const uploads = [];
  const hooks = { afterDownload: null };
  const workspace = createRemoteWorkspace({
    host: "ubuntu",
    root,
    cwd,
    exec,
    wait,
    tmpDir: dir,
    download: async (remotePath, localPath) => {
      const stat = await fsp.stat(remotePath);
      if (stat.isDirectory()) throw new Error(`${remotePath} is a directory`);
      const bytes = await fsp.readFile(remotePath);
      await fsp.writeFile(localPath, bytes);
      await hooks.afterDownload?.(remotePath);
      return { sha256: sha256(bytes), mode: stat.mode & 0o777, sizeBytes: bytes.length };
    },
    // Like the daemon: a `.part` beside the target, the source's mode, a rename.
    upload: async (localPath, remotePath) => {
      const mode = (await fsp.stat(localPath)).mode & 0o777;
      uploads.push({ remotePath, mode });
      const part = `${remotePath}.part`;
      await fsp.copyFile(localPath, part);
      await fsp.chmod(part, mode);
      await fsp.rename(part, remotePath);
    },
  });
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true });
  return { dir, root, cwd, outside, workspace, uploads, hooks, calls, cleanup };
}

// ---------------------------------------------------------------------------
// remote_read
// ---------------------------------------------------------------------------

test("remote_read numbers lines like cat -n and pages with offset/limit", async () => {
  const ctx = await setup();
  try {
    await fsp.writeFile(path.join(ctx.root, "a.txt"), "one\ntwo\nthree\nfour\nfive");
    assert.equal(
      await ctx.workspace.read({ file_path: "a.txt" }),
      "     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour\n     5\tfive",
    );
    const page = await ctx.workspace.read({ file_path: "a.txt", offset: 2, limit: 2 });
    assert.equal(
      page,
      "     2\ttwo\n     3\tthree\n\n[Showing lines 2-3 of 5. Continue with offset=4.]",
    );
  } finally {
    await ctx.cleanup();
  }
});

test("remote_read resolves relative paths against the work dir, not the root", async () => {
  const ctx = await setup({ cwdSub: "packages/app" });
  try {
    await fsp.writeFile(path.join(ctx.cwd, "index.js"), "export {};\n");
    assert.match(await ctx.workspace.read({ file_path: "index.js" }), /export \{\};/);
    // ...while an absolute path elsewhere under the root is still allowed.
    await fsp.writeFile(path.join(ctx.root, "README.md"), "# hi\n");
    assert.match(await ctx.workspace.read({ file_path: path.join(ctx.root, "README.md") }), /# hi/);
    assert.match(await ctx.workspace.read({ file_path: "../../README.md" }), /# hi/);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_read refuses paths outside the bound root before touching the host", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.workspace.read({ file_path: ctx.outside }), /outside the remote workspace/);
    await assert.rejects(ctx.workspace.read({ file_path: "../outside.txt" }), /outside the remote workspace/);
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_read explains empty files, missing files, directories and a bad offset", async () => {
  const ctx = await setup();
  try {
    await fsp.writeFile(path.join(ctx.root, "empty"), "");
    await fsp.mkdir(path.join(ctx.root, "sub"));
    await fsp.writeFile(path.join(ctx.root, "short"), "x\n");
    assert.match(await ctx.workspace.read({ file_path: "empty" }), /is empty/);
    await assert.rejects(ctx.workspace.read({ file_path: "missing" }), /no such file/);
    await assert.rejects(ctx.workspace.read({ file_path: "sub" }), /is a directory/);
    await assert.rejects(ctx.workspace.read({ file_path: "short", offset: 5 }), /past the end .* \(1 lines\)/);
    await assert.rejects(ctx.workspace.read({ file_path: "short", offset: 0 }), /offset must be an integer/);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_read pages a file larger than the exec output cap without losing a line", async () => {
  const ctx = await setup();
  try {
    // ~150 KB: far past the 64 000-character tail remote exec keeps.
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`);
    await fsp.writeFile(path.join(ctx.root, "big.txt"), `${lines.join("\n")}\n`);

    const seen = [];
    let offset = 1;
    for (let guard = 0; guard < 10; guard += 1) {
      const text = await ctx.workspace.read({ file_path: "big.txt", offset });
      const body = text.split("\n\n[Showing")[0];
      for (const row of body.split("\n")) {
        const [number, content] = row.split("\t");
        seen.push({ number: Number(number), content });
      }
      const next = text.match(/Continue with offset=(\d+)/);
      if (!next) break;
      offset = Number(next[1]);
    }
    assert.equal(seen.length, 1500);
    seen.forEach((row, index) => {
      assert.equal(row.number, index + 1);
      assert.equal(row.content, lines[index]);
    });
  } finally {
    await ctx.cleanup();
  }
});

test("remote_read truncates a very long line instead of flooding the context", async () => {
  const ctx = await setup();
  try {
    await fsp.writeFile(path.join(ctx.root, "min.js"), `${"a".repeat(5000)}\nnext\n`);
    const text = await ctx.workspace.read({ file_path: "min.js" });
    assert.match(text, /^ {5}1\ta{2000}… \[line truncated\]\n {5}2\tnext$/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// remote_edit
// ---------------------------------------------------------------------------

test("remote_edit replaces a unique string, keeps the file mode and shows the result", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "run.sh");
    await fsp.writeFile(file, "#!/bin/sh\necho old\nexit 0\n");
    await fsp.chmod(file, 0o755);
    const text = await ctx.workspace.edit({ file_path: "run.sh", old_string: "echo old", new_string: "echo new" });
    assert.equal(await fsp.readFile(file, "utf8"), "#!/bin/sh\necho new\nexit 0\n");
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o755);
    assert.deepEqual(ctx.uploads, [{ remotePath: file, mode: 0o755 }]);
    assert.match(text, /replaced 1 occurrence\./);
    assert.match(text, / {5}2\techo new/);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_edit refuses a missing or ambiguous old_string without writing", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "a.txt");
    await fsp.writeFile(file, "foo\nfoo\nbar\n");
    await assert.rejects(
      ctx.workspace.edit({ file_path: "a.txt", old_string: "baz", new_string: "x" }),
      /was not found/,
    );
    await assert.rejects(
      ctx.workspace.edit({ file_path: "a.txt", old_string: "foo", new_string: "x" }),
      /matches 2 places .* replace_all/,
    );
    await assert.rejects(
      ctx.workspace.edit({ file_path: "a.txt", old_string: "foo", new_string: "foo" }),
      /identical/,
    );
    await assert.rejects(
      ctx.workspace.edit({ file_path: "a.txt", old_string: "", new_string: "x" }),
      /use remote_write/,
    );
    assert.equal(ctx.uploads.length, 0);
    assert.equal(await fsp.readFile(file, "utf8"), "foo\nfoo\nbar\n");

    const text = await ctx.workspace.edit({ file_path: "a.txt", old_string: "foo", new_string: "x", replace_all: true });
    assert.match(text, /replaced 2 occurrences/);
    assert.equal(await fsp.readFile(file, "utf8"), "x\nx\nbar\n");
  } finally {
    await ctx.cleanup();
  }
});

test("remote_edit inserts new_string literally — no $& / $1 replacement patterns", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "a.sh");
    await fsp.writeFile(file, 'X="placeholder"\n');
    await ctx.workspace.edit({ file_path: "a.sh", old_string: "placeholder", new_string: "$& $1 $$ `pwd` 'q' \"dq\"" });
    assert.equal(await fsp.readFile(file, "utf8"), 'X="$& $1 $$ `pwd` \'q\' "dq""\n');
  } finally {
    await ctx.cleanup();
  }
});

test("remote_edit matches LF snippets against a CRLF file and keeps CRLF", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "win.txt");
    await fsp.writeFile(file, "alpha\r\nbeta\r\ngamma\r\n");
    await ctx.workspace.edit({ file_path: "win.txt", old_string: "alpha\nbeta", new_string: "alpha\nBETA" });
    assert.equal(await fsp.readFile(file, "utf8"), "alpha\r\nBETA\r\ngamma\r\n");
  } finally {
    await ctx.cleanup();
  }
});

test("remote_edit refuses to overwrite a change made on the host after it read the file", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "a.txt");
    await fsp.writeFile(file, "one\n");
    ctx.hooks.afterDownload = async () => {
      await fsp.writeFile(file, "one\nsomeone else\n");
    };
    await assert.rejects(
      ctx.workspace.edit({ file_path: "a.txt", old_string: "one", new_string: "two" }),
      /changed on ubuntu while it was being edited/,
    );
    assert.equal(await fsp.readFile(file, "utf8"), "one\nsomeone else\n");
    assert.equal(ctx.uploads.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_edit refuses binary and non-UTF-8 files", async () => {
  const ctx = await setup();
  try {
    await fsp.writeFile(path.join(ctx.root, "bin"), Buffer.from([0x61, 0x00, 0x62]));
    await fsp.writeFile(path.join(ctx.root, "latin1"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await assert.rejects(ctx.workspace.edit({ file_path: "bin", old_string: "a", new_string: "b" }), /binary/);
    await assert.rejects(ctx.workspace.edit({ file_path: "latin1", old_string: "c", new_string: "d" }), /UTF-8/);
    assert.equal(ctx.uploads.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// remote_write
// ---------------------------------------------------------------------------

test("remote_write creates parent directories and writes the exact bytes", async () => {
  const ctx = await setup();
  try {
    const content = "#!/bin/bash\ncat <<'EOF'\n$HOME `id` \"q\" 'q' \\n\nEOF\n";
    const text = await ctx.workspace.write({ file_path: "deep/er/new.sh", content });
    const file = path.join(ctx.root, "deep/er/new.sh");
    assert.equal(await fsp.readFile(file, "utf8"), content);
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o644);
    assert.match(text, /^Created .*new\.sh on ubuntu/);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_write over an existing file keeps its mode", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "tool");
    await fsp.writeFile(file, "old");
    await fsp.chmod(file, 0o750);
    const text = await ctx.workspace.write({ file_path: file, content: "" });
    assert.equal(await fsp.readFile(file, "utf8"), "");
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o750);
    assert.match(text, /^Updated /);
    await assert.rejects(ctx.workspace.write({ file_path: ctx.outside, content: "x" }), /outside/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// remote_grep / remote_glob
// ---------------------------------------------------------------------------

async function seedSearchTree(root) {
  await fsp.mkdir(path.join(root, "src/lib"), { recursive: true });
  await fsp.writeFile(path.join(root, "src/a.ts"), "const needle = 1;\nconst other = 2;\n");
  await fsp.writeFile(path.join(root, "src/lib/b.ts"), "// Needle here\nexport const needle = 3;\n");
  await fsp.writeFile(path.join(root, "src/c.js"), "needle();\n");
  await fsp.writeFile(path.join(root, "notes.md"), "no match\n");
}

test("remote_grep returns files, content and counts", { skip: !hasRg }, async () => {
  const ctx = await setup();
  try {
    await seedSearchTree(ctx.root);
    const files = await ctx.workspace.grep({ pattern: "needle" });
    assert.match(files, /^Found 3 files\n/);
    for (const name of ["src/a.ts", "src/lib/b.ts", "src/c.js"]) {
      assert.ok(files.includes(path.join(ctx.root, name)), `${name} in ${files}`);
    }

    const content = await ctx.workspace.grep({ pattern: "needle", output_mode: "content", glob: "*.ts" });
    assert.equal(
      content,
      [
        `${path.join(ctx.root, "src/a.ts")}:1:const needle = 1;`,
        `${path.join(ctx.root, "src/lib/b.ts")}:2:export const needle = 3;`,
      ].join("\n"),
    );

    const insensitive = await ctx.workspace.grep({
      pattern: "needle", output_mode: "count", case_insensitive: true, path: "src/lib",
    });
    assert.equal(insensitive, `${path.join(ctx.root, "src/lib/b.ts")}:2`);

    // A single file, a glob with a directory in it, and context lines all
    // come back as absolute paths.
    assert.equal(
      await ctx.workspace.grep({ pattern: "other", output_mode: "content", path: "src/a.ts" }),
      `${path.join(ctx.root, "src/a.ts")}:2:const other = 2;`,
    );
    assert.equal(
      await ctx.workspace.grep({ pattern: "needle", glob: "src/lib/*.ts" }),
      `Found 1 file\n${path.join(ctx.root, "src/lib/b.ts")}`,
    );
    assert.equal(
      await ctx.workspace.grep({ pattern: "other", output_mode: "content", context: 1, path: "src" }),
      `${path.join(ctx.root, "src/a.ts")}-1-const needle = 1;\n${path.join(ctx.root, "src/a.ts")}:2:const other = 2;`,
    );
    await assert.rejects(ctx.workspace.grep({ pattern: "x", path: "nope" }), /no such file or directory/);

    assert.equal(await ctx.workspace.grep({ pattern: "absent-token" }), "No matches found.");
    await assert.rejects(ctx.workspace.grep({ pattern: "(" }), /regex|unclosed|parse/i);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_grep pages results past the exec output cap", { skip: !hasRg }, async () => {
  const ctx = await setup();
  try {
    const rows = Array.from({ length: 2500 }, (_, i) => `hit ${String(i).padStart(4, "0")} ${"y".repeat(60)}`);
    await fsp.writeFile(path.join(ctx.root, "many.txt"), `${rows.join("\n")}\n`);
    const collected = [];
    let offset = 0;
    for (let guard = 0; guard < 40; guard += 1) {
      const text = await ctx.workspace.grep({ pattern: "^hit", output_mode: "content", head_limit: 1000, offset });
      collected.push(...text.split("\n\n[Showing")[0].split("\n"));
      const next = text.match(/Continue with offset=(\d+)/);
      if (!next) break;
      offset = Number(next[1]);
    }
    assert.equal(collected.length, 2500);
    assert.equal(collected[2499], `${path.join(ctx.root, "many.txt")}:2500:${rows[2499]}`);
    assert.match(
      await ctx.workspace.grep({ pattern: "^hit", output_mode: "content", offset: 9999 }),
      /past the last result \(2500 results\)/,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("remote_glob matches relative to the search path, newest first, paged", { skip: !hasRg }, async () => {
  const ctx = await setup();
  try {
    await seedSearchTree(ctx.root);
    const older = new Date(Date.now() - 60_000);
    await fsp.utimes(path.join(ctx.root, "src/a.ts"), older, older);
    const all = await ctx.workspace.glob({ pattern: "src/**/*.ts" });
    assert.deepEqual(all.split("\n"), [path.join(ctx.root, "src/lib/b.ts"), path.join(ctx.root, "src/a.ts")]);

    const first = await ctx.workspace.glob({ pattern: "*.ts", head_limit: 1 });
    assert.match(first, /\[Showing results 1-1 of 2\. Continue with offset=1\.\]$/);
    assert.equal(await ctx.workspace.glob({ pattern: "*.rs" }), "No files found.");
  } finally {
    await ctx.cleanup();
  }
});

test("remote_grep and remote_glob fall back to grep and bash globs without ripgrep", async () => {
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), "conductor-mcp-norg-"));
  const ctx = await setup({ env: { PATH: await pathWithoutRg(probe) } });
  try {
    await seedSearchTree(ctx.root);
    const files = await ctx.workspace.grep({ pattern: "needle" });
    assert.match(files, /ripgrep is not installed on ubuntu/);
    assert.match(files, /Found 3 files/);

    const counts = await ctx.workspace.grep({ pattern: "needle", output_mode: "count" });
    assert.ok(!counts.includes("notes.md"), "zero counts are filtered like rg does");

    const content = await ctx.workspace.grep({ pattern: "needle", output_mode: "content", glob: "*.js" });
    assert.ok(content.endsWith(`${path.join(ctx.root, "src/c.js")}:1:needle();`), content);

    const globbed = await ctx.workspace.glob({ pattern: "src/*.ts" });
    assert.equal(globbed, path.join(ctx.root, "src/a.ts"));
  } finally {
    await ctx.cleanup();
    await fsp.rm(probe, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// remote_bash
// ---------------------------------------------------------------------------

test("remote_bash runs in the work dir and reports the exit code", async () => {
  const ctx = await setup({ cwdSub: "pkg" });
  try {
    const ok = await ctx.workspace.bash({ command: "pwd; echo err >&2" });
    assert.equal(ok.isError, false);
    assert.equal(ok.text, `${fs.realpathSync(ctx.cwd)}\n[stderr]\nerr\n[exit code 0]`);

    const failed = await ctx.workspace.bash({ command: "exit 3" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /\[exit code 3\]$/);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_bash hands back a run id for a long command and resumes waiting on it", async () => {
  const ctx = await setup();
  try {
    const started = await ctx.workspace.bash({ command: "sleep 1.5; echo finished", timeout_ms: 1000 });
    assert.equal(started.isError, false);
    const runId = started.text.match(/run_id="([^"]+)"/)?.[1];
    assert.ok(runId, started.text);

    const finished = await ctx.workspace.bash({ run_id: runId, timeout_ms: 10_000 });
    assert.equal(finished.text, "finished\n[exit code 0]");
  } finally {
    await ctx.cleanup();
  }
});

test("remote_bash explains a work dir that does not exist yet", async () => {
  const ctx = await setup({ cwdSub: "not-created" });
  try {
    await fsp.rm(ctx.cwd, { recursive: true });
    await assert.rejects(ctx.workspace.bash({ command: "true" }), /worktree has not been created yet/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MCP framing
// ---------------------------------------------------------------------------

function makeServer() {
  const calls = [];
  const tools = buildRemoteWorkspaceTools({
    host: "ubuntu",
    root: "/w",
    cwd: "/w",
    read: async (input) => {
      calls.push(input);
      return "     1\thello";
    },
    edit: async () => {
      throw new Error("old_string was not found in /w/a");
    },
    write: async () => "ok",
    grep: async () => "ok",
    glob: async () => "ok",
    bash: async () => ({ text: "[exit code 1]", isError: true }),
  });
  return { server: createMcpServer({ tools, instructions: "hi" }), calls };
}

test("MCP server negotiates the protocol version and lists the six tools", async () => {
  const { server } = makeServer();
  const init = await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} },
  });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "conductor_remote");
  assert.equal(init.result.instructions, "hi");

  const unknownVersion = await server.handleMessage({
    jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(unknownVersion.result.protocolVersion, "2025-06-18");

  const list = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["remote_read", "remote_edit", "remote_write", "remote_grep", "remote_glob", "remote_bash"],
  );
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal("handler" in tool, false);
  }
});

test("MCP server maps tool results and failures to CallToolResult", async () => {
  const { server, calls } = makeServer();
  const ok = await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remote_read", arguments: { file_path: "a" } },
  });
  assert.deepEqual(ok.result, { content: [{ type: "text", text: "     1\thello" }], isError: false });
  assert.deepEqual(calls, [{ file_path: "a" }]);

  const thrown = await server.handleMessage({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remote_edit", arguments: {} },
  });
  assert.deepEqual(thrown.result, {
    content: [{ type: "text", text: "Error: old_string was not found in /w/a" }],
    isError: true,
  });

  const flagged = await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remote_bash", arguments: {} },
  });
  assert.equal(flagged.result.isError, true);

  const unknown = await server.handleMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" },
  });
  assert.equal(unknown.result.isError, true);
});

test("MCP server answers ping, rejects unknown methods and ignores notifications", async () => {
  const { server } = makeServer();
  assert.deepEqual(await server.handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" }), {
    jsonrpc: "2.0", id: 7, result: {},
  });
  const missing = await server.handleMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  assert.equal(missing.error.code, -32601);
  assert.equal(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await server.handleMessage({ id: 9, method: "ping" })).error.code, -32600);
});

test("serveStdio speaks newline-delimited JSON-RPC and survives garbage lines", async () => {
  const { server } = makeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveStdio(server, { input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  input.write("not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remote_write", arguments: {} } })}\n`);
  input.end();
  await done;
  const lines = output.read().toString().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id).sort(), [1, 2, null].sort());
  assert.equal(lines.find((line) => line.id === null).error.code, -32700);
  assert.equal(lines.find((line) => line.id === 2).result.content[0].text, "ok");
});

test("parseMcpArgs accepts both flag forms and rejects unknown flags", () => {
  assert.deepEqual(parseMcpArgs(["--host", "ubuntu", "--root=/w", "--cwd", "/w/p", "--config-file", "/c.yaml"]), {
    help: false, host: "ubuntu", root: "/w", cwd: "/w/p", configFile: "/c.yaml",
  });
  assert.equal(parseMcpArgs(["-t", "b"]).host, "b");
  assert.throws(() => parseMcpArgs(["--workspace", "/w"]), /unknown option/);
  assert.throws(() => parseMcpArgs(["--root"]), /requires a value/);
});

// ---------------------------------------------------------------------------
// The real process: stdout carries nothing but protocol, and a tool call goes
// through the HTTP client to a (stand-in) backend.
// ---------------------------------------------------------------------------

function startBackend(handlers) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/api/agents/ubuntu/exec") {
      const outcome = await handlers.dispatch({ action: "exec", args: JSON.parse(Buffer.concat(chunks).toString()) });
      return outcome.error ? reply(502, { error: outcome.error }) : reply(200, outcome.result);
    }
    return reply(404, { error: `no route ${req.method} ${req.url}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("`conductor remote mcp` serves real tool calls over stdio with the env token", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conductor-mcp-proc-"));
  const backend = await startBackend(createRemoteExecHandlers({ defaultWorkspace: dir }));
  try {
    await fsp.writeFile(path.join(dir, "hello.txt"), "hello\nworld\n");
    const child = spawn(process.execPath, [REMOTE_SCRIPT, "mcp", "--host", "ubuntu", "--root", dir], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CONDUCTOR_HOME: dir,
        CONDUCTOR_AGENT_TOKEN: "env-token",
        CONDUCTOR_BACKEND_URL: backend.url,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const responses = async (count) => {
      const deadline = Date.now() + 10_000;
      while (stdout.split("\n").filter(Boolean).length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remote_read", arguments: { file_path: "hello.txt" } } });
    const [init, read] = await responses(2);
    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(init.id, 1);
    assert.match(init.result.instructions, new RegExp(`daemon "ubuntu" at ${dir}`));
    assert.deepEqual(read.result, { content: [{ type: "text", text: "     1\thello\n     2\tworld" }], isError: false }, stderr);
    assert.equal(exitCode, 0, stderr);
    assert.ok(backend.requests.length > 0);
    assert.ok(backend.requests.every((request) => request.auth === "Bearer env-token"));
  } finally {
    backend.server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Launch wiring (daemon -> fire -> backend)
// ---------------------------------------------------------------------------

test("resolveRemoteWorktreeBinding uses the same paths as the web bootstrap", () => {
  // Same fixture as web/src/lib/tasks/remote-worktree.test.ts.
  assert.deepEqual(
    resolveRemoteWorktreeBinding({
      remoteWorktree: {
        host: "ubuntu", projectId: "proj-b", repoRoot: "/home/b/ws/conductor",
        workspacePath: "/home/b/ws/conductor", branch: "f8bc83", baseRef: "main",
      },
    }),
    { host: "ubuntu", root: "/home/b/ws/conductor/.conductor/worktrees/f8bc83", cwd: "/home/b/ws/conductor/.conductor/worktrees/f8bc83" },
  );
  // A project inside a monorepo: the worktree hangs under the project, the
  // work dir is the project's offset inside the checked-out repository.
  assert.deepEqual(
    resolveRemoteWorktreeBinding({
      remote_worktree: { host: "b", repo_root: "/r", workspace_path: "/r/apps/web", branch: "feat/x" },
    }),
    { host: "b", root: "/r/apps/web/.conductor/worktrees/feat_x", cwd: "/r/apps/web/.conductor/worktrees/feat_x/apps/web" },
  );
  assert.equal(resolveRemoteWorktreeBinding({ worktree: true }), null);
  assert.equal(resolveRemoteWorktreeBinding({ remoteWorktree: { host: "b" } }), null);
  assert.equal(resolveRemoteWorktreeBinding(null), null);
});

test("the daemon's env round-trips to fire, and ordinary tasks get nothing", () => {
  const launchConfig = { remoteWorktree: { host: "b", repoRoot: "/r", workspacePath: "/r", branch: "abc" } };
  const env = remoteWorktreeFireEnv(launchConfig);
  assert.deepEqual(Object.keys(env), [REMOTE_WORKTREE_ENV]);
  assert.deepEqual(readRemoteWorktreeBinding(env), { host: "b", root: "/r/.conductor/worktrees/abc", cwd: "/r/.conductor/worktrees/abc" });
  assert.deepEqual(remoteWorktreeFireEnv({ cwd: "/x" }), {});
});

test("RFC 0041: a remote project directory (no worktree) binds the tools to the repository", () => {
  assert.deepEqual(
    resolveRemoteWorktreeBinding({
      remoteWorkspace: { host: "b", repoRoot: "/home/b/repo", workspacePath: "/home/b/repo/web" },
    }),
    { host: "b", root: "/home/b/repo", cwd: "/home/b/repo/web" },
  );
  // A remote worktree wins when both are present.
  assert.equal(
    resolveRemoteWorktreeBinding({
      remoteWorktree: { host: "b", repoRoot: "/r", workspacePath: "/r", branch: "abc" },
      remoteWorkspace: { host: "c", repoRoot: "/r", workspacePath: "/r" },
    }).host,
    "b",
  );
  assert.equal(resolveRemoteWorktreeBinding({ remoteWorkspace: { host: "b", repoRoot: "/r" } }), null);
  assert.equal(
    resolveRemoteWorktreeBinding({ remoteWorkspace: { host: "b", repoRoot: "/r", workspacePath: "/elsewhere" } }),
    null,
  );
  assert.ok(remoteWorktreeFireEnv({ remoteWorkspace: { host: "b", repoRoot: "/r", workspacePath: "/r" } }).CONDUCTOR_REMOTE_WORKTREE);
  assert.equal(readRemoteWorktreeBinding({}), null);
  assert.equal(readRemoteWorktreeBinding({ [REMOTE_WORKTREE_ENV]: "" }), null);
  assert.equal(readRemoteWorktreeBinding({ [REMOTE_WORKTREE_ENV]: "{not json" }), null);
});

const binding = { host: "b", root: "/r/.conductor/worktrees/abc", cwd: "/r/.conductor/worktrees/abc/app" };

test("Claude gets an stdio mcpServers entry and an allow rule, merged with the user's", () => {
  const options = buildRemoteWorktreeSessionOptions({
    backend: "Claude",
    binding,
    sessionOptions: { mcpServers: { mine: { command: "x" } }, allowedTools: ["Bash"] },
    execPath: "/usr/bin/node",
    remoteScript: "/cli/bin/conductor-remote.js",
    env: { CONDUCTOR_AGENT_TOKEN: "secret" },
  });
  assert.deepEqual(options, {
    mcpServers: {
      mine: { command: "x" },
      conductor_remote: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/cli/bin/conductor-remote.js", "mcp", "--host", "b", "--root", binding.root, "--cwd", binding.cwd],
      },
    },
    allowedTools: ["Bash", "mcp__conductor_remote"],
  });
  assert.ok(!JSON.stringify(options).includes("secret"), "the token must never reach argv");
});

test("Codex gets -c mcp_servers overrides that forward the token by name only", () => {
  const options = buildRemoteWorktreeSessionOptions({
    backend: "codex",
    binding,
    configFile: "/home/u/.conductor/config-dev.yaml",
    execPath: "/usr/bin/node",
    remoteScript: "/cli/bin/conductor-remote.js",
    env: { CONDUCTOR_AGENT_TOKEN: "secret", CONDUCTOR_BACKEND_URL: "https://x", CONDUCTOR_HOME: "" },
  });
  assert.deepEqual(options.configOverrides, [
    'mcp_servers.conductor_remote.command="/usr/bin/node"',
    `mcp_servers.conductor_remote.args=${JSON.stringify([
      "/cli/bin/conductor-remote.js", "mcp", "--host", "b", "--root", binding.root, "--cwd", binding.cwd,
      "--config-file", "/home/u/.conductor/config-dev.yaml",
    ])}`,
    'mcp_servers.conductor_remote.env_vars=["CONDUCTOR_AGENT_TOKEN","CONDUCTOR_BACKEND_URL"]',
    "mcp_servers.conductor_remote.tool_timeout_sec=900",
  ]);
  assert.ok(!JSON.stringify(options).includes("secret"));
});

test("a permission mode the user chose is not widened by an allow rule", () => {
  const options = buildRemoteWorktreeSessionOptions({
    backend: "claude", binding, sessionOptions: { permissionMode: "default" },
  });
  assert.ok(options.mcpServers.conductor_remote);
  assert.equal(options.allowedTools, undefined);
  // ...including one set on the allow_cli_list command line.
  const fromCommand = buildRemoteWorktreeSessionOptions({
    backend: "claude", binding, commandLine: "claude --model opus --permission-mode plan",
  });
  assert.equal(fromCommand.allowedTools, undefined);
  const bypass = buildRemoteWorktreeSessionOptions({
    backend: "claude", binding, commandLine: "claude --permission-mode=bypassPermissions",
  });
  assert.deepEqual(bypass.allowedTools, ["mcp__conductor_remote"]);
});

test("a relative --config-file is made absolute for the backend's cwd", () => {
  const options = buildRemoteWorktreeSessionOptions({ backend: "claude", binding, configFile: "conf.yaml" });
  const args = options.mcpServers.conductor_remote.args;
  assert.equal(args[args.indexOf("--config-file") + 1], path.resolve("conf.yaml"));
});

test("other backends and ordinary tasks get no MCP options", () => {
  assert.deepEqual(buildRemoteWorktreeSessionOptions({ backend: "kimi", binding }), {});
  assert.deepEqual(buildRemoteWorktreeSessionOptions({ backend: "claude", binding: null }), {});
});

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

test("remote_edit works on a file whose name makes sha256sum escape its output", async () => {
  const ctx = await setup();
  try {
    const file = path.join(ctx.root, "a\\b.txt");
    await fsp.writeFile(file, "old\n");
    await ctx.workspace.edit({ file_path: file, old_string: "old", new_string: "new" });
    assert.equal(await fsp.readFile(file, "utf8"), "new\n");
  } finally {
    await ctx.cleanup();
  }
});

test("remote_write and remote_edit refuse a symlink instead of replacing it", async () => {
  const ctx = await setup();
  try {
    await fsp.writeFile(path.join(ctx.root, "AGENTS.md"), "rules\n");
    await fsp.symlink("AGENTS.md", path.join(ctx.root, "CLAUDE.md"));
    await assert.rejects(ctx.workspace.write({ file_path: "CLAUDE.md", content: "x" }), /is a symlink to AGENTS\.md/);
    await assert.rejects(
      ctx.workspace.edit({ file_path: "CLAUDE.md", old_string: "rules", new_string: "x" }),
      /is a symlink to AGENTS\.md/,
    );
    assert.ok((await fsp.lstat(path.join(ctx.root, "CLAUDE.md"))).isSymbolicLink());
    assert.equal(await fsp.readFile(path.join(ctx.root, "AGENTS.md"), "utf8"), "rules\n");
    assert.equal(ctx.uploads.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("remote_grep keeps its results when one directory is unreadable", { skip: !hasRg || process.getuid?.() === 0 }, async () => {
  const ctx = await setup();
  const locked = path.join(ctx.root, "locked");
  try {
    await fsp.writeFile(path.join(ctx.root, "a.txt"), "needle\n");
    await fsp.mkdir(locked);
    await fsp.chmod(locked, 0o000);
    assert.equal(await ctx.workspace.grep({ pattern: "needle" }), `Found 1 file\n${path.join(ctx.root, "a.txt")}`);
    await assert.rejects(ctx.workspace.grep({ pattern: "(" }), /exited 2/);
  } finally {
    await fsp.chmod(locked, 0o755).catch(() => {});
    await ctx.cleanup();
  }
});

test("remote_glob accepts an absolute pattern under the search path", { skip: !hasRg }, async () => {
  const ctx = await setup();
  try {
    await seedSearchTree(ctx.root);
    assert.equal(await ctx.workspace.glob({ pattern: path.join(ctx.root, "src/*.js") }), path.join(ctx.root, "src/c.js"));
    await assert.rejects(ctx.workspace.glob({ pattern: "/etc/*" }), /is not under/);
  } finally {
    await ctx.cleanup();
  }
});
