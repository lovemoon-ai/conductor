/**
 * `conductor remote mcp` — a stdio MCP server whose tools act on one directory
 * on another daemon's host (RFC 0040).
 *
 * The AI runs on this daemon, the task's worktree lives on `--host`. Without
 * this server the AI reaches it only through `conductor remote exec -- <shell>`:
 * hand-numbered `sed -n` reads, heredoc/`sed -i` edits that are easy to get
 * wrong, `rg` output cut to the last 64 000 characters, and nothing stopping a
 * forgotten `-t/-w` from editing the local checkout instead. Here the target is
 * fixed at startup and the tools have the shape of the native ones.
 *
 * Nothing new runs on the target: reads, searches and shell commands go through
 * `remote exec`, and edits/writes move whole files with `remote cp`'s transfer
 * (exact bytes, no shell quoting, atomic rename on the target).
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createRequire } from "node:module";

import { EXIT, UsageError, loadCliConfig } from "./client.js";
import { execRemote, waitForRun } from "./exec.js";
import { downloadFile, uploadFile } from "./cp.js";
import { MCP_SERVER_NAME } from "./mcp-launch.js";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../../package.json");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** `remote exec` keeps the last 64 000 characters; stay well inside that. */
const OUTPUT_BUDGET_BYTES = 60_000;
const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LINE_CHARS = 2000;
const SEARCH_DEFAULT_LIMIT = 100;
const SEARCH_MAX_LIMIT = 1000;
const FILE_OP_TIMEOUT_MS = 120_000;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_FILE_MODE = 0o644;

/** A failure the AI should see as a tool error, not a protocol error. */
export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Remote scripts. Arguments are always passed as positional parameters
// (`bash -c <script> conductor-mcp <args...>`), never interpolated, so no
// path or pattern is ever re-parsed by a shell.
// ---------------------------------------------------------------------------

const READ_SCRIPT = `f=$1; start=$2; end=$3; budget=$4
if [ -d "$f" ]; then echo "is a directory: $f" >&2; exit 21; fi
if [ ! -e "$f" ]; then echo "no such file: $f" >&2; exit 2; fi
if [ ! -r "$f" ]; then echo "permission denied: $f" >&2; exit 13; fi
awk 'END { print NR }' "$f" || exit $?
sed -n "\${start},\${end}p" "$f" | head -c "$budget"`;

/**
 * A symlink is refused rather than followed: the daemon's upload renames over
 * the link itself, which would silently turn it into a regular file.
 */
const SYMLINK_CHECK = `if [ -L "$1" ]; then echo "$1 is a symlink to $(readlink "$1"); edit the target instead" >&2; exit 40; fi`;

/** Hash via stdin: given a file name, GNU sha256sum escapes odd names with a leading "\\". */
const HASH_SCRIPT = `${SYMLINK_CHECK}
if command -v sha256sum >/dev/null 2>&1; then sha256sum <"$1"; else shasum -a 256 <"$1"; fi`;

/** Makes the parent directory and reports the current mode, if the file exists. */
const PREPARE_WRITE_SCRIPT = `${SYMLINK_CHECK}
f=$1
if [ -d "$f" ]; then echo "is a directory: $f" >&2; exit 21; fi
mkdir -p "$(dirname "$f")" || exit $?
if [ -e "$f" ]; then stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f"; fi`;

/**
 * Runs "$@" on `target` into a temp file, prints "<d|f> <line count>", then one
 * page of it. The search runs from inside the target directory (or a file's
 * parent) on a relative path, because that is the only way ripgrep anchors a
 * glob like `src/**\/*.ts`; the caller turns the relative paths back into
 * absolute ones. Every page re-runs the command, so paging relies on each
 * caller asking for a deterministic order (`--sort`/`--sortr`).
 */
const PAGE_SCRIPT = `off=$1; lim=$2; budget=$3; nozero=$4; target=$5; shift 5
if [ -d "$target" ]; then cd "$target" || exit 2; rel=.; kind=d
elif [ -e "$target" ]; then cd "$(dirname "$target")" || exit 2; rel=$(basename "$target"); kind=f
else echo "no such file or directory: $target" >&2; exit 2; fi
tmp=$(mktemp "\${TMPDIR:-/tmp}/conductor-mcp.XXXXXX") || exit 125
trap 'rm -f "$tmp" "$tmp.f"' EXIT
"$@" "$rel" >"$tmp"; code=$?
if [ "$code" -gt 1 ] && [ ! -s "$tmp" ]; then exit "$code"; fi
if [ "$nozero" = 1 ]; then grep -v ':0$' "$tmp" >"$tmp.f"; mv "$tmp.f" "$tmp"; fi
echo "$kind $(wc -l <"$tmp" | tr -d ' ')"
tail -n "+$((off + 1))" "$tmp" | head -n "$lim" | head -c "$budget"`;

/** Fallback for `remote_glob` on a host without ripgrep: `$1` pattern, `$2` dir. */
const GLOB_FALLBACK_SCRIPT = `cd "$2" || exit 2
shopt -s globstar nullglob dotglob 2>/dev/null
IFS=$'\\n'
for f in $1; do [ -f "$f" ] && printf '%s/%s\\n' "$PWD" "$f"; done
exit 0`;

const TOOLS_SCRIPT = `command -v rg >/dev/null 2>&1 && echo rg || echo grep`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isWindowsStylePath = (value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Split a page of output into whole lines, dropping a line cut by the byte budget. */
function splitPage(text, budget) {
  const hitBudget = Buffer.byteLength(text) >= budget - 3;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  } else if (hitBudget && lines.length > 1) {
    lines.pop();
  }
  return lines;
}

function splitHeader(stdout) {
  const newline = stdout.indexOf("\n");
  if (newline === -1) return { header: stdout.trim(), body: "" };
  return { header: stdout.slice(0, newline).trim(), body: stdout.slice(newline + 1) };
}

function formatNumbered(lines, firstLine) {
  return lines
    .map((line, index) => {
      const shown = line.length > READ_MAX_LINE_CHARS
        ? `${line.slice(0, READ_MAX_LINE_CHARS)}… [line truncated]`
        : line;
      return `${String(firstLine + index).padStart(6)}\t${shown}`;
    })
    .join("\n");
}

function toInteger(value, name, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) {
    throw new ToolError(`${name} must be an integer${max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`}`);
  }
  return number;
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    throw new ToolError(`${name} is required`);
  }
  return value;
}

function runFailure(run, what) {
  const detail = (run?.stderrTail || run?.error || run?.stdoutTail || "").trim();
  const status = run?.status === "running"
    ? "timed out"
    : `exited ${run?.exitCode ?? run?.status ?? "?"}`;
  return new ToolError(detail ? `${what} failed (${status}): ${detail}` : `${what} failed (${status})`);
}

// ---------------------------------------------------------------------------
// The workspace: every tool's behaviour, independent of MCP framing.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.host   daemon the workspace lives on
 * @param {string} opts.root   no tool may touch a path outside this directory
 * @param {string} [opts.cwd]  relative paths resolve here (default: root)
 * @param {(req: {command: string, args: string[], workspace?: string, timeoutMs: number}) => Promise<object>} opts.exec
 *        run one command on the host; resolves with the run record
 * @param {(runId: string, timeoutMs: number) => Promise<object>} opts.wait
 *        keep waiting for a run `exec` returned while still running
 * @param {(remotePath: string, localPath: string) => Promise<{sha256: string, mode?: number}>} opts.download
 * @param {(localPath: string, remotePath: string) => Promise<unknown>} opts.upload
 *        replaces the remote file atomically, with the local file's mode
 */
export function createRemoteWorkspace(opts) {
  const { host, exec, wait, download, upload } = opts;
  const pathApi = isWindowsStylePath(opts.root) ? path.win32 : path.posix;
  const root = pathApi.normalize(opts.root);
  const cwd = pathApi.normalize(opts.cwd || opts.root);
  const tmpRoot = opts.tmpDir || os.tmpdir();
  let searchTool = null;

  function resolvePath(value, name = "file_path") {
    const raw = requireString(value, name).trim();
    const absolute = pathApi.isAbsolute(raw) ? pathApi.normalize(raw) : pathApi.join(cwd, raw);
    const relative = pathApi.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
      throw new ToolError(`${raw} is outside the remote workspace ${root} on ${host}`);
    }
    return absolute;
  }

  async function runScript(script, args, { what, timeoutMs = FILE_OP_TIMEOUT_MS, okCodes = [0] } = {}) {
    const run = await exec({ command: "bash", args: ["-c", script, "conductor-mcp", ...args.map(String)], timeoutMs });
    if (run?.status !== "completed" || !okCodes.includes(run.exitCode)) {
      throw runFailure(run, what);
    }
    return run;
  }

  async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(tmpRoot, "conductor-mcp-"));
    try {
      return await fn(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function remoteSha256(file) {
    const run = await runScript(HASH_SCRIPT, [file], { what: `hashing ${file}` });
    return String(run.stdoutTail || "").trim().split(/\s+/)[0] || "";
  }

  async function read({ file_path: filePath, offset, limit } = {}) {
    const file = resolvePath(filePath);
    const start = toInteger(offset, "offset", { min: 1, fallback: 1 });
    const count = toInteger(limit, "limit", { min: 1, fallback: READ_DEFAULT_LIMIT });
    const run = await runScript(READ_SCRIPT, [file, start, start + count - 1, OUTPUT_BUDGET_BYTES], {
      what: `reading ${file}`,
    });
    const { header, body } = splitHeader(String(run.stdoutTail || ""));
    const total = Number.parseInt(header, 10) || 0;
    if (total === 0) return `(${file} is empty)`;
    if (start > total) {
      throw new ToolError(`offset ${start} is past the end of ${file} (${total} lines)`);
    }
    if (body.includes("\u0000")) {
      throw new ToolError(`${file} looks like a binary file; use remote_bash to inspect it`);
    }
    const lines = splitPage(body, OUTPUT_BUDGET_BYTES);
    const last = start + lines.length - 1;
    let text = formatNumbered(lines, start);
    if (last < total) {
      text += `\n\n[Showing lines ${start}-${last} of ${total}. Continue with offset=${last + 1}.]`;
    }
    return text;
  }

  async function edit({ file_path: filePath, old_string: oldRaw, new_string: newRaw, replace_all: replaceAll } = {}) {
    const file = resolvePath(filePath);
    let oldString = requireString(oldRaw, "old_string", { allowEmpty: true });
    let newString = requireString(newRaw, "new_string", { allowEmpty: true });
    if (oldString === "") {
      throw new ToolError("old_string must not be empty; use remote_write to create or overwrite a file");
    }
    if (oldString === newString) {
      throw new ToolError("old_string and new_string are identical; nothing to change");
    }

    return withTempDir(async (dir) => {
      const local = path.join(dir, "file");
      const original = await download(file, local);
      const bytes = await fsp.readFile(local);
      if (bytes.includes(0)) {
        throw new ToolError(`${file} looks like a binary file; refusing to edit it`);
      }
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        throw new ToolError(`${file} is not valid UTF-8; refusing to edit it`);
      }

      let matches = countOccurrences(text, oldString);
      // A CRLF file edited with LF snippets: match the file's own line endings.
      if (matches === 0 && text.includes("\r\n") && oldString.includes("\n") && !oldString.includes("\r\n")) {
        const crlf = (value) => value.replace(/\r?\n/g, "\r\n");
        oldString = crlf(oldString);
        newString = crlf(newString);
        matches = countOccurrences(text, oldString);
      }
      if (matches === 0) {
        throw new ToolError(`old_string was not found in ${file}`);
      }
      if (matches > 1 && replaceAll !== true) {
        throw new ToolError(
          `old_string matches ${matches} places in ${file}; add surrounding context to make it unique, or set replace_all`,
        );
      }

      const firstIndex = text.indexOf(oldString);
      const updated = replaceAll === true
        ? text.split(oldString).join(newString)
        : text.slice(0, firstIndex) + newString + text.slice(firstIndex + oldString.length);
      await fsp.writeFile(local, updated);

      // Optimistic concurrency: refuse to overwrite a change made since we read.
      const current = await remoteSha256(file);
      if (current !== original.sha256) {
        throw new ToolError(`${file} changed on ${host} while it was being edited; read it again and retry`);
      }
      await fsp.chmod(local, Number.isInteger(original.mode) ? original.mode : DEFAULT_FILE_MODE);
      await upload(local, file);

      const replaced = replaceAll === true ? matches : 1;
      const firstLine = text.slice(0, firstIndex).split("\n").length;
      const updatedLines = updated.split("\n");
      if (updated.endsWith("\n")) updatedLines.pop();
      const from = Math.max(1, firstLine - 3);
      const to = Math.min(updatedLines.length, firstLine + newString.split("\n").length + 2);
      return (
        `Edited ${file} on ${host}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.\n` +
        formatNumbered(updatedLines.slice(from - 1, to), from)
      );
    });
  }

  async function write({ file_path: filePath, content } = {}) {
    const file = resolvePath(filePath);
    const body = requireString(content, "content", { allowEmpty: true });
    const prepared = await runScript(PREPARE_WRITE_SCRIPT, [file], { what: `preparing ${file}` });
    const modeText = String(prepared.stdoutTail || "").trim();
    const existed = /^[0-7]{3,4}$/.test(modeText);
    const mode = existed ? Number.parseInt(modeText, 8) & 0o777 : DEFAULT_FILE_MODE;

    return withTempDir(async (dir) => {
      const local = path.join(dir, "file");
      await fsp.writeFile(local, body);
      await fsp.chmod(local, mode);
      await upload(local, file);
      return `${existed ? "Updated" : "Created"} ${file} on ${host} (${Buffer.byteLength(body)} bytes).`;
    });
  }

  async function resolveSearchTool() {
    if (!searchTool) {
      searchTool = runScript(TOOLS_SCRIPT, [], { what: "probing for ripgrep" })
        .then((run) => (String(run.stdoutTail || "").trim() === "rg" ? "rg" : "grep"))
        .catch((error) => {
          searchTool = null;
          throw error;
        });
    }
    return searchTool;
  }

  /** Run a search command on `target` and return one page, with absolute paths. */
  async function page(command, { target, offset, limit, nozero = false }) {
    const run = await runScript(
      PAGE_SCRIPT,
      [offset, limit, OUTPUT_BUDGET_BYTES, nozero ? 1 : 0, target, ...command],
      { what: `searching ${target}` },
    );
    const { header, body } = splitHeader(String(run.stdoutTail || ""));
    const [kind, count] = header.split(" ");
    const total = Number.parseInt(count, 10) || 0;
    const dir = kind === "f" ? pathApi.dirname(target) : target;
    const prefix = dir.endsWith(pathApi.sep) ? dir : `${dir}${pathApi.sep}`;
    // `--` separates context groups; everything else starts with a path that
    // is relative to `dir` (`./x` from GNU tools and rg, bare `x` from BSD grep).
    const lines = (total > offset ? splitPage(body, OUTPUT_BUDGET_BYTES) : [])
      .map((line) => (line === "--" || pathApi.isAbsolute(line) ? line : prefix + line.replace(/^\.\//, "")));
    return { total, lines };
  }

  function pageFooter(offset, shown, total) {
    if (offset + shown >= total) return "";
    return `\n\n[Showing results ${offset + 1}-${offset + shown} of ${total}. Continue with offset=${offset + shown}.]`;
  }

  async function grep(input = {}) {
    const pattern = requireString(input.pattern, "pattern");
    const searchPath = input.path === undefined ? cwd : resolvePath(input.path, "path");
    const mode = input.output_mode ?? "files_with_matches";
    if (!["files_with_matches", "content", "count"].includes(mode)) {
      throw new ToolError("output_mode must be one of files_with_matches, content, count");
    }
    const offset = toInteger(input.offset, "offset", { min: 0, fallback: 0 });
    const limit = toInteger(input.head_limit, "head_limit", { min: 1, max: SEARCH_MAX_LIMIT, fallback: SEARCH_DEFAULT_LIMIT });
    const context = toInteger(input.context, "context", { min: 0, max: 20, fallback: 0 });
    const tool = await resolveSearchTool();

    let command;
    const notes = [];
    if (tool === "rg") {
      command = ["rg", "--color=never", "--no-messages", "--hidden", "--glob", "!.git"];
      if (mode === "files_with_matches") command.push("--files-with-matches", "--sortr=modified");
      if (mode === "count") command.push("--count", "--with-filename", "--sort=path");
      if (mode === "content") {
        command.push("--line-number", "--with-filename", "--no-heading", "--max-columns=500", "--max-columns-preview", "--sort=path");
        if (context > 0) command.push("--context", String(context));
      }
      if (input.case_insensitive === true) command.push("--ignore-case");
      if (input.glob) command.push("--glob", requireString(input.glob, "glob"));
      if (input.type) command.push("--type", requireString(input.type, "type"));
      command.push("-e", pattern, "--");
    } else {
      notes.push(`[ripgrep is not installed on ${host}; used grep -E, which ignores .gitignore]`);
      command = ["grep", "-r", "-I", "-E", "--exclude-dir=.git"];
      if (mode === "files_with_matches") command.push("-l");
      if (mode === "count") command.push("-c", "-H");
      if (mode === "content") {
        command.push("-n", "-H");
        if (context > 0) command.push("-C", String(context));
      }
      if (input.case_insensitive === true) command.push("-i");
      if (input.glob) command.push(`--include=${requireString(input.glob, "glob")}`);
      if (input.type) notes.push("[type is not supported without ripgrep and was ignored]");
      command.push("-e", pattern, "--");
    }

    const { total, lines } = await page(command, {
      target: searchPath, offset, limit, nozero: tool === "grep" && mode === "count",
    });
    const prefix = notes.length > 0 ? `${notes.join("\n")}\n` : "";
    if (total === 0) return `${prefix}No matches found.`;
    if (lines.length === 0) return `${prefix}offset ${offset} is past the last result (${total} results).`;
    const heading = mode === "files_with_matches" ? `Found ${total} file${total === 1 ? "" : "s"}\n` : "";
    return `${prefix}${heading}${lines.join("\n")}${pageFooter(offset, lines.length, total)}`;
  }

  async function glob(input = {}) {
    const searchPath = input.path === undefined ? cwd : resolvePath(input.path, "path");
    let pattern = requireString(input.pattern, "pattern");
    // Globs match relative to the search path, so an absolute one never would.
    if (pathApi.isAbsolute(pattern)) {
      const relative = pathApi.relative(searchPath, pattern);
      if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
        throw new ToolError(`pattern ${pattern} is not under ${searchPath}`);
      }
      pattern = relative;
    }
    const offset = toInteger(input.offset, "offset", { min: 0, fallback: 0 });
    const limit = toInteger(input.head_limit, "head_limit", { min: 1, max: SEARCH_MAX_LIMIT, fallback: SEARCH_DEFAULT_LIMIT });
    const tool = await resolveSearchTool();
    const command = tool === "rg"
      ? ["rg", "--files", "--hidden", "--glob", "!.git", "--glob", pattern, "--sortr=modified", "--color=never", "--"]
      : ["bash", "-c", GLOB_FALLBACK_SCRIPT, "conductor-mcp-glob", pattern];
    const { total, lines } = await page(command, { target: searchPath, offset, limit });
    if (total === 0) return "No files found.";
    if (lines.length === 0) return `offset ${offset} is past the last result (${total} files).`;
    return `${lines.join("\n")}${pageFooter(offset, lines.length, total)}`;
  }

  async function bash(input = {}) {
    const timeoutMs = toInteger(input.timeout_ms, "timeout_ms", {
      min: 1000, max: BASH_MAX_TIMEOUT_MS, fallback: BASH_DEFAULT_TIMEOUT_MS,
    });
    let run;
    if (input.run_id !== undefined) {
      run = await wait(requireString(input.run_id, "run_id"), timeoutMs);
    } else {
      const command = requireString(input.command, "command");
      try {
        run = await exec({ command: "bash", args: ["-lc", command], workspace: cwd, timeoutMs });
      } catch (error) {
        throw new ToolError(
          `${error.message} (remote_bash runs in ${cwd} on ${host}; if the task worktree has not been created yet, create it first)`,
        );
      }
    }

    const parts = [];
    if (run?.stdoutTail) parts.push(run.stdoutTail.replace(/\n$/, ""));
    if (run?.stderrTail) parts.push(`[stderr]\n${run.stderrTail.replace(/\n$/, "")}`);
    if (run?.truncated) parts.push("[output truncated; showing the tail only]");
    if (run?.error) parts.push(`[error] ${run.error}`);
    if (run?.status === "running") {
      parts.push(
        `[still running on ${host} after ${Math.round(timeoutMs / 1000)}s; ` +
          `call remote_bash with run_id="${run.runId}" to keep waiting]`,
      );
      return { text: parts.join("\n"), isError: false };
    }
    const exitCode = typeof run?.exitCode === "number" ? run.exitCode : null;
    parts.push(`[exit code ${exitCode ?? run?.status ?? "unknown"}]`);
    return { text: parts.join("\n"), isError: exitCode !== 0 };
  }

  return { host, root, cwd, resolvePath, read, edit, write, grep, glob, bash };
}

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

export function buildRemoteWorkspaceTools(workspace) {
  const where = `on daemon "${workspace.host}"`;
  const pathNote = `Relative paths resolve against ${workspace.cwd}; paths outside ${workspace.root} are refused.`;
  return [
    {
      name: "remote_read",
      description: `Read a file in the remote workspace ${where}, with line numbers (cat -n format). ${pathNote}`,
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File to read" },
          offset: { type: "integer", minimum: 1, description: "Line number to start at (default 1)" },
          limit: { type: "integer", minimum: 1, description: `Number of lines to read (default ${READ_DEFAULT_LIMIT})` },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
      handler: workspace.read,
    },
    {
      name: "remote_edit",
      description:
        `Replace an exact string in a file in the remote workspace ${where}. Fails without writing if ` +
        `old_string is missing or matches more than once (unless replace_all). ${pathNote}`,
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File to edit" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false,
      },
      handler: workspace.edit,
    },
    {
      name: "remote_write",
      description: `Create or overwrite a file in the remote workspace ${where}; parent directories are created. ${pathNote}`,
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File to write" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
      handler: workspace.write,
    },
    {
      name: "remote_grep",
      description:
        `Search file contents in the remote workspace ${where} with ripgrep regex syntax. ` +
        `Results are paged: pass offset to continue. ${pathNote}`,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression" },
          path: { type: "string", description: "File or directory to search (default: the work dir)" },
          glob: { type: "string", description: 'Only files matching this glob, e.g. "*.ts"' },
          type: { type: "string", description: 'ripgrep file type, e.g. "js", "py"' },
          output_mode: {
            type: "string",
            enum: ["files_with_matches", "content", "count"],
            description: "files_with_matches (default), content (matching lines), or count",
          },
          case_insensitive: { type: "boolean" },
          context: { type: "integer", minimum: 0, maximum: 20, description: "Lines of context in content mode" },
          offset: { type: "integer", minimum: 0, description: "Results to skip (default 0)" },
          head_limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, description: `Results per page (default ${SEARCH_DEFAULT_LIMIT})` },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      handler: workspace.grep,
    },
    {
      name: "remote_glob",
      description: `Find files by glob pattern (e.g. "src/**/*.ts") in the remote workspace ${where}, newest first. ${pathNote}`,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search (default: the work dir)" },
          offset: { type: "integer", minimum: 0, description: "Results to skip (default 0)" },
          head_limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, description: `Results per page (default ${SEARCH_DEFAULT_LIMIT})` },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      handler: workspace.glob,
    },
    {
      name: "remote_bash",
      description:
        `Run a bash command in ${workspace.cwd} ${where} (git, builds, tests). Output keeps the last 64 000 ` +
        `characters. A command still running at timeout_ms keeps going; call again with the returned run_id to wait more.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run with bash -lc" },
          timeout_ms: {
            type: "integer",
            minimum: 1000,
            maximum: BASH_MAX_TIMEOUT_MS,
            description: `How long to wait (default ${BASH_DEFAULT_TIMEOUT_MS})`,
          },
          run_id: { type: "string", description: "Keep waiting for a command that was still running" },
        },
        additionalProperties: false,
      },
      handler: workspace.bash,
    },
  ];
}

export function buildServerInstructions(workspace) {
  return (
    `The task workspace lives on daemon "${workspace.host}" at ${workspace.cwd}, not on this machine. ` +
    "Use these remote_* tools to read, edit, write and search files there, and remote_bash for git, builds and tests. " +
    "Local file tools and local shell commands do not see that workspace."
  );
}

// ---------------------------------------------------------------------------
// MCP framing (JSON-RPC 2.0 over newline-delimited stdio)
// ---------------------------------------------------------------------------

export function createMcpServer({ tools, instructions, name = MCP_SERVER_NAME, version = CLI_VERSION }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function callTool(params) {
    const tool = byName.get(params?.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${params?.name}` }], isError: true };
    }
    try {
      const output = await tool.handler(params?.arguments ?? {});
      const { text, isError = false } = typeof output === "string" ? { text: output } : output;
      return { content: [{ type: "text", text }], isError };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })),
        };
      case "tools/call":
        return callTool(params);
      default: {
        const error = new Error(`method not found: ${method}`);
        error.code = -32601;
        throw error;
      }
    }
  }

  /** Returns the response to write, or null for a notification. */
  async function handleMessage(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message && typeof message === "object" && ("result" in message || "error" in message)) {
        return null; // a response to a request we never send
      }
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "invalid request" } };
    }
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) return null;
    try {
      return { jsonrpc: "2.0", id: message.id, result: await dispatch(message.method, message.params) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: typeof error?.code === "number" ? error.code : -32603, message: error?.message || String(error) },
      };
    }
  }

  return { handleMessage };
}

/** Serve until `input` ends. Requests run concurrently; responses go out as they finish. */
export async function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const inFlight = new Set();
  const send = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const pending = server.handleMessage(message).then(send, (error) => {
      send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(error?.message || error) } });
    });
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending));
  }
  await Promise.allSettled([...inFlight]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Map([
  ["--host", "host"],
  ["--target", "host"],
  ["-t", "host"],
  ["--root", "root"],
  ["--cwd", "cwd"],
  ["--config-file", "configFile"],
]);

export function parseMcpArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    const splitAt = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = splitAt > 0 ? token.slice(0, splitAt) : token;
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`unknown option: ${token}`);
    }
    const value = splitAt > 0 ? token.slice(splitAt + 1) : argv[index + 1];
    if (value === undefined || value === "") {
      throw new UsageError(`${name} requires a value`);
    }
    options[VALUE_FLAGS.get(name)] = value;
    if (splitAt <= 0) index += 1;
  }
  return options;
}

export function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor remote mcp - serve MCP tools bound to a directory on another daemon

Usage:
  conductor remote mcp --host <daemon> --root <dir> [--cwd <dir>] [--config-file <path>]

Options:
  -t, --host <daemon>     Daemon the workspace lives on (required)
      --root <dir>        Absolute directory on that daemon; no tool may leave it (required)
      --cwd <dir>         Where relative paths and remote_bash run (default: --root)
      --config-file <p>   Conductor config file to authenticate with
  -h, --help              Show this help

Speaks MCP over stdin/stdout. Tools: remote_read, remote_edit, remote_write,
remote_grep, remote_glob, remote_bash. Fire starts it automatically for tasks
whose worktree lives on another daemon.
`);
}

export async function runRemoteMcp(argv, deps = {}) {
  const consoleImpl = deps.console || console;
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;

  let options;
  try {
    options = parseMcpArgs(argv);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }
  if (options.help) {
    // stdout is the protocol channel only when serving; help is fine there.
    showHelp(consoleImpl);
    return EXIT.OK;
  }

  const host = typeof options.host === "string" ? options.host.trim() : "";
  const root = typeof options.root === "string" ? options.root.trim() : "";
  if (!host || !root) {
    consoleImpl.error("Error: --host <daemon> and --root <dir> are required");
    return EXIT.CLI_ERROR;
  }
  const pathApi = isWindowsStylePath(root) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(root) || (options.cwd && !pathApi.isAbsolute(options.cwd))) {
    consoleImpl.error("Error: --root and --cwd must be absolute paths on the target");
    return EXIT.CLI_ERROR;
  }
  if (options.cwd) {
    const relative = pathApi.relative(pathApi.normalize(root), pathApi.normalize(options.cwd));
    if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
      consoleImpl.error("Error: --cwd must be inside --root");
      return EXIT.CLI_ERROR;
    }
  }

  let config;
  try {
    config = deps.config || loadCliConfig(options.configFile, env);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  // Everything below must stay off stdout: it is the MCP channel.
  const quietConsole = { log: () => {}, error: () => {} };
  const basePath = `/api/agents/${encodeURIComponent(host)}/exec`;
  const workspace = createRemoteWorkspace({
    host,
    root,
    cwd: options.cwd,
    exec: async ({ command, args, workspace: dir, timeoutMs }) =>
      (await execRemote(config, host, command, { args, workspace: dir, timeoutMs, fetchImpl })).run,
    wait: async (runId, timeoutMs) =>
      (await waitForRun(config, basePath, { runId, status: "running" }, {
        deadline: Date.now() + timeoutMs, fetchImpl,
      })).run,
    download: (remotePath, localPath) =>
      downloadFile({
        config, target: host, remotePath, localPath, fetchImpl, consoleImpl: quietConsole, quiet: true,
        deadline: Date.now() + FILE_OP_TIMEOUT_MS, onProgress: () => {},
      }),
    upload: (localPath, remotePath) =>
      uploadFile({
        config, target: host, localPath, remotePath, fetchImpl, consoleImpl: quietConsole, quiet: true,
        env, deadline: Date.now() + FILE_OP_TIMEOUT_MS, onProgress: () => {},
      }),
  });

  const server = createMcpServer({
    tools: buildRemoteWorkspaceTools(workspace),
    instructions: buildServerInstructions(workspace),
  });
  await serveStdio(server, { input: deps.stdin || process.stdin, output: deps.stdout || process.stdout });
  return EXIT.OK;
}
