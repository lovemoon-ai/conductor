import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";

import {
  resolveConfiguredGitCommand,
  resolveGitCommand,
} from "../src/git-command.js";

describe("git command resolution", () => {
  it("uses explicit config before probing Windows install paths", () => {
    assert.equal(
      resolveGitCommand({
        configuredCommand: '"C:\\Tools\\Git\\cmd\\git.exe"',
        platform: "win32",
        env: {},
        existsSync: () => false,
        readdirSync: () => [],
      }),
      "C:\\Tools\\Git\\cmd\\git.exe",
    );
  });

  it("discovers Visual Studio bundled Git on Windows", () => {
    const programFiles = "C:\\Program Files";
    const gitPath = path.join(
      programFiles,
      "Microsoft Visual Studio",
      "18",
      "Insiders",
      "Common7",
      "IDE",
      "CommonExtensions",
      "Microsoft",
      "TeamFoundation",
      "Team Explorer",
      "Git",
      "cmd",
      "git.exe",
    );
    const readdirSync = (target) => {
      if (target === path.join(programFiles, "Microsoft Visual Studio")) {
        return [{ name: "18", isDirectory: () => true }];
      }
      if (target === path.join(programFiles, "Microsoft Visual Studio", "18")) {
        return [{ name: "Insiders", isDirectory: () => true }];
      }
      return [];
    };

    assert.equal(
      resolveGitCommand({
        platform: "win32",
        env: { ProgramFiles: programFiles },
        existsSync: (target) => target === gitPath,
        readdirSync,
      }),
      gitPath,
    );
  });

  it("reads git command aliases from config and env", () => {
    assert.equal(
      resolveConfiguredGitCommand({ git: { command: "C:\\Git\\git.exe" } }, {}),
      "C:\\Git\\git.exe",
    );
    assert.equal(
      resolveConfiguredGitCommand({ git_path: "C:\\Config\\git.exe" }, { CONDUCTOR_GIT: "C:\\Env\\git.exe" }),
      "C:\\Env\\git.exe",
    );
  });
});
