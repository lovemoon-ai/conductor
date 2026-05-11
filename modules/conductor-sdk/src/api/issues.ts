import { ApiClient, SdkClientOptions, buildAuditMetadata } from './shared.js';

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  position?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Unmodified server payload, used by callers that need fields we haven't typed. */
  raw: Record<string, unknown>;
}

const normalizeIssue = (payload: Record<string, any>): Issue => {
  const id = payload.id ? String(payload.id) : '';
  if (!id) {
    throw new Error('Issue payload missing id');
  }
  return {
    id,
    projectId: String(payload.projectId ?? payload.project_id ?? ''),
    title: String(payload.title ?? ''),
    description: payload.description ?? null,
    status: String(payload.status ?? ''),
    priority: payload.priority ?? null,
    position: typeof payload.position === 'number' ? payload.position : null,
    metadata:
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null,
    createdAt: payload.createdAt ?? payload.created_at ?? null,
    updatedAt: payload.updatedAt ?? payload.updated_at ?? null,
    raw: payload,
  };
};

const extractIssue = (payload: Record<string, any>): Record<string, any> => {
  // The PATCH /issues/[issueId] route returns `{ issue, activeTask, ... }`.
  // Other routes return the issue itself. Normalize both shapes here so
  // facade callers always get the issue back regardless of source endpoint.
  if (payload && typeof payload === 'object' && payload.issue && typeof payload.issue === 'object') {
    return payload.issue as Record<string, any>;
  }
  return payload;
};

const mergeMetadataAtPath = (
  target: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
): Record<string, unknown> => {
  if (pathParts.length === 0) {
    return target;
  }
  const [head, ...rest] = pathParts;
  const next = { ...target };
  if (rest.length === 0) {
    next[head] = value;
    return next;
  }
  const existing = target[head];
  const child =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  next[head] = mergeMetadataAtPath(child, rest, value);
  return next;
};

export interface ListIssuesInput {
  projectId: string;
  status?: string | string[];
  limit?: number;
}

export interface CreateIssueInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  priority?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateIssueStatusOptions {
  evidence?: string;
  /**
   * Extra metadata merged into the patch; caller's `audit.*` fields win over
   * SDK defaults (see shared.ts). Useful for the CLI to thread its
   * `audit: { actor: "cli", ... }` namespace through without needing a custom
   * call path.
   */
  metadata?: Record<string, unknown>;
}

export class IssuesApi {
  constructor(
    private readonly client: ApiClient,
    private readonly options: SdkClientOptions = {},
  ) {}

  async listIssues(input: ListIssuesInput): Promise<Issue[]> {
    if (!input.projectId) {
      throw new Error('projectId is required');
    }
    // The server `/api/issues` route accepts a single `status` query string;
    // it doesn't (yet) parse comma-separated lists, so we filter on the
    // client side for the multi-status case to match RFC 0025 §3 wording.
    const statusFilter = Array.isArray(input.status)
      ? input.status.map((value) => String(value).trim()).filter(Boolean)
      : input.status
        ? [String(input.status).trim()].filter(Boolean)
        : [];
    const issues = await this.client.listIssues({
      projectId: input.projectId,
      status: statusFilter.length === 1 ? statusFilter[0] : undefined,
    });
    let normalized = issues.map((entry) => normalizeIssue(entry));
    if (statusFilter.length > 1) {
      const statusSet = new Set(statusFilter);
      normalized = normalized.filter((issue) => statusSet.has(issue.status));
    }
    if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
      normalized = normalized.slice(0, Math.max(0, Math.floor(input.limit)));
    }
    return normalized;
  }

  async getIssue(issueId: string): Promise<Issue> {
    const trimmed = String(issueId ?? '').trim();
    if (!trimmed) {
      throw new Error('issueId is required');
    }
    const payload = await this.client.getIssue(trimmed);
    return normalizeIssue(extractIssue(payload as Record<string, any>));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    if (!input.projectId) {
      throw new Error('projectId is required');
    }
    if (!input.title) {
      throw new Error('title is required');
    }
    const userMetadata = input.clientRequestId
      ? { clientRequestId: input.clientRequestId, ...(input.metadata ?? {}) }
      : input.metadata;
    const metadata = buildAuditMetadata(userMetadata, this.options);
    const params: Record<string, unknown> = {
      projectId: input.projectId,
      title: input.title,
      metadata,
    };
    if (input.description !== undefined) {
      params.description = input.description;
    }
    if (input.priority !== undefined) {
      params.priority = input.priority;
    }
    if (input.status !== undefined) {
      params.status = input.status;
    }
    const payload = await this.client.createIssue(params);
    return normalizeIssue(extractIssue(payload as Record<string, any>));
  }

  async updateIssue(issueId: string, patch: UpdateIssueInput): Promise<Issue> {
    const trimmed = String(issueId ?? '').trim();
    if (!trimmed) {
      throw new Error('issueId is required');
    }
    const params: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      params.title = patch.title;
    }
    if (patch.description !== undefined) {
      params.description = patch.description;
    }
    if (patch.priority !== undefined) {
      params.priority = patch.priority;
    }
    if (patch.status !== undefined) {
      params.status = patch.status;
    }
    // We always include audit metadata on writes. If the caller passes a
    // `metadata` patch, we merge our audit keys with theirs (caller wins).
    params.metadata = buildAuditMetadata(patch.metadata, this.options);
    const payload = await this.client.patchIssue(trimmed, params);
    return normalizeIssue(extractIssue(payload as Record<string, any>));
  }

  async updateIssueStatus(
    issueId: string,
    status: string,
    options: UpdateIssueStatusOptions = {},
  ): Promise<Issue> {
    const callerMetadata =
      options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
        ? { ...(options.metadata as Record<string, unknown>) }
        : null;
    if (!options.evidence) {
      return this.updateIssue(issueId, {
        status,
        ...(callerMetadata ? { metadata: callerMetadata } : {}),
      });
    }
    // Pull the existing metadata so we can merge `qa.evidence` without
    // clobbering unrelated keys. The PATCH body fully replaces metadata, so
    // we have to round-trip the current state (matches RFC 0025 §3 wording
    // for `done --evidence`).
    const existing = await this.getIssue(issueId);
    const existingMetadata =
      existing.metadata && typeof existing.metadata === 'object'
        ? (existing.metadata as Record<string, unknown>)
        : {};
    // Merge order: existing DB metadata < caller's patch metadata < qa.evidence.
    // The `audit` key under `callerMetadata` is preserved when present so the
    // CLI's `actor:"cli"` namespace flows through to `updateIssue` (and from
    // there to `buildAuditMetadata`, where caller wins).
    const baseMetadata = callerMetadata
      ? { ...existingMetadata, ...callerMetadata }
      : { ...existingMetadata };
    const merged = mergeMetadataAtPath(baseMetadata, ['qa', 'evidence'], options.evidence);
    return this.updateIssue(issueId, { status, metadata: merged });
  }

  async deleteIssue(issueId: string): Promise<void> {
    const trimmed = String(issueId ?? '').trim();
    if (!trimmed) {
      throw new Error('issueId is required');
    }
    await this.client.deleteIssue(trimmed);
  }
}
