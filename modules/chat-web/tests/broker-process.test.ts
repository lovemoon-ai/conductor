import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brokerPaths } from "../src/core/broker-protocol.js";

async function until(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Process check timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The unit broker suite is browser-independent. These process/lock tests also
// exercise real Chromium when its binary is installed, without website traffic.
describe.skipIf(!fs.existsSync(chromium.executablePath()) || process.platform === "win32")("broker process ownership", () => {
  let home: string;
  let previousHome: string | undefined;
  let children: ChildProcessWithoutNullStreams[];
  let ownerPid: number | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "broker-process-"));
    previousHome = process.env.CHAT_WEB_HOME;
    process.env.CHAT_WEB_HOME = home;
    children = [];
    ownerPid = undefined;
  });

  afterEach(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (ownerPid) {
      try { process.kill(ownerPid, "SIGTERM"); } catch { /* Already exited. */ }
      await until(() => !fs.existsSync(brokerPaths("kimi").lock), 12000).catch(() => {});
    }
    if (previousHome === undefined) delete process.env.CHAT_WEB_HOME; else process.env.CHAT_WEB_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function client() {
    const entry = fileURLToPath(new URL("../src/queued-session.ts", import.meta.url));
    const source = `
      const {QueuedChatSession} = await import(process.env.CW_TEST_ENTRY);
      const session = await QueuedChatSession.open('kimi', {headless:true,autoOpen:false});
      console.log('READY');
      process.stdin.resume();
      process.stdin.once('data', async () => { await session.close(); console.log('CLOSED'); process.exit(0); });
    `;
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", source], {
      env: { ...process.env, CHAT_WEB_HOME: home, CW_TEST_ENTRY: entry }, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    let stderr = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    const wait = async (text: string) => {
      await until(() => {
        if (output.includes(text)) return true;
        if (child.exitCode !== null) throw new Error(`Client exited: ${child.exitCode}: ${stderr}`);
        return false;
      });
    };
    return { child, wait };
  }

  it("simultaneous clients share one owner, survive a task crash, then release the profile", async () => {
    const a = client();
    const b = client();
    await Promise.all([a.wait("READY"), b.wait("READY")]);
    const paths = brokerPaths("kimi");
    ownerPid = JSON.parse(fs.readFileSync(paths.lock, "utf8")).pid;
    expect(ownerPid).not.toBe(a.child.pid);
    expect(ownerPid).not.toBe(b.child.pid);
    a.child.kill("SIGKILL");
    await until(() => a.child.signalCode !== null);
    b.child.stdin.write("close");
    await b.wait("CLOSED");
    await until(() => !fs.existsSync(paths.lock), 12000);
    expect(fs.existsSync(path.join(home, "profiles/kimi/.chat-web-owner.json"))).toBe(false);
  }, 25000);

  it("reclaims a crashed broker and its orphaned browser on the next open", async () => {
    const a = client();
    await a.wait("READY");
    const paths = brokerPaths("kimi");
    const previousPid = JSON.parse(fs.readFileSync(paths.lock, "utf8")).pid;
    process.kill(previousPid, "SIGKILL");
    const b = client();
    const c = client();
    await Promise.all([b.wait("READY"), c.wait("READY")]);
    ownerPid = JSON.parse(fs.readFileSync(paths.lock, "utf8")).pid;
    expect(ownerPid).not.toBe(previousPid);
    a.child.stdin.write("close"); b.child.stdin.write("close"); c.child.stdin.write("close");
    await Promise.all([a.wait("CLOSED"), b.wait("CLOSED"), c.wait("CLOSED")]);
    await until(() => !fs.existsSync(paths.lock), 12000);
  }, 30000);
});
