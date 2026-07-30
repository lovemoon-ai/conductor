import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROVIDER_MEDIA_CAPABILITIES,
  buildClaudeContent,
  buildCodexAppServerInput,
  buildCopilotAttachments,
  buildKimiContent,
  buildOpencodeParts,
} from "../src/media-adapters.js";
import { assertMediaCapabilities, normalizeMediaInputs } from "../src/media-input.js";
import { CodexExecSession } from "../src/providers/codex-exec-session.js";
import { KimiPrintSession } from "../src/providers/kimi-print-session.js";

function fixtureMedia() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-adapters-"));
  const first = path.join(dir, "first.png");
  const second = path.join(dir, "second.jpg");
  const video = path.join(dir, "clip.mp4");
  fs.writeFileSync(first, Buffer.from("89504e470d0a1a0a00000000", "hex"));
  fs.writeFileSync(second, Buffer.from("ffd8ffe00000000000000000", "hex"));
  fs.writeFileSync(video, Buffer.from("000000186674797069736f6d", "hex"));
  return {
    dir,
    media: normalizeMediaInputs([
      { kind: "image", path: first, mimeType: "image/png" },
      { kind: "image", path: second, mimeType: "image/jpeg" },
      { kind: "video", path: video, mimeType: "video/mp4" },
    ]),
  };
}

test("documents image and video support for every built-in provider variant", () => {
  assert.deepEqual(PROVIDER_MEDIA_CAPABILITIES, {
    "chat-web-session": { image: "unsupported", video: "unsupported" },
    "claude-agent-sdk": { image: "native", video: "unsupported" },
    "codex-app-server": { image: "native", video: "unsupported" },
    "codex-exec": { image: "native", video: "unsupported" },
    "copilot-sdk": { image: "native", video: "unsupported" },
    "kimi-cli-print": { image: "native", video: "native" },
    "kimi-cli-wire": { image: "native", video: "native" },
    "opencode-sdk": { image: "native", video: "native" },
  });
});

test("builds Codex app-server localImage entries for multiple images", () => {
  const fixture = fixtureMedia();
  try {
    const input = buildCodexAppServerInput("inspect", fixture.media.slice(0, 2));
    assert.deepEqual(input.map((item) => item.type), ["text", "localImage", "localImage"]);
    assert.deepEqual(input.slice(1).map((item) => item.path), fixture.media.slice(0, 2).map((item) => item.path));
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("builds repeated Codex exec --image arguments and rejects video", () => {
  const fixture = fixtureMedia();
  try {
    const images = fixture.media.slice(0, 2);
    const session = new CodexExecSession("codex", { cwd: fixture.dir });
    const args = session.buildExecArgs({ media: images });
    assert.deepEqual(
      args.flatMap((value, index) => (value === "--image" ? [args[index + 1]] : [])),
      images.map((item) => item.path),
    );
    assert.throws(
      () =>
        assertMediaCapabilities(
          [fixture.media[2]],
          "codex",
          PROVIDER_MEDIA_CAPABILITIES["codex-exec"],
        ),
      (error) => error.reason === "unsupported_media" && error.mediaKind === "video",
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("every provider variant either accepts video natively or rejects it explicitly", () => {
  const fixture = fixtureMedia();
  try {
    const video = fixture.media[2];
    for (const [provider, capabilities] of Object.entries(PROVIDER_MEDIA_CAPABILITIES)) {
      if (capabilities.video === "native") {
        assert.doesNotThrow(() => assertMediaCapabilities([video], provider, capabilities));
      } else {
        assert.throws(
          () => assertMediaCapabilities([video], provider, capabilities),
          (error) =>
            error.reason === "unsupported_media" &&
            error.backend === provider &&
            error.mediaKind === "video",
        );
      }
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("builds Claude image content blocks and Copilot file attachments", () => {
  const fixture = fixtureMedia();
  try {
    const images = fixture.media.slice(0, 2);
    const claude = buildClaudeContent("inspect", images);
    assert.deepEqual(claude.map((item) => item.type), ["text", "image", "image"]);
    assert.deepEqual(claude.slice(1).map((item) => item.source.media_type), ["image/png", "image/jpeg"]);
    const copilot = buildCopilotAttachments(images);
    assert.deepEqual(copilot.map((item) => item.type), ["file", "file"]);
    assert.deepEqual(copilot.map((item) => item.path), images.map((item) => item.path));
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("builds Kimi image_url and video_url content", () => {
  const fixture = fixtureMedia();
  try {
    const content = buildKimiContent("inspect", fixture.media);
    assert.deepEqual(content.map((item) => item.type), ["text", "image_url", "image_url", "video_url"]);
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    assert.match(content[3].video_url.url, /^data:video\/mp4;base64,/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("advertises media as unsupported for legacy Kimi prompt mode", () => {
  const session = new KimiPrintSession("kimi", {
    cwd: process.cwd(),
    kimiCliMode: "prompt",
    commandLine: "kimi",
  });
  assert.deepEqual(session.getSnapshot().capabilities.media, {
    image: "unsupported",
    video: "unsupported",
  });
});

test("builds OpenCode file parts for multiple images and video", () => {
  const fixture = fixtureMedia();
  try {
    const parts = buildOpencodeParts("inspect", fixture.media);
    assert.deepEqual(parts.map((item) => item.type), ["text", "file", "file", "file"]);
    assert.deepEqual(parts.slice(1).map((item) => item.mime), ["image/png", "image/jpeg", "video/mp4"]);
    assert.match(parts[3].url, /^data:video\/mp4;base64,/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
