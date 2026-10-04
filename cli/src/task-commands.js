/**
 * `conductor task` verbs that mirror the web task UI and have no SDK wrapper.
 *
 * Every verb talks to the same `/api/tasks/...` route the frontend calls, with
 * the same body shape (see web/src/features/tasks/store.ts and
 * web/src/features/chat/components/ChatView.tsx). Kept out of
 * bin/conductor-task.js so that file stays focused on the SDK-backed verbs.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { apiPath, argsError, buildHttp, formatTable, projectLabels, sendOrPreview } from "./backend-http.js";
import { EXIT, buildApis, buildAuditMetadata, printJson, printPretty, resolveProject } from "./entity-helpers.js";

// Destructive mutations (delete / archive) can wait on a daemon round trip.
// restart can wait up to 60s for a daemon ack (refresh-session / reclaim in
// web/src/app/api/tasks/[taskId]/restart/route.ts) and then still spawn a
// successor, so stay well above that: a client-side timeout while the server
// carries on invites a retry that creates a duplicate task.
const TASK_MUTATION_TIMEOUT_MS = 150_000;

const MIME_BY_EXT = {
  ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".log": "text/plain", ".zip": "application/zip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

function taskPath(id, ...rest) {
  return apiPath("tasks", id, ...rest);
}

function taskLine(task) {
  if (!task || typeof task !== "object") return "";
  const status = task.status ? ` [${task.status}]` : "";
  return `${task.id}${status}${task.title ? ` ${task.title}` : ""}`;
}

function print(deps, argv, data, text) {
  if (argv.json) {
    printJson(deps.stdout, data ?? {});
  } else if (text) {
    printPretty(deps.stdout, text);
  }
  return EXIT.OK;
}

function requireYes(argv, what) {
  if (!argv.yes && !argv.dryRun) {
    throw argsError(`${what} is destructive; pass --yes to confirm (or --dry-run to preview)`);
  }
}

function trimmed(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

// ---- lifecycle ------------------------------------------------------------

export async function handleStop(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", taskPath(argv.id), { status: "killed" });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Stopped task ${taskLine(data) || argv.id}`);
}

/** Latest user message id: the reply target of the in-flight turn (what the web Stop button targets). */
async function latestUserMessageId(deps, taskId) {
  const apis = await buildApis(deps);
  const list = await apis.tasks.listTaskMessages(taskId, { limit: 50 });
  const users = (Array.isArray(list) ? list : []).filter((msg) => msg?.role === "user" && msg.id);
  if (users.length === 0) return null;
  const withTime = users.filter((msg) => msg.createdAt || msg.created_at);
  if (withTime.length === users.length) {
    withTime.sort((a, b) => new Date(a.createdAt ?? a.created_at) - new Date(b.createdAt ?? b.created_at));
    return withTime[withTime.length - 1].id;
  }
  return users[users.length - 1].id;
}

export async function handleInterrupt(argv, deps) {
  const http = await buildHttp(deps);
  let target = trimmed(argv.targetReplyTo);
  if (!target && !argv.dryRun) {
    target = await latestUserMessageId(deps, argv.id);
    if (!target) throw argsError("Task has no user message to interrupt; pass --target-reply-to");
  }
  const body = { target_reply_to: target ?? "<latest user message id>" };
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "interrupt"), body);
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Interrupt requested for task ${argv.id} (reply target ${target})`);
}

export async function handleRestart(argv, deps) {
  const body = {};
  if (argv.strategy) body.strategy = argv.strategy;
  if (trimmed(argv.backend)) body.backend_type = trimmed(argv.backend);
  if (argv.refreshSession) body.restart_mode = "refresh_session";
  if (trimmed(argv.daemonHost)) body.agent_host = trimmed(argv.daemonHost);
  if (trimmed(argv.firstMessage)) {
    if (argv.strategy !== "new_task") throw argsError("--first-message requires --strategy new_task");
    body.first_message = trimmed(argv.firstMessage);
  }
  if (argv.refreshSession && argv.strategy) {
    throw argsError("--refresh-session cannot be combined with --strategy");
  }
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "restart"), body, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  const task = data?.task;
  const mode = data?.mode ? ` (${data.mode})` : "";
  const text = task && task.id !== argv.id
    ? `Restarted task ${argv.id} as new task ${taskLine(task)}${mode}`
    : `Restarted task ${argv.id}${mode}`;
  return print(deps, argv, data, text);
}

export async function handleDelete(argv, deps) {
  requireYes(argv, "Deleting a task");
  const http = await buildHttp(deps);
  const query = argv.permanent ? { permanent: "1" } : undefined;
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "DELETE", taskPath(argv.id), undefined, {
    query,
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data ?? { deleted: true, id: argv.id }, `Deleted task ${argv.id}`);
}

export async function handleArchive(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "achieve"), {}, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Archived task ${argv.id}; restore it with \`conductor task unarchive ${argv.id}\``);
}

/**
 * Restore an archived task. Same two steps as the web "Recover" button:
 * `unachieve` only decides the daemon + strategy (409 `daemon_offline` with
 * candidates when the original daemon is gone), then `restart` executes it.
 */
export async function handleUnarchive(argv, deps) {
  const body = trimmed(argv.daemonHost) ? { agent_host: trimmed(argv.daemonHost) } : {};
  const http = await buildHttp(deps);
  if (argv.dryRun) {
    await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "unachieve"), body);
    return EXIT.OK;
  }
  let plan;
  try {
    plan = await http.post(taskPath(argv.id, "unachieve"), body, { timeoutMs: TASK_MUTATION_TIMEOUT_MS });
  } catch (error) {
    const candidates = error?.details?.candidates;
    if (error?.statusCode === 409 && error?.details?.code === "daemon_offline" && Array.isArray(candidates)) {
      const hosts = candidates.map((c) => (typeof c === "string" ? c : c?.host)).filter(Boolean);
      if (hosts.length) {
        error.details = { ...error.details, error: `${error.details.error} Retry with --daemon-host <${hosts.join("|")}>` };
      }
    }
    throw error;
  }
  const backend = trimmed(argv.backend);
  // `unachieve` plans against the task's current backend, so an "inplace" plan
  // becomes a 409 at `restart` once --backend switches it. Drop the strategy in
  // that case and let `restart` pick: inplace on the same backend, new_task on a
  // different one (what the web "create new task" recovery sends).
  const keepStrategy = !(backend && plan?.strategy === "inplace");
  const restartBody = {
    ...(keepStrategy && plan?.strategy ? { strategy: plan.strategy } : {}),
    ...(plan?.agentHost ? { agent_host: plan.agentHost } : {}),
    ...(backend ? { backend_type: backend } : {}),
  };
  const data = await http.post(taskPath(argv.id, "restart"), restartBody, { timeoutMs: TASK_MUTATION_TIMEOUT_MS });
  const task = data?.task;
  const text = task?.id && task.id !== argv.id
    ? `Restored task ${argv.id} as new task ${taskLine(task)} on ${plan?.agentHost ?? "its daemon"}`
    : `Restored task ${argv.id} on ${plan?.agentHost ?? "its daemon"}`;
  return print(deps, argv, { plan, ...data }, text);
}

// ---- attributes -----------------------------------------------------------

export async function handleRename(argv, deps) {
  const title = trimmed(argv.title);
  if (!title) throw argsError("title must not be empty");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", taskPath(argv.id), { title });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Renamed task ${argv.id} to "${title}"`);
}

export async function handlePin(argv, deps, pinned) {
  const http = await buildHttp(deps);
  // The PATCH route merges a metadata object into the existing metadata.
  const body = { metadata: { pinnedAt: pinned ? new Date().toISOString() : null } };
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", taskPath(argv.id), body);
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `${pinned ? "Pinned" : "Unpinned"} task ${argv.id}`);
}

export async function handleMove(argv, deps) {
  let targetId = null;
  if (!argv.back) {
    if (!trimmed(argv.targetProject)) throw argsError("Pass a target project, or --back to file the task under its own project");
    const apis = await buildApis(deps);
    const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.targetProject });
    targetId = project.id;
  } else if (trimmed(argv.targetProject)) {
    throw argsError("Pass either a target project or --back, not both");
  }
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PUT", taskPath(argv.id, "second-project"), {
    second_project_id: targetId,
  });
  if (dryRun) return EXIT.OK;
  return print(
    deps,
    argv,
    data,
    targetId ? `Moved task ${argv.id} to project ${targetId} (display only)` : `Moved task ${argv.id} back to its own project`,
  );
}

export async function handleLabels(argv, deps) {
  const ids = (argv.labelIds || []).map((value) => String(value).trim()).filter(Boolean);
  if (ids.length === 0 && !argv.clear) throw argsError("Pass one or more label ids, or --clear to remove all labels");
  if (ids.length > 0 && argv.clear) throw argsError("Pass label ids or --clear, not both");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PUT", taskPath(argv.id, "labels"), { label_ids: ids });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, ids.length ? `Set labels on task ${argv.id}: ${ids.join(", ")}` : `Cleared labels on task ${argv.id}`);
}

export async function handleShare(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "share"), {});
  if (dryRun) return EXIT.OK;
  const url = data?.token ? `${http.baseUrl}/share/${data.token}` : null;
  return print(deps, argv, url ? { ...data, url } : data, url ? `Share link: ${url}` : `Shared task ${argv.id}`);
}

export async function handleUnshare(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "DELETE", taskPath(argv.id, "share"));
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data ?? { unshared: true }, `Revoked the share link of task ${argv.id}`);
}

/** `abc`, `/share/abc` or `https://host/share/abc` → `abc`. */
export function extractShareToken(input) {
  const raw = trimmed(input);
  if (!raw) throw argsError("share token or link is required");
  const match = raw.match(/\/share\/([^/?#]+)/);
  if (match) return decodeURIComponent(match[1]);
  if (/^[a-z]+:\/\//i.test(raw) || raw.includes("/")) throw argsError(`not a task share link: ${raw}`);
  return raw;
}

/** Read a shared task (what the public /share/<token> page shows). */
export async function handleShared(argv, deps) {
  const token = extractShareToken(argv.token);
  const http = await buildHttp(deps);
  const data = await http.get(apiPath("shared", token));
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const task = data?.task ?? {};
  const header = [`${task.title ?? "(untitled)"}${task.status ? ` [${task.status}]` : ""}`];
  if (task.expiresAt) header.push(`link expires ${task.expiresAt}`);
  printPretty(deps.stdout, header.join(" · "));
  for (const msg of Array.isArray(data?.messages) ? data.messages : []) {
    printPretty(deps.stdout, `[${msg.role || "msg"}] ${String(msg.content ?? "")}`);
  }
  return EXIT.OK;
}

// Mirrors web/src/lib/speech/transcribe.ts (MAX_AUDIO_BYTES, isSupportedAudioType).
const SPEECH_MAX_BYTES = 25 * 1024 * 1024;
const SPEECH_MIME_BY_EXT = { ".wav": "audio/wav", ".mp3": "audio/mpeg" };

/** Speech to text through the same route as the web composer's voice input. */
export async function handleTranscribe(argv, deps) {
  const filePath = path.resolve(deps.cwd || process.cwd(), String(argv.file));
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    stats = null;
  }
  if (!stats || !stats.isFile()) throw argsError(`File not found: ${filePath}`);
  if (stats.size === 0) throw argsError(`File is empty: ${filePath}`);
  if (stats.size > SPEECH_MAX_BYTES) throw argsError(`File is larger than 25 MB: ${filePath}`);
  const name = path.basename(filePath);
  const type = SPEECH_MIME_BY_EXT[path.extname(name).toLowerCase()];
  if (!type) throw argsError("Only .wav and .mp3 audio is supported");
  const http = await buildHttp(deps);
  if (argv.dryRun) {
    return sendOrPreview(http, argv, deps, "POST", apiPath("speech", "transcribe"), {
      file: `<upload ${name}>`,
      ...(trimmed(argv.language) ? { language: trimmed(argv.language) } : {}),
    }).then(() => EXIT.OK);
  }
  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(filePath)], { type }), name);
  if (trimmed(argv.language)) form.set("language", trimmed(argv.language));
  const data = await http.upload(apiPath("speech", "transcribe"), form);
  return print(deps, argv, data, String(data?.text ?? ""));
}

/** Text to speech (the web voice mode's reply voice); saves an .mp3. */
export async function handleSpeak(argv, deps) {
  const text = trimmed(argv.text);
  if (!text) throw argsError("Text is required");
  const http = await buildHttp(deps);
  if (argv.dryRun) {
    return sendOrPreview(http, argv, deps, "POST", apiPath("speech", "synthesize"), { text, format: "mp3" }).then(() => EXIT.OK);
  }
  const response = await http.download(apiPath("speech", "synthesize"), { body: { text, format: "mp3" } });
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // Synthesis failed mid-stream: never save a truncated file as success.
    throw new Error(`Speech synthesis was interrupted: ${error?.message || String(error)}`);
  }
  if (argv.output === "-") {
    deps.stdout.write(bytes);
    return EXIT.OK;
  }
  const target = path.resolve(deps.cwd || process.cwd(), argv.output ? String(argv.output) : "speech.mp3");
  fs.writeFileSync(target, bytes);
  return print(deps, argv, { path: target, bytes: bytes.length }, `Saved ${bytes.length} bytes to ${target}`);
}

// ---- persistent tasks (RFC 0039) -----------------------------------------

export async function handlePersistent(argv, deps) {
  const body = {};
  if (argv.enable && argv.disable) throw argsError("Pass --enable or --disable, not both");
  if (argv.enable) body.enabled = true;
  if (argv.disable) body.enabled = false;
  if (argv.instructions !== undefined) body.instructions = String(argv.instructions);
  if (argv.summary !== undefined) body.summary = String(argv.summary);
  if (Object.keys(body).length === 0) throw argsError("Pass at least one of --enable, --disable, --instructions, --summary");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", taskPath(argv.id, "persistent"), body);
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Updated persistent settings of task ${argv.id}`);
}

export async function handleRoundEnd(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "rounds", "end"), {}, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Ended the current round of task ${argv.id}`);
}

export async function handleRoundStart(argv, deps, readContent) {
  const content = readContent();
  const body = { content };
  if (trimmed(argv.backend)) body.backend_type = trimmed(argv.backend);
  if (trimmed(argv.daemonHost)) body.agent_host = trimmed(argv.daemonHost);
  if (argv.worktree) body.worktree = argv.worktree;
  if (argv.expectedRound !== undefined) body.expected_round = Number(argv.expectedRound);
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "rounds"), body, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  return print(deps, argv, data, `Started a new round on task ${argv.id}`);
}

export async function handleCleanupWorktree(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "worktree"), undefined, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  const removed = data?.removed_path ? ` (${data.removed_path})` : "";
  return print(deps, argv, data, `Removed the worktree of task ${argv.id}${removed}`);
}

// ---- attached PTY terminal ----------------------------------------------

export async function handleTerminal(argv, deps, action) {
  const http = await buildHttp(deps);
  if (action === "show") {
    const data = await http.get(taskPath(argv.id, "terminal"));
    const pty = data?.pty_task ?? null;
    return print(deps, argv, data, `Terminal task ${pty ? taskLine(pty) : data?.pty_task_id ?? "(unknown)"}`);
  }
  const method = action === "open" ? "POST" : "DELETE";
  const { dryRun, data } = await sendOrPreview(http, argv, deps, method, taskPath(argv.id, "terminal"), action === "open" ? {} : undefined, {
    timeoutMs: TASK_MUTATION_TIMEOUT_MS,
  });
  if (dryRun) return EXIT.OK;
  if (action === "open") {
    const ptyId = data?.pty_task_id ?? data?.pty_task?.id;
    return print(deps, argv, data, `Opened terminal for task ${argv.id}${ptyId ? `: PTY task ${ptyId}` : ""}`);
  }
  return print(deps, argv, data ?? { closed: true }, `Closed the terminal of task ${argv.id}`);
}

// ---- messages with attachments -------------------------------------------

function guessMime(fileName) {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

/**
 * Upload each file (phase 1, staged attachment) and return their ids so the
 * message POST can bind them (phase 2) — the same two-step flow as the web
 * composer and `conductor send-file`.
 */
export async function uploadAttachments(http, taskId, files, cwd) {
  const ids = [];
  for (const file of files) {
    const filePath = path.resolve(cwd || process.cwd(), String(file));
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      stats = null;
    }
    if (!stats || !stats.isFile()) throw argsError(`File not found: ${filePath}`);
    const name = path.basename(filePath);
    const form = new FormData();
    form.set("file", new Blob([fs.readFileSync(filePath)], { type: guessMime(name) }), name);
    const result = await http.upload(taskPath(taskId, "attachments"), form);
    const id = result?.attachment?.id;
    if (!id) throw new Error(`Upload of ${name} succeeded but the server returned no attachment id`);
    ids.push(id);
  }
  return ids;
}

export async function handleSendWithAttachments(argv, deps, content, metadata) {
  const files = [].concat(argv.attach || []).filter(Boolean);
  const http = await buildHttp(deps);
  const body = { role: "user", content, metadata };
  if (argv.dryRun) {
    await sendOrPreview(http, argv, deps, "POST", taskPath(argv.id, "messages"), {
      ...body,
      attachmentIds: files.map((file) => `<upload ${file}>`),
    });
    return EXIT.OK;
  }
  const attachmentIds = await uploadAttachments(http, argv.id, files, deps.cwd);
  const data = await http.post(taskPath(argv.id, "messages"), { ...body, attachmentIds });
  return print(deps, argv, data, `Sent message ${data?.id ? `${data.id} ` : ""}with ${attachmentIds.length} attachment(s) to task ${argv.id}`);
}

/** Filename from `Content-Disposition` (RFC 5987 `filename*` first). */
function dispositionFileName(header) {
  const value = String(header || "");
  const star = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

/** Save a message attachment (ids are in `task messages --json` → attachments). */
export async function handleAttachmentDownload(argv, deps) {
  const http = await buildHttp(deps);
  const response = await http.download(taskPath(argv.id, "attachments", argv.attachmentId));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (argv.output === "-") {
    deps.stdout.write(bytes);
    return EXIT.OK;
  }
  const headerName = dispositionFileName(response.headers?.get?.("content-disposition"));
  // basename(): a server-supplied name must never write outside the target dir.
  const fileName = path.basename(headerName || String(argv.attachmentId));
  const cwd = deps.cwd || process.cwd();
  let target = path.resolve(cwd, argv.output ? String(argv.output) : fileName);
  if (argv.output && fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, fileName);
  fs.writeFileSync(target, bytes);
  return print(deps, argv, { path: target, bytes: bytes.length }, `Saved ${bytes.length} bytes to ${target}`);
}

// ---- follow ---------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["completed", "killed", "failed", "stopped", "achieved"]);
const FOLLOW_PAGE_SIZE = 50;
const FOLLOW_MAX_PAGES = 20;

/**
 * Latest messages, oldest first, reaching back with `before` until a page
 * overlaps what was already printed, so a burst of more than one page between
 * polls is not dropped. Bounded so a first poll on a huge task stays cheap.
 */
async function fetchUnseenMessages(apis, taskId, seen) {
  let messages = [];
  for (let page = 0; page < FOLLOW_MAX_PAGES; page += 1) {
    const before = messages[0]?.id;
    const batch = await apis.tasks.listTaskMessages(taskId, { limit: FOLLOW_PAGE_SIZE, ...(before ? { before } : {}) });
    const list = Array.isArray(batch) ? batch : [];
    messages = [...list, ...messages];
    if (list.length < FOLLOW_PAGE_SIZE || seen.size === 0 || list.some((msg) => seen.has(msg?.id))) break;
  }
  return messages;
}

/**
 * Poll new messages until interrupted (or, with --until-idle, until the task
 * leaves a running state). Prints each message once, oldest first.
 */
export async function followMessages(argv, deps, apis, initial) {
  const seen = new Set();
  const emit = (msg) => {
    if (!msg?.id || seen.has(msg.id)) return;
    seen.add(msg.id);
    if (argv.json) {
      printJson(deps.stdout, msg);
    } else {
      printPretty(deps.stdout, `[${msg.role || "msg"}] ${String(msg.content ?? "")}`);
    }
  };
  (initial || []).forEach(emit);
  const intervalMs = Math.max(250, Number(argv.interval ?? 2) * 1000);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxPolls = Number.isFinite(deps.maxFollowPolls) ? deps.maxFollowPolls : Infinity;
  for (let polls = 0; polls < maxPolls; polls += 1) {
    await sleep(intervalMs);
    (await fetchUnseenMessages(apis, argv.id, seen)).forEach(emit);
    if (argv.untilIdle) {
      const task = await apis.tasks.getTask(argv.id);
      const status = (typeof task?.asObject === "function" ? task.asObject() : task)?.status;
      if (status && TERMINAL_STATUSES.has(status)) break;
    }
  }
  return EXIT.OK;
}

// ---- create / resume extras ----------------------------------------------

/** `--agent worker --agent reviewer:codex` → `[{name:"worker"}, {name:"reviewer", backend:"codex"}]`. */
export function parseAgents(values) {
  const list = [].concat(values || []).map((value) => String(value).trim()).filter(Boolean);
  return list.map((entry) => {
    const [name, backend] = entry.split(":").map((part) => part.trim());
    if (!name) throw argsError(`Invalid --agent value: ${entry}`);
    return backend ? { name, backend } : { name };
  });
}

export function parseGlobalBackend(value) {
  const raw = trimmed(value);
  if (!raw) return undefined;
  const index = raw.indexOf(":");
  const host = index > 0 ? raw.slice(0, index).trim() : "";
  const backend = index > 0 ? raw.slice(index + 1).trim() : "";
  if (!host || !backend) throw argsError("--global-backend must look like <host>:<backend>, e.g. l20:claude");
  return { host, backend };
}

/** True when `task create` needs the full frontend payload rather than the SDK subset. */
export function hasExtendedCreateOptions(argv) {
  return Boolean(
    trimmed(argv.daemonHost)
      || (argv.agent && [].concat(argv.agent).length)
      || trimmed(argv.globalBackend)
      || argv.worktree
      || trimmed(argv.remoteWorktree)
      || argv.persistent,
  );
}

export function buildExtendedCreateBody(argv, deps, projectId, title) {
  if (argv.worktree && trimmed(argv.remoteWorktree)) {
    throw argsError("Pass --worktree or --remote-worktree, not both");
  }
  const globalBackend = parseGlobalBackend(argv.globalBackend);
  const agents = parseAgents(argv.agent);
  if (globalBackend && (agents.length || trimmed(argv.daemonHost))) {
    throw argsError("--global-backend cannot be combined with --agent or --daemon-host");
  }
  // Both are rejected by POST /api/tasks; fail before the round trip.
  if (globalBackend && trimmed(argv.remoteWorktree)) {
    throw argsError("--global-backend cannot be combined with --remote-worktree");
  }
  if (globalBackend && trimmed(argv.backend) && trimmed(argv.backend) !== globalBackend.backend) {
    throw argsError(
      `--backend ${trimmed(argv.backend)} does not match --global-backend backend ${globalBackend.backend}; drop --backend`,
    );
  }
  const metadata = buildAuditMetadata(deps.env, argv.persistent ? { persistent: { enabled: true } } : {});
  const body = {
    projectId,
    title,
    taskType: "ai_task",
    ...(argv.prompt !== undefined ? { initialContent: String(argv.prompt) } : {}),
    ...(argv.parentTaskId ? { parentTaskId: String(argv.parentTaskId) } : {}),
    metadata,
  };
  if (globalBackend) {
    body.globalBackend = globalBackend;
    body.backendType = globalBackend.backend;
  } else {
    if (trimmed(argv.daemonHost)) body.agentHost = trimmed(argv.daemonHost);
    if (trimmed(argv.backend)) body.backendType = trimmed(argv.backend);
  }
  if (agents.length) body.agents = agents;
  if (trimmed(argv.remoteWorktree)) body.launchConfig = { remoteWorktree: { host: trimmed(argv.remoteWorktree) } };
  else if (argv.worktree) body.launchConfig = { worktree: true };
  return body;
}

function printCreated(deps, argv, data) {
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created app task ${data?.id}: ${data?.title ?? ""}`);
  const reviewers = data?.reviewer_task_ids ?? data?.reviewerTaskIds;
  if (Array.isArray(reviewers) && reviewers.length) {
    printPretty(deps.stdout, `Reviewer tasks: ${reviewers.join(", ")}`);
  }
  // Same warning as the SDK create path in bin/conductor-task.js.
  const grouping = data?.grouping;
  if (grouping?.grouped === false) {
    const parent = grouping.parentTaskId ?? grouping.parent_task_id;
    printPretty(
      deps.stderr,
      `Warning: ${grouping.warning || `task was not grouped with ${parent}`}. The task itself was created successfully.`,
    );
  }
  return EXIT.OK;
}

export async function handleExtendedCreate(argv, deps, projectId, title) {
  const body = buildExtendedCreateBody(argv, deps, projectId, title);
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("tasks"), body);
  if (dryRun) return EXIT.OK;
  return printCreated(deps, argv, data);
}

/** Resume an existing CLI session (listed by `conductor daemon sessions <host>`) as a new app task. */
export async function handleResume(argv, deps) {
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const sessionId = trimmed(argv.session);
  const host = trimmed(argv.daemonHost);
  const backend = trimmed(argv.backend);
  if (!sessionId || !host || !backend) throw argsError("--session, --daemon-host and --backend are required");
  const body = {
    projectId: project.id,
    title: trimmed(argv.title) || `Resume ${backend} ${sessionId.slice(0, 8)}`,
    taskType: "ai_task",
    backendType: backend,
    agentHost: host,
    sessionId,
    ...(trimmed(argv.sessionFile) ? { sessionFilePath: trimmed(argv.sessionFile) } : {}),
    ...(argv.prompt !== undefined ? { initialContent: String(argv.prompt) } : {}),
    metadata: buildAuditMetadata(deps.env),
  };
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("tasks"), body);
  if (dryRun) return EXIT.OK;
  return printCreated(deps, argv, data);
}

// ---- list across projects -------------------------------------------------

export async function handleMultiProjectList(argv, deps) {
  const http = await buildHttp(deps);
  const query = {};
  if (argv.projectIds) query.project_ids = String(argv.projectIds);
  const data = await http.get(apiPath("tasks"), { query });
  const tasks = Array.isArray(data) ? data : (Array.isArray(data?.tasks) ? data.tasks : []);
  const statuses = argv.status ? new Set(String(argv.status).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const filtered = statuses ? tasks.filter((task) => statuses.has(task.status)) : tasks;
  if (argv.json) {
    printJson(deps.stdout, filtered);
    return EXIT.OK;
  }
  if (filtered.length === 0) {
    printPretty(deps.stdout, "(no tasks)");
    return EXIT.OK;
  }
  const names = await projectLabels(http);
  const projectOf = (task) => {
    const id = task.projectId ?? task.project_id ?? "";
    return String(task.projectName ?? task.project?.name ?? names.get(id) ?? id);
  };
  const rows = filtered.map((task) => [task.id, task.status ?? "", projectOf(task), task.title ?? ""]);
  for (const line of formatTable(["ID", "STATUS", "PROJECT", "TITLE"], rows)) {
    printPretty(deps.stdout, line);
  }
  return EXIT.OK;
}

// ---- scheduled message update -------------------------------------------

export async function handleScheduleUpdate(argv, deps, content, schedule) {
  const body = {};
  if (content !== undefined) body.content = content;
  if (schedule !== undefined) body.schedule = schedule;
  if (Object.keys(body).length === 0) throw argsError("Provide a new message and/or a schedule (--delay, --at, --every)");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "PATCH", taskPath(argv.id, "scheduled-messages", argv.scheduleId), body, { agentActor: true },
  );
  if (dryRun) return EXIT.OK;
  const next = data?.nextRunAt ?? data?.next_run_at;
  return print(deps, argv, data, `Updated scheduled message ${argv.scheduleId}${next ? `; next run ${next}` : ""}`);
}
