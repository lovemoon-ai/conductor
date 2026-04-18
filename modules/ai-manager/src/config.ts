import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONDUCTOR_CONFIG, expandHome } from "./paths.ts";
import type { AiManagerConfig } from "./types.ts";

const EMPTY: AiManagerConfig = { codex: { authJson: [] } };

/**
 * Load the `ai_manager` section from a conductor config file.
 * Returns an empty config if the file does not exist or the section is missing.
 */
export async function loadAiManagerConfig(
  configPath: string = DEFAULT_CONDUCTOR_CONFIG,
): Promise<AiManagerConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return EMPTY;
    throw err;
  }

  const doc = parseYaml(raw) as any;
  const section = doc?.ai_manager;
  if (!section || typeof section !== "object") return EMPTY;

  const codexSection = section.codex ?? {};
  const rawList: unknown = codexSection.auth_json ?? [];
  if (!Array.isArray(rawList)) {
    throw new Error(
      `ai_manager.codex.auth_json must be a list of paths, got ${typeof rawList}`,
    );
  }

  const authJson = rawList
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map(expandHome);

  return { codex: { authJson } };
}
