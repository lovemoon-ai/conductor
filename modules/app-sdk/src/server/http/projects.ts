/**
 * ProjectsApi: find-or-create + read operations against `/api/projects/*`.
 */
import { ConductorAppError } from '../../types/errors.js';
import type { BindProjectInput, Project } from '../../types/project.js';
import type { Fetcher } from '../fetcher.js';
import { normalizeProject } from '../normalize.js';
import { SDK_NAME, SDK_VERSION } from '../../index.js';

export class ProjectsApi {
  /** @internal — constructed by `AppClient`; not part of the public surface. */
  constructor(private readonly fetcher: Fetcher) {}

  /**
   * Idempotent find-or-create on (daemonHost, workspacePath).
   *
   * Flow:
   *   1. POST `/api/projects/match-path` with `{ daemonHost, path: workspacePath }`.
   *      If a project matches (or is a parent of) the path, return it.
   *   2. Otherwise POST `/api/projects` with binding fields. The server
   *      validates the binding with the user's daemon. Success returns the
   *      new project; daemon-offline returns 409 → mapped to `daemon_offline`.
   *
   * The created project carries `metadata.audit.createdByApp` so it can be
   * distinguished in the main Conductor UI later. No new schema is required.
   */
  async bind(
    input: BindProjectInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Project> {
    const name = input.name?.trim();
    const daemonHost = input.daemonHost?.trim();
    const workspacePath = input.workspacePath?.trim();
    if (!name || !daemonHost || !workspacePath) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message:
          'projects.bind requires non-empty name, daemonHost, and workspacePath',
      });
    }

    // 1) find by binding identity.
    const match = await this.fetcher.request<MatchPathResponse>({
      method: 'POST',
      path: '/api/projects/match-path',
      body: { daemonHost, path: workspacePath },
      signal: opts?.signal,
    });
    if (match?.project) {
      return normalizeProject(match.project);
    }

    // 2) create with confirmed binding fields. The backend will reach out to
    //    the daemon to validate the path (see `validateProjectBindingWithDaemon`
    //    in web/src/app/api/projects/route.ts).
    const created = await this.fetcher.request<unknown>({
      method: 'POST',
      path: '/api/projects',
      body: {
        name,
        daemonHost,
        workspacePath,
        metadata: {
          audit: {
            createdByApp: {
              name: input.appLabel ?? name,
              sdkName: SDK_NAME,
              sdkVersion: SDK_VERSION,
            },
          },
        },
      },
      signal: opts?.signal,
    });
    return normalizeProject(created);
  }

  async list(opts?: { signal?: AbortSignal }): Promise<Project[]> {
    const raw = await this.fetcher.request<ListProjectsResponse>({
      method: 'GET',
      path: '/api/projects',
      signal: opts?.signal,
    });
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { projects?: unknown }).projects)
        ? (raw as { projects: unknown[] }).projects
        : [];
    return list.map((entry) => normalizeProject(entry));
  }

  async get(projectId: string, opts?: { signal?: AbortSignal }): Promise<Project> {
    if (!projectId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'projects.get requires a projectId',
      });
    }
    const raw = await this.fetcher.request({
      method: 'GET',
      path: '/api/projects',
      query: { projectId },
      signal: opts?.signal,
    });
    // `/api/projects?projectId=...` returns a single project or wrapped list.
    if (raw && typeof raw === 'object' && 'projects' in raw) {
      const list = (raw as { projects?: unknown[] }).projects ?? [];
      if (list.length === 0) {
        throw new ConductorAppError({
          code: 'project_not_found',
          message: `Project ${projectId} not found`,
        });
      }
      return normalizeProject(list[0]);
    }
    return normalizeProject(raw);
  }
}

type MatchPathResponse = {
  project: unknown | null;
  matched_path?: string | null;
};

type ListProjectsResponse = unknown[] | { projects?: unknown[] };
