import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearProjectSettingsCache,
  normalizeProjectAgentsRegistry,
  readProjectAgentsRegistry,
  readProjectSettingsYaml,
} from "./project-settings-yaml";

const writeSettings = async (root: string, content: string) => {
  await fs.mkdir(path.join(root, ".conductor"), { recursive: true });
  await fs.writeFile(path.join(root, ".conductor", "settings.yaml"), content, "utf8");
};

// Smallest legal SVG so the base64 payload is short and easy to assert on.
const SAMPLE_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

describe("readProjectSettingsYaml", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-settings-test-"));
    clearProjectSettingsCache();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns the top-level icon field", async () => {
    await writeSettings(tmpRoot, "icon: \"🚀\"\n");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBe("🚀");
  });

  it("passes URL icons through unchanged", async () => {
    await writeSettings(tmpRoot, "icon: https://example.com/icon.png\n");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBe("https://example.com/icon.png");
  });

  it("falls back to project.icon when no top-level icon is set", async () => {
    await writeSettings(tmpRoot, "project:\n  icon: \"📦\"\nworktree:\n  symlink: []\n");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBe("📦");
  });

  it("returns null icon when the file is missing", async () => {
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBeNull();
  });

  it("returns null icon when the file is malformed YAML", async () => {
    await writeSettings(tmpRoot, ":\n  bad: [unterminated");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBeNull();
  });

  it("treats whitespace-only icon as unset", async () => {
    await writeSettings(tmpRoot, "icon: \"   \"\n");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBeNull();
  });

  it("returns null icon for nullish/empty workspace paths", async () => {
    expect((await readProjectSettingsYaml(null)).icon).toBeNull();
    expect((await readProjectSettingsYaml(undefined)).icon).toBeNull();
    expect((await readProjectSettingsYaml("")).icon).toBeNull();
    expect((await readProjectSettingsYaml("   ")).icon).toBeNull();
  });

  it("inlines a relative-path icon as a data URI (resolved against .conductor/)", async () => {
    // `./logo.svg` is resolved relative to the settings file's directory
    // (`.conductor/`), so we place the icon next to settings.yaml itself.
    await writeSettings(tmpRoot, "icon: ./logo.svg\n");
    await fs.writeFile(path.join(tmpRoot, ".conductor", "logo.svg"), SAMPLE_SVG, "utf8");

    const settings = await readProjectSettingsYaml(tmpRoot);
    const expected = `data:image/svg+xml;base64,${Buffer.from(SAMPLE_SVG, "utf8").toString("base64")}`;
    expect(settings.icon).toBe(expected);
  });

  it("inlines a `../` icon path relative to .conductor/ (matches user intent)", async () => {
    // Mirrors the documented case: `.conductor/settings.yaml` has
    // `icon: ../web/public/icon.svg`, expected to mean "up one from
    // `.conductor/`, then into `web/public/`".
    await fs.mkdir(path.join(tmpRoot, "web", "public"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "web", "public", "icon.svg"), SAMPLE_SVG, "utf8");
    await writeSettings(tmpRoot, "icon: ../web/public/icon.svg\n");

    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("returns null when the icon path points at a missing file", async () => {
    await writeSettings(tmpRoot, "icon: ./does-not-exist.svg\n");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBeNull();
  });

  it("returns null when the icon path has a disallowed extension", async () => {
    await writeSettings(tmpRoot, "icon: ./README.md\n");
    await fs.writeFile(path.join(tmpRoot, ".conductor", "README.md"), "# Hi", "utf8");
    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBeNull();
  });

  it("maps PNG extensions to image/png", async () => {
    // PNG header bytes — content doesn't matter beyond having a non-zero size.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeSettings(tmpRoot, "icon: ./logo.png\n");
    await fs.writeFile(path.join(tmpRoot, ".conductor", "logo.png"), pngBytes);

    const settings = await readProjectSettingsYaml(tmpRoot);
    expect(settings.icon).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
  });

  it("reads the project agent registry with configurable doc paths and defaults", async () => {
    await writeSettings(
      tmpRoot,
      [
        "agents:",
        "  feature-dev:",
        "    doc: personas/implementation.md",
        "    description: Builds the feature",
        "    backend: Codex",
        "  code-reviewer: reviews/code.md",
        "",
      ].join("\n"),
    );

    await expect(readProjectAgentsRegistry(tmpRoot)).resolves.toEqual([
      {
        name: "feature-dev",
        doc: "personas/implementation.md",
        description: "Builds the feature",
        backend: "codex",
      },
      {
        name: "code-reviewer",
        doc: "reviews/code.md",
        description: null,
        backend: null,
      },
    ]);
  });

  it("accepts legacy list entries while dropping doc-less or unsafe agents", async () => {
    await writeSettings(
      tmpRoot,
      [
        "agents:",
        "  - review: docs/review.md",
        "  - planner:",
        "  - escape: ../outside.md",
        "  - /invalid: docs/invalid.md",
        "",
      ].join("\n"),
    );

    await expect(readProjectAgentsRegistry(tmpRoot)).resolves.toEqual([
      {
        name: "review",
        doc: "docs/review.md",
        description: null,
        backend: null,
      },
    ]);
  });

  it("sanitizes registry arrays received from a daemon", () => {
    expect(
      normalizeProjectAgentsRegistry([
        {
          name: "security",
          doc: "agents/security.md",
          description: "Security review",
          backend: "CLAUDE",
        },
        { name: "escape", doc: "../../secret.md" },
      ]),
    ).toEqual([
      {
        name: "security",
        doc: "agents/security.md",
        description: "Security review",
        backend: "claude",
      },
    ]);
  });
});
