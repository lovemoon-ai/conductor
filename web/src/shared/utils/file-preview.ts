/**
 * What a file preview will serve, and how. Shared by the server (which sets
 * `Content-Type` from it) and the chat (which only turns a link into a preview
 * when its extension is listed here, so an ordinary app link such as
 * `/app/tasks` is never hijacked).
 */
const TEXT = "text/plain; charset=utf-8";

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: TEXT,
  log: TEXT,
  csv: TEXT,
  tsv: TEXT,
  yaml: TEXT,
  yml: TEXT,
  toml: TEXT,
  xml: TEXT,
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
};

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** `null` means "not something a preview can open". */
export function previewContentType(name: string): string | null {
  return CONTENT_TYPES[extensionOf(name)] ?? null;
}

/** What the chat can show in place: `![](shot.png)` as a picture, `![](demo.mp4)` as a player. */
export function previewMediaKind(name: string): "image" | "video" | "audio" | null {
  const kind = previewContentType(name)?.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

/**
 * Largest file a preview will serve. Recordings are routinely bigger than any
 * page or picture, so they get their own, higher ceiling.
 */
export function previewMaxBytes(name: string): number {
  const kind = previewMediaKind(name);
  return (kind === "video" || kind === "audio" ? 100 : 20) * 1024 * 1024;
}

export function isMarkdownPath(name: string): boolean {
  const extension = extensionOf(name);
  return extension === "md" || extension === "markdown";
}

/**
 * The path on the daemon's disk that a chat link points at, or `null` when the
 * link is not a local file.
 *
 * AIs write these as `/abs/report.md`, `~/notes.md`, `docs/report.md`,
 * `file:///abs/report.html`, and often with a `:12` line suffix or a `#L12`
 * fragment, none of which is part of the file name.
 */
export function parseLocalFileHref(href: string | undefined | null): string | null {
  let value = (href ?? "").trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(localhost)?/i, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }
  value = value.replace(/[?#].*$/, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.replace(/:\d+(:\d+)?$/, "");
  return value && previewContentType(value) ? value : null;
}

/** URL path for a file inside a preview, each segment escaped. */
export function encodePreviewPath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Where the browser should go to look at `relativePath`: Markdown gets the
 * in-app viewer, everything else is served as-is.
 */
export function previewViewUrl(token: string, relativePath: string): string {
  const prefix = isMarkdownPath(relativePath) ? "/preview" : "/api/preview";
  return `${prefix}/${token}/${encodePreviewPath(relativePath)}`;
}
