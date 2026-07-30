import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertMediaCapabilities,
  fileMediaToDataUri,
  normalizeMediaInputs,
  resolveTurnMedia,
} from "../src/media-input.js";

function fixtureFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-media-"));
  const image = path.join(dir, "one.png");
  const secondImage = path.join(dir, "two.jpg");
  const video = path.join(dir, "clip.mp4");
  fs.writeFileSync(image, Buffer.from("89504e470d0a1a0a00000000", "hex"));
  fs.writeFileSync(secondImage, Buffer.from("ffd8ffe00000000000000000", "hex"));
  fs.writeFileSync(video, Buffer.from("000000186674797069736f6d", "hex"));
  return { dir, image, secondImage, video };
}

test("normalizes ordered image and video files", () => {
  const files = fixtureFiles();
  try {
    const media = normalizeMediaInputs([
      { kind: "image", path: files.image, mimeType: "image/png" },
      { kind: "image", path: files.secondImage, mimeType: "image/jpeg" },
      { kind: "video", path: files.video, mimeType: "video/mp4" },
    ]);
    assert.deepEqual(media.map((item) => item.kind), ["image", "image", "video"]);
    assert.deepEqual(media.map((item) => item.name), ["one.png", "two.jpg", "clip.mp4"]);
    assert.match(fileMediaToDataUri(media[0]), /^data:image\/png;base64,/);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("merges legacy initial images with per-turn media", () => {
  const files = fixtureFiles();
  try {
    const media = resolveTurnMedia(
      { initialImages: [files.image] },
      {
        useInitialImages: true,
        media: [
          { kind: "image", path: files.secondImage, mimeType: "image/jpeg" },
          { kind: "video", path: files.video, mimeType: "video/mp4" },
        ],
      },
    );
    assert.deepEqual(media.map((item) => item.path), [files.image, files.secondImage, files.video]);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("resolves relative legacy initial images against the session cwd", () => {
  const files = fixtureFiles();
  try {
    const media = resolveTurnMedia(
      { cwd: files.dir, initialImages: ["one.png"] },
      { useInitialImages: true },
    );
    assert.equal(media[0].path, files.image);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("rejects oversized media before reading it into memory", () => {
  const files = fixtureFiles();
  try {
    fs.truncateSync(files.video, 50 * 1024 * 1024 + 1);
    assert.throws(
      () =>
        normalizeMediaInputs([
          { kind: "video", path: files.video, mimeType: "video/mp4" },
        ]),
      (error) => error.reason === "media_limit_exceeded" && error.mediaIndex === 0,
    );
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("rejects unknown media MIME types", () => {
  const files = fixtureFiles();
  try {
    assert.throws(
      () =>
        normalizeMediaInputs([
          { kind: "image", path: files.image, mimeType: "image/svg+xml" },
        ]),
      (error) => error.reason === "invalid_media_input" && error.mediaIndex === 0,
    );
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("rejects unsupported media without silently dropping it", () => {
  const files = fixtureFiles();
  try {
    const [video] = normalizeMediaInputs([
      { kind: "video", path: files.video, mimeType: "video/mp4" },
    ]);
    assert.throws(
      () => assertMediaCapabilities([video], "codex", { image: "native", video: "unsupported" }),
      (error) =>
        error.reason === "unsupported_media" &&
        error.backend === "codex" &&
        error.mediaKind === "video",
    );
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});
