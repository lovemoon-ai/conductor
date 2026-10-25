import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { brokerPaths } from "../src/core/broker-protocol.js";
import { profileDir } from "../src/core/paths.js";

it("generates the exact Windows named-pipe address", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "broker-pipe-"));
  const previousHome = process.env.CHAT_WEB_HOME;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    process.env.CHAT_WEB_HOME = home;
    Object.defineProperty(process, "platform", { value: "win32" });
    const actual = brokerPaths("stub");
    const key = createHash("sha256").update(fs.realpathSync(profileDir("stub"))).digest("hex").slice(0, 24);
    // Construct expected backslashes by code point, independently of literal escaping.
    const prefix = String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92);
    expect(actual.socket).toBe(`${prefix}chat-web-${key}`);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env.CHAT_WEB_HOME; else process.env.CHAT_WEB_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
