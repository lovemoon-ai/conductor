import { createRequire } from 'node:module';
import { BackendApiClient, BackendApiError } from '../backend/index.js';

export type ApiClient = Pick<
  BackendApiClient,
  | 'listProjects'
  | 'createProject'
  | 'getProject'
  | 'updateProject'
  | 'patchProjectByQuery'
  | 'setDefaultProject'
  | 'matchProjectByPath'
  | 'listIssues'
  | 'getIssue'
  | 'createIssue'
  | 'patchIssue'
  | 'deleteIssue'
  | 'listTasks'
  | 'createTask'
  | 'getTask'
  | 'getTaskGroup'
  | 'listTaskMessages'
  | 'postTaskMessage'
  | 'postTaskInsert'
  | 'listScheduledMessages'
  | 'createScheduledMessage'
  | 'deleteScheduledMessage'
>;

export interface SdkClientOptions {
  /**
   * Optional override for the SDK version stamped onto audit metadata. Falls
   * back to the package.json version. Tests may want to pin this so output is
   * stable.
   */
  sdkVersion?: string;
  /**
   * Optional environment provider for `CONDUCTOR_INVOKED_BY` lookup. Defaults
   * to `process.env`. Useful for tests that want to inject env without
   * mutating globals.
   */
  env?: NodeJS.ProcessEnv;
}

// Loaded eagerly so we don't pay a require() on every audit metadata stamp.
// Falls back to a stable string when the package.json isn't reachable (eg.
// bundled scenarios). The version is only ever embedded into outbound
// metadata, so a fallback is fine.
let cachedSdkVersion: string | null = null;
const readSdkVersion = (): string => {
  if (cachedSdkVersion !== null) {
    return cachedSdkVersion;
  }
  try {
    const localRequire = createRequire(import.meta.url);
    const pkg = localRequire('../../package.json') as { version?: unknown };
    cachedSdkVersion =
      pkg && typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedSdkVersion = 'unknown';
  }
  return cachedSdkVersion;
};

/**
 * Build the metadata payload every SDK write attaches to the request.
 *
 * Audit fields are namespaced under `metadata.audit` (RFC 0025 §5.2 + review
 * findings M3/H1). This avoids two failure modes the original top-level shape
 * had:
 *   1. A caller passing `--metadata-json '{"actor":"system"}'` could spoof the
 *      audit actor by colliding with our top-level key.
 *   2. Server-side strippers had to know the full audit-key list to filter.
 *
 * Merge order:
 *   - Non-audit user keys are passed through verbatim.
 *   - Audit defaults (`actor:"sdk"`, `sdkVersion`, `invokedBy`) are layered
 *     UNDER the caller's `audit` (so the CLI's `actor:"cli"` wins).
 *   - The caller's top-level `audit` key, if any, takes precedence over the
 *     SDK defaults but never replaces all of them — `cliVersion`, etc., are
 *     additive.
 */
export const buildAuditMetadata = (
  userMetadata: Record<string, unknown> | undefined,
  options: SdkClientOptions = {},
): Record<string, unknown> => {
  const env = options.env ?? process.env;
  const invokedByRaw = env.CONDUCTOR_INVOKED_BY;
  const invokedBy =
    typeof invokedByRaw === 'string' && invokedByRaw.trim()
      ? invokedByRaw.trim()
      : null;
  const sdkAudit: Record<string, unknown> = {
    actor: 'sdk',
    sdkVersion: options.sdkVersion ?? readSdkVersion(),
    invokedBy,
  };
  const safeUserMetadata =
    userMetadata && typeof userMetadata === 'object' && !Array.isArray(userMetadata)
      ? { ...userMetadata }
      : {};
  const callerAuditRaw = safeUserMetadata.audit;
  delete safeUserMetadata.audit;
  const callerAudit =
    callerAuditRaw && typeof callerAuditRaw === 'object' && !Array.isArray(callerAuditRaw)
      ? (callerAuditRaw as Record<string, unknown>)
      : {};
  // Caller-supplied audit fields win over SDK defaults so a CLI invocation
  // tagging `actor:"cli"` ends up authoritative.
  const audit = { ...sdkAudit, ...callerAudit };
  return { ...safeUserMetadata, audit };
};

export class ProjectNotResolvedError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'not_found'
      | 'multiple_matches'
      | 'no_default'
      | 'no_signal',
  ) {
    super(message);
    this.name = 'ProjectNotResolvedError';
  }
}

/**
 * Best-effort mapping for HTTP-shaped failures so the CLI exit-code matrix
 * (RFC 0025 §4) has a stable signal. Callers can choose to inspect
 * `BackendApiError.statusCode` directly instead.
 */
export const isBackendApiError = (value: unknown): value is BackendApiError =>
  value instanceof BackendApiError;
