import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveDefaultPtyShell,
  resolvePtyInteractiveShellArgs,
  resolvePtyShellCommandArgs,
} from "../src/pty-shell.js";

describe("pty shell helpers", () => {
  it("falls back to POSIX shells when SHELL is unset", () => {
    assert.strictEqual(
      resolveDefaultPtyShell({
        envShell: "",
        platform: "linux",
        existsSync: (candidate) => candidate === "/bin/bash",
      }),
      "/bin/bash",
    );
    assert.strictEqual(
      resolveDefaultPtyShell({
        envShell: "",
        platform: "linux",
        existsSync: (candidate) => candidate === "/bin/sh",
      }),
      "/bin/sh",
    );
  });

  it("prefers COMSPEC on Windows when SHELL is a Unix-only path", () => {
    assert.strictEqual(
      resolveDefaultPtyShell({
        envShell: "/usr/bin/bash",
        comspec: "C:\\Windows\\System32\\cmd.exe",
        platform: "win32",
        existsSync: () => false,
      }),
      "C:\\Windows\\System32\\cmd.exe",
    );
  });

  it("honors usable Windows shell values", () => {
    assert.strictEqual(
      resolveDefaultPtyShell({
        envShell: "C:\\Program Files\\Git\\bin\\bash.exe",
        comspec: "C:\\Windows\\System32\\cmd.exe",
        platform: "win32",
        existsSync: (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe",
      }),
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
    assert.strictEqual(
      resolveDefaultPtyShell({
        envShell: "pwsh.exe",
        comspec: "C:\\Windows\\System32\\cmd.exe",
        platform: "win32",
      }),
      "pwsh.exe",
    );
  });

  it("builds Windows PTY command args for common shells", () => {
    assert.deepStrictEqual(
      resolvePtyShellCommandArgs({
        shell: "C:\\Windows\\System32\\cmd.exe",
        command: "codex --version",
        platform: "win32",
      }),
      ["/d", "/s", "/c", "codex --version"],
    );
    assert.deepStrictEqual(
      resolvePtyShellCommandArgs({
        shell: "pwsh.exe",
        command: "codex --version",
        platform: "win32",
      }),
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "codex --version"],
    );
    assert.deepStrictEqual(
      resolvePtyShellCommandArgs({
        shell: "C:\\Program Files\\Git\\bin\\bash.exe",
        command: "codex --version",
        platform: "win32",
      }),
      ["-lc", "codex --version"],
    );
  });

  it("builds interactive PTY args for Windows shells", () => {
    assert.deepStrictEqual(
      resolvePtyInteractiveShellArgs({
        shell: "C:\\Windows\\System32\\cmd.exe",
        platform: "win32",
      }),
      [],
    );
    assert.deepStrictEqual(
      resolvePtyInteractiveShellArgs({
        shell: "pwsh.exe",
        platform: "win32",
      }),
      ["-NoLogo"],
    );
  });
});
