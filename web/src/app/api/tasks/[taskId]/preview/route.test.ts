import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { GET } from "@/app/api/preview/[token]/[...path]/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";
import {
  PREVIEW_IDLE_TTL_MS,
  PREVIEW_MAX_TTL_MS,
  pruneExpiredPreviews,
  resetPreviewStoreForTests,
} from "@/lib/previews/preview-store";
import {
  createTransfer,
  remoteFileReservedBytesForTests,
  resetTransferStoreForTests,
  updateTransfer,
  writeTransferContent,
} from "@/lib/transfers/transfer-store";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { task: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: { getAgentsForUser: vi.fn() },
}));

vi.mock("@/lib/realtime/remote-file", () => ({
  requestRemoteFile: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestRemoteFile } = await import("@/lib/realtime/remote-file");

const ROOT = "/home/dev/ws/report";
/** The daemon's disk, as far as these tests are concerned. */
const DISK: Record<string, string> = {
  [`${ROOT}/index.html`]: "<script src=app.js></script>",
  [`${ROOT}/assets/app.js`]: "console.log(1)",
  [`${ROOT}/notes.md`]: "# notes",
  [`${ROOT}/demo.mp4`]: "0123456789",
  [`${ROOT}/shot.png`]: "png-bytes",
};

/** A daemon that stats and pushes out of `DISK`, staging bytes like the real one. */
function useDaemon() {
  vi.mocked(requestRemoteFile).mockImplementation(async ({ action, args }: any) => {
    if (action === "stat") {
      const realPath = args.remotePath.startsWith("/") ? args.remotePath : `${ROOT}/${args.remotePath}`;
      const body = DISK[realPath];
      return {
        ok: true,
        action,
        result:
          body === undefined
            ? { exists: false, realPath: null }
            : { exists: true, isFile: true, sizeBytes: body.length, realPath },
      };
    }
    const body = DISK[args.remotePath];
    if (body === undefined) {
      return { ok: false, reason: "remote_error", message: `no such file: ${args.remotePath}` };
    }
    // What `PUT /api/agent/files/{id}/content` does with the daemon's upload.
    const written = await writeTransferContent(args.transferId, Readable.from(Buffer.from(body)), {
      maxBytes: args.maxBytes,
    });
    updateTransfer(args.transferId, { status: "uploaded", sizeBytes: written.sizeBytes, sha256: written.sha256 });
    return { ok: true, action, result: {} };
  });
}

const taskParams = { params: Promise.resolve({ taskId: "task-1" }) };
const open = (filePath: string) =>
  POST(
    createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/preview", body: { path: filePath } }),
    taskParams,
  );
const fetchFile = (token: string, relativePath: string, headers: Record<string, string> = {}) =>
  GET(createMockRequest({ url: `http://localhost:6152/api/preview/${token}/${relativePath}`, headers }), {
    params: Promise.resolve({ token, path: relativePath.split("/") }),
  });

let storageRoot = "";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  await resetPreviewStoreForTests();
  resetTransferStoreForTests();
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-preview-route-"));
  process.env.CONDUCTOR_FILE_STORAGE_DIR = storageRoot;
  vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: "user-1" } as any);
  // A daemon-run task: once it starts, `executionHost` is its Fire process.
  vi.mocked(db.task.findFirst).mockResolvedValue({
    agentHost: "ubuntu",
    executionHost: "conductor-fire-ubuntu-task-1",
    metadata: null,
    project: { daemonHost: "ubuntu" },
  } as any);
  vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
    { id: "a", host: "ubuntu", capabilities: ["remote_file", "remote_file_preview"] },
  ] as any);
  useDaemon();
});

afterAll(async () => {
  delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
  delete process.env.CONDUCTOR_PREVIEW_USER_BYTES;
});

describe("file preview", () => {
  it("opens a preview rooted at the file's directory and serves it sandboxed", async () => {
    const response = await open("index.html");
    expect(response.status).toBe(200);
    const body = await extractJson(response);
    expect(body.path).toBe("index.html");
    expect(body.viewUrl).toBe(`/api/preview/${body.token}/index.html`);
    // The relative path went to the daemon with the task it is relative to.
    expect(vi.mocked(requestRemoteFile).mock.calls[0][0]).toMatchObject({
      agentHost: "ubuntu",
      action: "stat",
      args: { remotePath: "index.html", taskId: "task-1" },
    });

    const page = await fetchFile(body.token, "index.html");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(DISK[`${ROOT}/index.html`]);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups allow-forms allow-modals",
    );
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");

    // A sibling asset resolves inside the same root, confined by the daemon.
    const script = await fetchFile(body.token, "assets/app.js");
    expect(await script.text()).toBe("console.log(1)");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(vi.mocked(requestRemoteFile).mock.calls.at(-1)?.[0]).toMatchObject({
      action: "push",
      args: { remotePath: `${ROOT}/assets/app.js`, rootPath: ROOT },
    });
  });

  it("sends Markdown to the in-app viewer", async () => {
    const body = await extractJson(await open(`${ROOT}/notes.md`));
    expect(body.viewUrl).toBe(`/preview/${body.token}/notes.md`);
    expect(body.url).toBe(`/api/preview/${body.token}/notes.md`);
  });

  it("serves byte ranges so a video can seek", async () => {
    const body = await extractJson(await open("demo.mp4"));
    expect(body.viewUrl).toBe(`/api/preview/${body.token}/demo.mp4`);

    const whole = await fetchFile(body.token, "demo.mp4");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const part = await fetchFile(body.token, "demo.mp4", { range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect(part.headers.get("content-security-policy")).toContain("sandbox");

    const beyond = await fetchFile(body.token, "demo.mp4", { range: "bytes=50-" });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10");
  });

  it("lets a recording be larger than a page", async () => {
    const stat = (name: string, megabytes: number) =>
      vi.mocked(requestRemoteFile).mockResolvedValueOnce({
        ok: true,
        action: "stat",
        result: { exists: true, isFile: true, sizeBytes: megabytes * 1024 * 1024, realPath: `${ROOT}/${name}` },
      });
    stat("long.mp4", 80);
    expect((await open("long.mp4")).status).toBe(200);
    stat("huge.mp4", 101);
    expect((await open("huge.mp4")).status).toBe(413);
    stat("big.png", 21);
    expect((await open("big.png")).status).toBe(413);
  });

  it("reuses one link for files in the same directory", async () => {
    const first = await extractJson(await open("shot.png"));
    const second = await extractJson(await open("demo.mp4"));
    expect(second.token).toBe(first.token);
    expect(second.path).toBe("demo.mp4");

    // A different directory is a different root, hence a different link.
    vi.mocked(requestRemoteFile).mockResolvedValueOnce({
      ok: true,
      action: "stat",
      result: { exists: true, isFile: true, sizeBytes: 1, realPath: "/home/dev/other/a.png" },
    });
    expect((await extractJson(await open("/home/dev/other/a.png"))).token).not.toBe(first.token);
  });

  it("keeps one user's previews to one stat and two fetches at a time", async () => {
    const inFlight = { stat: 0, push: 0 };
    const peak = { stat: 0, push: 0 };
    const daemon = vi.mocked(requestRemoteFile).getMockImplementation()!;
    vi.mocked(requestRemoteFile).mockImplementation(async (opts) => {
      const kind = opts.action as "stat" | "push";
      peak[kind] = Math.max(peak[kind], (inFlight[kind] += 1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await daemon(opts);
      } finally {
        inFlight[kind] -= 1;
      }
    });

    // Ten pictures in one reply, from two directories (hence two links).
    for (let i = 0; i < 5; i += 1) {
      DISK[`${ROOT}/a${i}.png`] = "a";
      DISK[`/home/dev/other/b${i}.png`] = "b";
    }
    const paths = [0, 1, 2, 3, 4].flatMap((i) => [`a${i}.png`, `/home/dev/other/b${i}.png`]);
    const opened = await Promise.all(paths.map((filePath) => open(filePath)));
    expect(opened.map((response) => response.status)).toEqual(Array(10).fill(200));

    const links = await Promise.all(opened.map(extractJson));
    const fetched = await Promise.all(links.map((link) => fetchFile(link.token, link.path)));
    expect(fetched.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(peak).toEqual({ stat: 1, push: 2 });
  });

  it("budgets previews apart from remote cp", async () => {
    const { token } = await extractJson(await open("index.html"));
    expect((await fetchFile(token, "index.html")).status).toBe(200);
    // Staged preview bytes are not charged to the account's `remote cp` budget…
    expect(remoteFileReservedBytesForTests("user-1")).toBe(0);

    // …a `remote cp` at its concurrency limit does not stop a preview…
    for (let i = 0; i < 4; i += 1) {
      createTransfer({ userId: "user-1", agentHost: "ubuntu", direction: "up", remotePath: `/tmp/f${i}`, sizeBytes: 1 });
    }
    expect((await fetchFile(token, "assets/app.js")).status).toBe(200);

    // …and previews stop at their own allowance.
    process.env.CONDUCTOR_PREVIEW_USER_BYTES = "64";
    const full = await fetchFile(token, "notes.md");
    expect(full.status).toBe(507);
    delete process.env.CONDUCTOR_PREVIEW_USER_BYTES;
    // Not remembered as a failure: it works once there is room again.
    expect((await fetchFile(token, "notes.md")).status).toBe(200);
  });

  it("fetches each file from the daemon once, and remembers a miss", async () => {
    const { token } = await extractJson(await open("index.html"));
    const pushes = () =>
      vi.mocked(requestRemoteFile).mock.calls.filter(([opts]) => opts.action === "push").length;

    await Promise.all([fetchFile(token, "assets/app.js"), fetchFile(token, "assets/app.js")]);
    await fetchFile(token, "assets/app.js");
    expect(pushes()).toBe(1);

    expect((await fetchFile(token, "missing.css")).status).toBe(404);
    expect((await fetchFile(token, "missing.css")).status).toBe(404);
    expect(pushes()).toBe(2);
  });

  it("keeps the sandbox on every error response", async () => {
    const { token } = await extractJson(await open("index.html"));
    const responses = [
      await fetchFile("no-such-token", "index.html"),
      await fetchFile(token, "missing.css"),
      await fetchFile(token, "../secret.txt"),
      await fetchFile(token, ".env"),
      await fetchFile(token, ".git/config"),
    ];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    for (const response of responses) {
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // Paths that leave the root or name a dotfile never reach the daemon.
    const pushed = vi
      .mocked(requestRemoteFile)
      .mock.calls.filter(([opts]) => opts.action === "push")
      .map(([opts]) => (opts.args as any).remotePath);
    expect(pushed).toEqual([`${ROOT}/missing.css`]);
  });

  it("expires after five idle minutes, and after thirty however busy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { token } = await extractJson(await open("index.html"));
    expect((await fetchFile(token, "index.html")).status).toBe(200);

    // Regular use keeps it alive…
    vi.setSystemTime(start + PREVIEW_IDLE_TTL_MS - 1000);
    expect((await fetchFile(token, "index.html")).status).toBe(200);
    // …but not past the absolute cap.
    for (let now = start + PREVIEW_IDLE_TTL_MS; now < start + PREVIEW_MAX_TTL_MS; now += PREVIEW_IDLE_TTL_MS - 1000) {
      vi.setSystemTime(now);
      expect((await fetchFile(token, "index.html")).status).toBe(200);
    }
    vi.setSystemTime(start + PREVIEW_MAX_TTL_MS + 1);
    expect((await fetchFile(token, "index.html")).status).toBe(404);

    const idle = await extractJson(await open("index.html"));
    const idleStart = Date.now();
    await fetchFile(idle.token, "index.html");
    vi.setSystemTime(idleStart + PREVIEW_IDLE_TTL_MS + 1);
    expect(await pruneExpiredPreviews()).toBe(1);
    expect((await fetchFile(idle.token, "index.html")).status).toBe(404);
    // Destroyed means the staged bytes are gone too, not just the link.
    expect(await fs.readdir(path.join(storageRoot, "remote-transfers"))).toEqual([]);
  });

  it("refuses files it should not open", async () => {
    expect((await open("id_rsa")).status).toBe(415);
    expect((await open("archive.zip")).status).toBe(415);
    expect((await open("gone.html")).status).toBe(404);

    // A symlink named like a page that really is a dotfile.
    vi.mocked(requestRemoteFile).mockResolvedValueOnce({
      ok: true,
      action: "stat",
      result: { exists: true, isFile: true, sizeBytes: 1, realPath: "/home/dev/.env.html" },
    });
    expect((await open("page.html")).status).toBe(415);

    vi.mocked(requestRemoteFile).mockResolvedValueOnce({
      ok: true,
      action: "stat",
      result: { exists: true, isFile: true, sizeBytes: 1, realPath: "/page.html" },
    });
    expect((await open("/page.html")).status).toBe(403);

    vi.mocked(requestRemoteFile).mockResolvedValueOnce({
      ok: true,
      action: "stat",
      result: { exists: true, isFile: true, sizeBytes: 21 * 1024 * 1024, realPath: `${ROOT}/big.html` },
    });
    expect((await open("big.html")).status).toBe(413);
  });

  it("requires the task's owner and a daemon that enforces the preview root", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce(null);
    expect((await open("index.html")).status).toBe(404);
    expect(vi.mocked(db.task.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "task-1", project: { userId: "user-1" } },
    });

    // An older daemon would ignore `rootPath` and serve the whole disk.
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "a", host: "ubuntu", capabilities: ["remote_file"] },
    ] as any);
    const outdated = await open("index.html");
    expect(outdated.status).toBe(409);
    expect((await extractJson(outdated)).error).toMatch(/does not support file preview/);

    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    expect((await open("index.html")).status).toBe(409);
    expect(requestRemoteFile).not.toHaveBeenCalled();
  });

  it("finds the daemon behind a task started with `conductor fire`", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      agentHost: "conductor-fire-macmini-1",
      executionHost: "conductor-fire-macmini-1",
      metadata: JSON.stringify({ daemonName: "macmini" }),
      project: { daemonHost: "ubuntu" },
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "b", host: "macmini", capabilities: ["remote_file", "remote_file_preview"] },
    ] as any);
    expect((await open("index.html")).status).toBe(200);
    expect(vi.mocked(requestRemoteFile).mock.calls[0][0].agentHost).toBe("macmini");
  });
});
