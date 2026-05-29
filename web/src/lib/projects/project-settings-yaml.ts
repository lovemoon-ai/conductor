import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Subset of `.conductor/settings.yaml` we surface to clients.
 *
 * Only the fields the UI needs are extracted — the file is owned by the daemon
 * (`cli/src/daemon.js#readProjectWorktreeSettings`) and may contain unrelated
 * keys (e.g. `worktree.symlink`, `worktree.sync_branch`). Adding new fields here
 * is safe; missing/unknown keys never throw.
 */
export interface ProjectSettingsYaml {
  /**
   * User-supplied icon rendered on the project list card. Can be one of:
   *  - an emoji or short text string ("🚀", "AB")
   *  - an `http(s)://…` URL
   *  - a `data:…` URI (produced by us when the user pointed at a local image)
   *
   * Filesystem paths in settings.yaml (absolute or relative to the workspace)
   * are resolved server-side: we read the file, sniff a mime type from the
   * extension, and substitute a base64 `data:` URI here so the browser can
   * render the icon directly without an extra fetch and without us having to
   * expose a per-project static-file endpoint.
   *
   * Whitespace-only values are treated as unset.
   */
  icon: string | null;
}

const EMPTY_SETTINGS: ProjectSettingsYaml = { icon: null };

/**
 * Hard cap on settings.yaml file size. Settings should be tiny (a few hundred
 * bytes in practice). Anything larger is treated as a configuration mistake
 * and ignored so we never load a malicious or runaway file into the API
 * response.
 */
const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

/**
 * Hard cap on the icon image file size. The icon is base64-inlined into the
 * projects JSON response, so a multi-MB png would balloon the payload. 512 KiB
 * is enough room for a comfortable PNG/SVG but small enough that a careless
 * user can't accidentally DOS the list endpoint.
 */
const MAX_ICON_IMAGE_BYTES = 512 * 1024;

/**
 * Allowed icon image extensions, mapped to their MIME types. Anything not on
 * this list is rejected — we deliberately do not auto-sniff binary content so
 * a stray `icon: README.md` cannot dump a non-image file into the response.
 */
const ICON_MIME_BY_EXTENSION: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

/**
 * Tiny in-process cache keyed by workspacePath. Reads are cheap (local fs,
 * <1KB file) but the project list endpoint can fan out to dozens of projects
 * per request and is hit on every dashboard refresh, so we memoize for a few
 * seconds to keep the GET handler cheap. The TTL is short enough that a user
 * editing settings.yaml sees their change reflected on the next refresh.
 */
const SETTINGS_CACHE_TTL_MS = 5_000;
type CacheEntry = { value: ProjectSettingsYaml; expiresAt: number };
const settingsCache = new Map<string, CacheEntry>();

const SETTINGS_FILE_CANDIDATES = [
  // Match the daemon's list, including the `setttings.*` typo it tolerates so
  // users who hit that path still get their icon. Keep the canonical name
  // first so we short-circuit the fast path.
  ".conductor/settings.yaml",
  ".conductor/settings.yml",
  ".conductor/setttings.yaml",
  ".conductor/setttings.yml",
];

const normalizeIconValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const extractIconFromParsedYaml = (parsed: unknown): string | null => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  // Top-level `icon:` is the documented shape. Also accept `project.icon` so
  // users who namespace their settings (mirroring `worktree:`) still work.
  const direct = normalizeIconValue(record.icon);
  if (direct) return direct;
  const project = record.project;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    return normalizeIconValue((project as Record<string, unknown>).icon);
  }
  return null;
};

/**
 * Decide whether an icon string looks like a filesystem path we should
 * resolve. Anything passed through here that is *not* a path is returned to
 * the client verbatim (URL, data URI, emoji, short text).
 *
 * Heuristic:
 *  - explicit URI schemes (`http://`, `https://`, `data:`) are never paths
 *  - absolute paths (`/...`) and relative paths (`./`, `../`) are paths
 *  - strings containing a `/` plus a recognized image extension are paths
 *
 * Everything else (emoji, "AB", "icon-default") falls through to the text
 * rendering branch on the client.
 */
const looksLikeFilesystemPath = (value: string): boolean => {
  if (/^(https?:\/\/|data:)/i.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  if (!value.includes("/")) return false;
  const ext = path.extname(value).toLowerCase();
  return ext in ICON_MIME_BY_EXTENSION;
};

const readIconAsDataUri = async (
  // Directory containing the settings.yaml that defined this icon. Relative
  // icon paths are resolved against this directory (mirroring how most config
  // files work: `.gitignore`, ESLint, Docker, etc.), so `../web/public/icon.svg`
  // means "one level up from `.conductor/`" — the user's mental model when
  // they edit `.conductor/settings.yaml`.
  settingsDir: string,
  iconValue: string,
): Promise<string | null> => {
  const resolved = path.isAbsolute(iconValue)
    ? iconValue
    : path.resolve(settingsDir, iconValue);

  const ext = path.extname(resolved).toLowerCase();
  const mime = ICON_MIME_BY_EXTENSION[ext];
  if (!mime) {
    // Unknown extension → leave the icon empty. The client will fall back to
    // the default folder icon, which is friendlier than rendering a literal
    // filesystem path on the card.
    return null;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_IMAGE_BYTES) {
      return null;
    }
    const buffer = await fs.readFile(resolved);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    // Missing / unreadable icon — fall back to the default folder icon
    // rather than failing the whole projects API response.
    return null;
  }
};

const readSettingsFromCandidate = async (
  candidatePath: string,
): Promise<string | null | undefined> => {
  // `undefined` means "settings file missing at this candidate, try the next
  // one"; `null` means "found, but no icon configured"; a string is the raw
  // icon value as written by the user.
  let raw: string;
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_FILE_BYTES) {
      return undefined;
    }
    raw = await fs.readFile(candidatePath, "utf8");
  } catch {
    // Missing file / permission denied — neither is fatal. We just fall back
    // to the next candidate or return undefined so the caller uses defaults.
    return undefined;
  }

  try {
    const parsed = parseYaml(raw);
    return extractIconFromParsedYaml(parsed);
  } catch {
    // Corrupt YAML should not break the projects API. The daemon surfaces a
    // proper error on its side (during task spawn); the list view just shows
    // the default folder icon.
    return null;
  }
};

/**
 * Read `.conductor/settings.yaml` for a project workspace.
 *
 * Returns `{ icon: null }` when the workspace path is missing, the file is
 * absent, the file is too large, or YAML parsing fails. The web server reads
 * the local filesystem — this matches the existing assumption that the web
 * server and the project workspace live on the same machine (see CLAUDE.md
 * "E2E Test in Local Development"). Remote-daemon setups simply fall back to
 * the default folder icon.
 *
 * When the `icon` field is a filesystem path (e.g. `../web/public/icon.svg`),
 * the file is read, validated against an image-extension allow-list, and
 * inlined as a base64 `data:` URI so the browser can render it without an
 * extra round-trip.
 */
export async function readProjectSettingsYaml(
  workspacePath: string | null | undefined,
): Promise<ProjectSettingsYaml> {
  if (!workspacePath || typeof workspacePath !== "string") {
    return EMPTY_SETTINGS;
  }
  const trimmed = workspacePath.trim();
  if (!trimmed) return EMPTY_SETTINGS;

  const cached = settingsCache.get(trimmed);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const settingsResults = await Promise.all(
    SETTINGS_FILE_CANDIDATES.map(async (candidate) => {
      const candidatePath = path.join(trimmed, candidate);
      return {
        candidatePath,
        icon: await readSettingsFromCandidate(candidatePath),
      };
    }),
  );

  let rawIcon: string | null = null;
  let settingsDir: string | null = null;
  const firstSettingsResult = settingsResults.find((entry) => entry.icon !== undefined);
  if (firstSettingsResult) {
    rawIcon = firstSettingsResult.icon ?? null;
    settingsDir = path.dirname(firstSettingsResult.candidatePath);
  }

  let resolvedIcon = rawIcon;
  if (rawIcon && settingsDir && looksLikeFilesystemPath(rawIcon)) {
    // If the file can't be read we drop the icon entirely (null) rather than
    // returning the raw path string, which would otherwise render as broken
    // text on the project card.
    resolvedIcon = await readIconAsDataUri(settingsDir, rawIcon);
  }

  const result: ProjectSettingsYaml = { icon: resolvedIcon };
  settingsCache.set(trimmed, {
    value: result,
    expiresAt: now + SETTINGS_CACHE_TTL_MS,
  });
  return result;
}

/**
 * Clear the in-process settings cache. Exposed for tests; production code
 * relies on the TTL.
 */
export function clearProjectSettingsCache(): void {
  settingsCache.clear();
}
