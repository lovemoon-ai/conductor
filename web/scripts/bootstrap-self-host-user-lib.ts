import { loadAppEnv, resolveEnvFile } from "../env-utils";

export function resolveBootstrapEnvFile(cwd = process.cwd()): string | null {
  return resolveEnvFile(cwd, "production") ?? resolveEnvFile(cwd);
}

export function loadBootstrapEnv(cwd = process.cwd()): string | null {
  const envFile = resolveBootstrapEnvFile(cwd);
  if (!envFile) {
    return null;
  }

  loadAppEnv({ cwd, nodeEnv: "production", override: false });
  return envFile;
}

export function parseBootstrapArgs(argv: string[]) {
  let phone: string | null = null;
  let baseUrl: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--phone") {
      phone = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      baseUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, phone: null, baseUrl: null };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, phone, baseUrl };
}

export function resolveBootstrapBaseUrl(explicitBaseUrl: string | null): string {
  const baseUrl =
    explicitBaseUrl?.trim() ||
    process.env.NEXT_PUBLIC_URL?.trim() ||
    process.env.PUBLIC_BACKEND_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    "http://localhost:6152";

  return new URL(baseUrl).toString();
}
