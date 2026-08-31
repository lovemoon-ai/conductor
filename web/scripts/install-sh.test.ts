import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// public/install.sh chooses an install layout by probing the machine, and every branch has to land
// where `conductor update` will later look. The scenarios live in bash because that is what they
// exercise; this spec just runs them so `pnpm test` covers them.
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptsDir, "install-sh-scenarios.sh");

const scenarios = execFileSync("bash", [runner, "--list"], { encoding: "utf-8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

describe("install.sh layout scenarios", () => {
  it("exposes the scenario list", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it.each(scenarios)(
    "%s",
    (scenario) => {
      let output = "";
      try {
        output = execFileSync("bash", [runner, scenario], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim());
      }
      expect(output).toContain(scenario);
    },
    120_000,
  );
});
