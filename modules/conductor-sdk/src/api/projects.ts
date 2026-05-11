import { BackendApiError } from '../backend/index.js';
import {
  ApiClient,
  ProjectNotResolvedError,
  SdkClientOptions,
  buildAuditMetadata,
} from './shared.js';

/**
 * Project record as returned by the REST API. We deliberately don't subclass
 * `ProjectSummary` here because the REST surface returns more fields (notably
 * `hidden`, `isDefault`, `metadata`) than the WS-flavored summary, and we
 * want CLI / AI consumers to see the full picture.
 */
export interface Project {
  id: string;
  name?: string | null;
  daemonHost?: string | null;
  workspacePath?: string | null;
  repoRoot?: string | null;
  worktreeBranch?: string | null;
  lastCommit?: string | null;
  fileCount?: number | null;
  isDefault: boolean;
  hidden: boolean;
  hiddenAt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /**
   * The unmodified server payload, kept for callers that need fields the
   * typed surface hasn't promoted yet (e.g. `gitRemoteUrl`, `mergeOptOut`).
   */
  raw: Record<string, unknown>;
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Heuristic for "this string looks like a project id, not a name".
 *
 * The server uses cuid-like ids (e.g. `clxk1y0fz0000abc123`) and UUIDs. Names
 * are arbitrary strings, but in practice users name their projects with
 * spaces, slashes, accents, etc. — i.e. they almost never match the
 * `^[a-zA-Z0-9_-]{12,}$` shape we treat as an id below. This lets the SDK
 * skip a redundant `getProject(id)` round-trip when the caller (CLI) has
 * already resolved to an id (review L-NEW-1). On a miss we fall back to the
 * full resolve, so the only downside of a false positive is one extra
 * 404 → re-list round trip.
 */
const looksLikeProjectId = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 12) return false;
  return /^[A-Za-z0-9_-]+$/.test(trimmed);
};

/**
 * Local longest-prefix match used by `resolveProject` step 4 when no daemon
 * host is available to delegate to the server-side matcher. We treat each
 * project's `workspacePath` as a prefix and pick the longest one that's a
 * proper directory ancestor of `cwd`. Mirrors the server's
 * match-path/route.ts logic for the simple single-daemon case.
 */
const matchProjectByLocalPrefix = (
  projects: Project[],
  cwd: string,
): Project | null => {
  const target = stripTrailingSlash(cwd.trim());
  if (!target) return null;
  let best: { project: Project; length: number } | null = null;
  for (const project of projects) {
    const path = project.workspacePath;
    if (typeof path !== 'string' || !path.trim()) continue;
    const normalized = stripTrailingSlash(path.trim());
    if (target === normalized || target.startsWith(`${normalized}/`)) {
      if (!best || normalized.length > best.length) {
        best = { project, length: normalized.length };
      }
    }
  }
  return best?.project ?? null;
};

const normalizeProject = (payload: Record<string, any>): Project => {
  const id = payload.id ? String(payload.id) : '';
  if (!id) {
    throw new Error('Project payload missing id');
  }
  const hiddenAt = payload.hiddenAt ?? payload.hidden_at ?? null;
  return {
    id,
    name: payload.name ?? null,
    daemonHost: payload.daemonHost ?? payload.daemon_host ?? null,
    workspacePath: payload.workspacePath ?? payload.workspace_path ?? null,
    repoRoot: payload.repoRoot ?? payload.repo_root ?? null,
    worktreeBranch: payload.worktreeBranch ?? payload.worktree_branch ?? null,
    lastCommit: payload.lastCommit ?? payload.last_commit ?? null,
    fileCount: payload.fileCount ?? payload.file_count ?? null,
    isDefault: Boolean(payload.isDefault ?? payload.is_default ?? false),
    hidden: Boolean(payload.hidden ?? Boolean(hiddenAt)),
    hiddenAt: hiddenAt ?? null,
    metadata:
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null,
    createdAt: payload.createdAt ?? payload.created_at ?? null,
    updatedAt: payload.updatedAt ?? payload.updated_at ?? null,
    raw: payload,
  };
};

export interface ResolveProjectInput {
  id?: string;
  name?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Daemon host to use when resolving by `cwd`. Required for the path-match
   * fallback (the server keys workspace bindings on `(daemonHost, path)`).
   * Defaults to `env.CONDUCTOR_DAEMON_NAME` if unset.
   */
  daemonHost?: string;
}

export interface CreateProjectInput {
  name?: string;
  workspacePath?: string;
  daemonHost?: string;
  isDefault?: boolean;
  clientRequestId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListProjectsOptions {
  includeHidden?: boolean;
}

export interface ProjectWriteOptions {
  /**
   * Extra metadata merged into the request (caller-supplied audit fields
   * under `metadata.audit` win over the SDK defaults, see shared.ts).
   */
  metadata?: Record<string, unknown>;
}

export class ProjectsApi {
  constructor(
    private readonly client: ApiClient,
    private readonly options: SdkClientOptions = {},
  ) {}

  async listProjects(options: ListProjectsOptions = {}): Promise<Project[]> {
    const summaries = await this.client.listProjects();
    // `BackendApiClient.listProjects` already pulls /projects, but it loses
    // the `hidden` and `isDefault` fields when collapsing to ProjectSummary.
    // Promote each summary's `asObject()` payload back to a Project so we
    // surface those fields. Hidden projects are filtered out here unless
    // `includeHidden: true` is passed (RFC 0025 §3).
    const promoted = summaries.map((summary) =>
      normalizeProject(
        // ProjectSummary `asObject()` always exists in the backend module.
        (summary as any).asObject ? (summary as any).asObject() : (summary as any),
      ),
    );
    if (options.includeHidden) {
      return promoted;
    }
    return promoted.filter((project) => !project.hidden);
  }

  async getProject(idOrName: string): Promise<Project> {
    const trimmed = String(idOrName ?? '').trim();
    if (!trimmed) {
      throw new Error('idOrName is required');
    }
    // First try by id; if 404, fall back to a unique name match against the
    // project list. Splitting these two paths keeps the happy-path single
    // round-trip and only pulls the full list on miss.
    try {
      const payload = await this.client.getProject(trimmed);
      return normalizeProject(payload as Record<string, any>);
    } catch (error) {
      if (!(error instanceof BackendApiError) || error.statusCode !== 404) {
        throw error;
      }
    }
    return this.findUniqueByName(trimmed);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const metadata = buildAuditMetadata(
      // `clientRequestId` is stamped onto metadata per RFC 0025 §5 idempotency
      // spec; the server treats it as the idempotency key.
      input.clientRequestId
        ? { clientRequestId: input.clientRequestId, ...(input.metadata ?? {}) }
        : input.metadata,
      this.options,
    );
    const params: Record<string, unknown> = {};
    if (input.name) {
      params.name = input.name;
    }
    if (input.isDefault) {
      params.isDefault = true;
      params.is_default = true;
    } else {
      // Non-default projects need a binding. The server validates with the
      // daemon synchronously when `daemonHost + workspacePath` are present,
      // which is the path AI / CLI will use most of the time.
      if (input.workspacePath) {
        params.workspacePath = input.workspacePath;
      }
      if (input.daemonHost) {
        params.daemonHost = input.daemonHost;
      }
    }
    params.metadata = metadata;
    const summary = await this.client.createProject(params);
    return normalizeProject(
      (summary as any).asObject ? (summary as any).asObject() : (summary as any),
    );
  }

  async setDefaultProject(
    idOrName: string,
    options: ProjectWriteOptions = {},
  ): Promise<Project> {
    // Short-circuit the pre-flight `getProject` when the caller already has
    // a project id (review L-NEW-1). On a miss the server returns 404 and
    // the caller can retry via `getProject(idOrName)` themselves, but the
    // common CLI path passes the id directly.
    const targetId = looksLikeProjectId(idOrName) ? idOrName.trim() : (await this.resolveById(idOrName)).id;
    const metadata = buildAuditMetadata(options.metadata, this.options);
    const payload = await this.client.setDefaultProject(targetId, { metadata });
    return normalizeProject(payload as Record<string, any>);
  }

  async setProjectHidden(
    idOrName: string,
    hidden: boolean,
    options: ProjectWriteOptions = {},
  ): Promise<Project> {
    const targetId = looksLikeProjectId(idOrName) ? idOrName.trim() : (await this.resolveById(idOrName)).id;
    const metadata = buildAuditMetadata(options.metadata, this.options);
    const payload = await this.client.patchProjectByQuery(targetId, { hidden, metadata });
    return normalizeProject(payload as Record<string, any>);
  }

  async resolveProject(input: ResolveProjectInput = {}): Promise<Project> {
    const env = input.env ?? this.options.env ?? process.env;

    // 1. explicit id wins
    if (input.id && input.id.trim()) {
      try {
        const payload = await this.client.getProject(input.id.trim());
        return normalizeProject(payload as Record<string, any>);
      } catch (error) {
        if (error instanceof BackendApiError && error.statusCode === 404) {
          throw new ProjectNotResolvedError(
            `Project not found: id=${input.id}`,
            'not_found',
          );
        }
        throw error;
      }
    }

    // 2. explicit name
    if (input.name && input.name.trim()) {
      return this.findUniqueByName(input.name.trim());
    }

    // 3. env override
    const envId = env.CONDUCTOR_PROJECT_ID;
    if (typeof envId === 'string' && envId.trim()) {
      try {
        const payload = await this.client.getProject(envId.trim());
        return normalizeProject(payload as Record<string, any>);
      } catch (error) {
        if (error instanceof BackendApiError && error.statusCode === 404) {
          throw new ProjectNotResolvedError(
            `Project not found from CONDUCTOR_PROJECT_ID=${envId}`,
            'not_found',
          );
        }
        throw error;
      }
    }

    // 4. cwd path match. We try two routes:
    //    a. If a daemon host is known, delegate to the server-side matcher
    //       (it understands binding-pending / repoRoot / multi-daemon rules).
    //    b. Otherwise, do a local longest-prefix match against the project
    //       list. This keeps the CLI usable when the user hasn't set
    //       CONDUCTOR_DAEMON_NAME — review finding M1: never silently skip
    //       cwd resolution just because a daemon hint is missing.
    const projects = await this.listProjects({ includeHidden: true });
    if (input.cwd && input.cwd.trim()) {
      const daemonHost =
        input.daemonHost ?? env.CONDUCTOR_DAEMON_NAME ?? env.CONDUCTOR_AGENT_NAME;
      if (daemonHost && daemonHost.trim()) {
        const result = await this.client.matchProjectByPath({
          daemon_host: daemonHost.trim(),
          path: input.cwd,
        });
        if (result.project) {
          return normalizeProject((result.project as any).asObject());
        }
      } else {
        const localMatch = matchProjectByLocalPrefix(projects, input.cwd);
        if (localMatch) {
          return localMatch;
        }
      }
    }

    // 5. default project — derived from the list we already fetched in (4).
    //    Every healthy account has at most one default; we return it when
    //    found.
    const defaults = projects.filter((project) => project.isDefault);
    if (defaults.length === 1) {
      return defaults[0];
    }
    if (defaults.length > 1) {
      throw new ProjectNotResolvedError(
        'Multiple default projects exist; specify --project explicitly',
        'multiple_matches',
      );
    }

    throw new ProjectNotResolvedError(
      'No project specified and no default project found. Pass --project <id|name>, set CONDUCTOR_PROJECT_ID, cd into a project directory, or configure a default project.',
      'no_signal',
    );
  }

  private async findUniqueByName(name: string): Promise<Project> {
    const projects = await this.listProjects({ includeHidden: true });
    const matches = projects.filter((project) => project.name === name);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length === 0) {
      throw new ProjectNotResolvedError(
        `No project found with name "${name}"`,
        'not_found',
      );
    }
    throw new ProjectNotResolvedError(
      `Multiple projects found with name "${name}" (${matches.length}); pass --project <id> to disambiguate`,
      'multiple_matches',
    );
  }

  private async resolveById(idOrName: string): Promise<Project> {
    return this.getProject(idOrName);
  }
}
