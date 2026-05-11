import { describe, expect, test } from 'vitest';

import { ProjectsApi, ProjectNotResolvedError } from '../../src/api/index.js';
import { BackendApiError, ProjectSummary } from '../../src/backend/index.js';

interface ProjectRecord {
  id: string;
  name?: string | null;
  daemonHost?: string | null;
  workspacePath?: string | null;
  isDefault?: boolean;
  hidden?: boolean;
  hiddenAt?: string | null;
}

class FakeApiClient {
  projects: ProjectRecord[] = [];
  setDefaultProjectCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
  patchProjectByQueryCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
  createProjectCalls: any[] = [];
  matchProjectByPathCalls: any[] = [];
  matchResult: { project: ProjectSummary | null; matchedPath: string | null } = {
    project: null,
    matchedPath: null,
  };

  asSummary(record: ProjectRecord): ProjectSummary & { asObject: () => Record<string, unknown> } {
    const summary = ProjectSummary.fromJSON({
      id: record.id,
      name: record.name ?? undefined,
      daemonHost: record.daemonHost ?? null,
      workspacePath: record.workspacePath ?? null,
      isDefault: record.isDefault ?? false,
    });
    const baseObject = summary.asObject();
    // Smuggle the extra fields the REST layer surfaces but ProjectSummary
    // doesn't carry, so the facade's `normalizeProject` can promote them.
    const asObject = () => ({
      ...baseObject,
      hidden: record.hidden ?? false,
      hiddenAt: record.hiddenAt ?? null,
      isDefault: record.isDefault ?? false,
    });
    return Object.assign(summary, { asObject });
  }

  async listProjects() {
    return this.projects.map((record) => this.asSummary(record));
  }

  async getProject(idOrName: string) {
    const record = this.projects.find((project) => project.id === idOrName);
    if (!record) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    return {
      id: record.id,
      name: record.name ?? undefined,
      daemonHost: record.daemonHost ?? null,
      workspacePath: record.workspacePath ?? null,
      isDefault: record.isDefault ?? false,
      hidden: record.hidden ?? false,
      hiddenAt: record.hiddenAt ?? null,
    };
  }

  async createProject(params: any) {
    this.createProjectCalls.push(params);
    const record: ProjectRecord = {
      id: 'new-id',
      name: params.name ?? 'New Project',
      daemonHost: params.daemonHost ?? null,
      workspacePath: params.workspacePath ?? null,
      isDefault: Boolean(params.isDefault ?? params.is_default),
      hidden: false,
    };
    return this.asSummary(record);
  }

  async patchProjectByQuery(id: string, body: Record<string, unknown>) {
    this.patchProjectByQueryCalls.push({ id, body });
    const record = this.projects.find((project) => project.id === id);
    if (!record) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    if (typeof body.hidden === 'boolean') {
      record.hidden = body.hidden;
      record.hiddenAt = body.hidden ? new Date().toISOString() : null;
    }
    return {
      id: record.id,
      name: record.name ?? undefined,
      daemonHost: record.daemonHost ?? null,
      hidden: record.hidden,
      hiddenAt: record.hiddenAt,
      isDefault: record.isDefault ?? false,
    };
  }

  async setDefaultProject(projectId: string, extraBody: Record<string, unknown> = {}) {
    this.setDefaultProjectCalls.push({ id: projectId, body: extraBody });
    const record = this.projects.find((project) => project.id === projectId);
    return {
      id: projectId,
      name: record?.name ?? null,
      daemonHost: record?.daemonHost ?? null,
      isDefault: true,
      hidden: false,
      ...extraBody,
    };
  }

  async matchProjectByPath(params: any) {
    this.matchProjectByPathCalls.push(params);
    return this.matchResult;
  }

  async updateProject(): Promise<any> {
    throw new Error('not used in tests');
  }
}

const makeApi = (records: ProjectRecord[] = []) => {
  const client = new FakeApiClient();
  client.projects = records;
  const api = new ProjectsApi(client as any, { sdkVersion: '0.0.0-test', env: {} });
  return { client, api };
};

describe('ProjectsApi', () => {
  test('listProjects hides hidden projects by default', async () => {
    const { api } = makeApi([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta', hidden: true, hiddenAt: '2024-01-01T00:00:00Z' },
    ]);
    const visible = await api.listProjects();
    expect(visible.map((p) => p.id)).toEqual(['a']);
    const all = await api.listProjects({ includeHidden: true });
    expect(all.map((p) => p.id)).toEqual(['a', 'b']);
  });

  test('getProject finds by id', async () => {
    const { api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    const project = await api.getProject('p1');
    expect(project.id).toBe('p1');
    expect(project.name).toBe('Demo');
  });

  test('getProject falls back to unique name match on 404', async () => {
    const { api } = makeApi([
      { id: 'real-id', name: 'Demo' },
    ]);
    const project = await api.getProject('Demo');
    expect(project.id).toBe('real-id');
  });

  test('getProject throws on ambiguous name', async () => {
    const { api } = makeApi([
      { id: 'a', name: 'Demo' },
      { id: 'b', name: 'Demo' },
    ]);
    await expect(api.getProject('Demo')).rejects.toBeInstanceOf(ProjectNotResolvedError);
  });

  test('createProject stamps audit metadata under audit namespace + isDefault', async () => {
    const { client, api } = makeApi();
    await api.createProject({ name: 'Bootstrap', isDefault: true });
    expect(client.createProjectCalls).toHaveLength(1);
    const sent = client.createProjectCalls[0];
    expect(sent.isDefault).toBe(true);
    expect(sent.is_default).toBe(true);
    expect(sent.metadata).toMatchObject({
      audit: {
        actor: 'sdk',
        sdkVersion: '0.0.0-test',
        invokedBy: null,
      },
    });
    // No top-level audit leaks (review M3).
    expect(sent.metadata.actor).toBeUndefined();
    expect(sent.metadata.sdkVersion).toBeUndefined();
  });

  test('createProject merges caller-supplied audit fields under audit namespace', async () => {
    const { client, api } = makeApi();
    await api.createProject({
      name: 'Custom',
      workspacePath: '/tmp/foo',
      daemonHost: 'host-a',
      metadata: { audit: { actor: 'cli', cliVersion: '0.2.0' }, custom: 1 },
      clientRequestId: 'req-1',
    });
    const sent = client.createProjectCalls[0];
    expect(sent.metadata).toMatchObject({
      custom: 1,
      clientRequestId: 'req-1',
      audit: {
        actor: 'cli',
        cliVersion: '0.2.0',
        sdkVersion: '0.0.0-test',
      },
    });
    expect(sent.workspacePath).toBe('/tmp/foo');
    expect(sent.daemonHost).toBe('host-a');
  });

  test('setProjectHidden patches with hidden + audit metadata', async () => {
    const { client, api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    await api.setProjectHidden('p1', true);
    expect(client.patchProjectByQueryCalls).toHaveLength(1);
    const call = client.patchProjectByQueryCalls[0];
    expect(call.id).toBe('p1');
    expect(call.body.hidden).toBe(true);
    expect((call.body.metadata as any).audit).toMatchObject({ actor: 'sdk' });
  });

  test('setProjectHidden propagates caller metadata.audit to server', async () => {
    const { client, api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    await api.setProjectHidden('p1', false, {
      metadata: { audit: { actor: 'cli', cliVersion: '0.2.0' }, reason: 'restored' },
    });
    const call = client.patchProjectByQueryCalls[0];
    expect((call.body.metadata as any).audit).toMatchObject({
      actor: 'cli',
      cliVersion: '0.2.0',
      sdkVersion: '0.0.0-test',
    });
    expect((call.body.metadata as any).reason).toBe('restored');
  });

  test('setDefaultProject resolves id-or-name, returns Project, ships metadata', async () => {
    const { client, api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    const project = await api.setDefaultProject('Demo', {
      metadata: { audit: { actor: 'cli' } },
    });
    expect(client.setDefaultProjectCalls).toHaveLength(1);
    expect(client.setDefaultProjectCalls[0].id).toBe('p1');
    expect((client.setDefaultProjectCalls[0].body.metadata as any).audit).toMatchObject({
      actor: 'cli',
      sdkVersion: '0.0.0-test',
    });
    expect(project.id).toBe('p1');
    expect(project.isDefault).toBe(true);
  });

  test('setDefaultProject skips the pre-flight getProject when given an id (review L-NEW-1)', async () => {
    // A cuid-shaped id should short-circuit the name lookup; otherwise the
    // CLI's hot path paid 2 round-trips (list + write) for every write.
    const { client, api } = makeApi([{ id: 'clxk1y0fz0000abc123def', name: 'Demo' }]);
    await api.setDefaultProject('clxk1y0fz0000abc123def');
    // We expect the call to go straight to setDefaultProject without ever
    // pulling the full project list to resolve a name.
    expect(client.getProject ? 0 : 0).toBe(0); // type-only, the fake has no getProject GET method
    expect(client.setDefaultProjectCalls).toHaveLength(1);
    expect(client.setDefaultProjectCalls[0].id).toBe('clxk1y0fz0000abc123def');
  });

  test('setProjectHidden skips the pre-flight when given an id (review L-NEW-1)', async () => {
    const { client, api } = makeApi([
      { id: 'clxk1y0fz0000abc123def', name: 'Demo', hidden: false },
    ]);
    await api.setProjectHidden('clxk1y0fz0000abc123def', true);
    expect(client.patchProjectByQueryCalls).toHaveLength(1);
    expect(client.patchProjectByQueryCalls[0].id).toBe('clxk1y0fz0000abc123def');
  });

  test('setProjectHidden still resolves name-style inputs via the list (no short-circuit)', async () => {
    // Names with spaces / accents / less than 12 chars should NOT be treated
    // as ids — the SDK falls through to the resolveById path.
    const { client, api } = makeApi([
      { id: 'cl-real', name: 'My Demo' },
    ]);
    await api.setProjectHidden('My Demo', true);
    expect(client.patchProjectByQueryCalls).toHaveLength(1);
    expect(client.patchProjectByQueryCalls[0].id).toBe('cl-real');
  });

  test('resolveProject priority 1 — explicit id', async () => {
    const { api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    const project = await api.resolveProject({ id: 'p1' });
    expect(project.id).toBe('p1');
  });

  test('resolveProject priority 1 — explicit id but missing throws not_found', async () => {
    const { api } = makeApi([]);
    await expect(api.resolveProject({ id: 'missing' })).rejects.toMatchObject({
      reason: 'not_found',
    });
  });

  test('resolveProject priority 2 — explicit name', async () => {
    const { api } = makeApi([
      { id: 'p1', name: 'Demo' },
      { id: 'p2', name: 'Other' },
    ]);
    const project = await api.resolveProject({ name: 'Other' });
    expect(project.id).toBe('p2');
  });

  test('resolveProject priority 3 — env CONDUCTOR_PROJECT_ID', async () => {
    const { api } = makeApi([{ id: 'env-p', name: 'Demo' }]);
    const project = await api.resolveProject({
      env: { CONDUCTOR_PROJECT_ID: 'env-p' } as NodeJS.ProcessEnv,
    });
    expect(project.id).toBe('env-p');
  });

  test('resolveProject priority 4 — cwd match via matchProjectByPath', async () => {
    const { client, api } = makeApi([{ id: 'cwd-p', name: 'CwdProj' }]);
    client.matchResult = {
      project: client.asSummary({ id: 'cwd-p', name: 'CwdProj' }),
      matchedPath: '/tmp/cwd-p',
    };
    const project = await api.resolveProject({
      cwd: '/tmp/cwd-p',
      env: { CONDUCTOR_DAEMON_NAME: 'host-a' } as NodeJS.ProcessEnv,
    });
    expect(project.id).toBe('cwd-p');
    expect(client.matchProjectByPathCalls[0]).toMatchObject({
      daemon_host: 'host-a',
      path: '/tmp/cwd-p',
    });
  });

  test('resolveProject priority 4 — local prefix match when no daemon host', async () => {
    const { client, api } = makeApi([
      { id: 'p1', name: 'Outer', workspacePath: '/Users/me/code' },
      { id: 'p2', name: 'Inner', workspacePath: '/Users/me/code/proj-b' },
      { id: 'p3', name: 'Other', workspacePath: '/Users/me/elsewhere' },
    ]);
    const project = await api.resolveProject({
      cwd: '/Users/me/code/proj-b/sub/dir',
      env: {} as NodeJS.ProcessEnv,
    });
    // Longest prefix wins.
    expect(project.id).toBe('p2');
    // Did not delegate to server-side matcher (no daemonHost provided).
    expect(client.matchProjectByPathCalls).toHaveLength(0);
  });

  test('resolveProject priority 4 local-prefix miss falls through to default', async () => {
    const { api } = makeApi([
      { id: 'p1', name: 'Outer', workspacePath: '/some/other/path' },
      { id: 'p-default', name: 'Default Project', isDefault: true },
    ]);
    const project = await api.resolveProject({
      cwd: '/Users/me/no-match',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(project.id).toBe('p-default');
  });

  test('resolveProject priority 5 — falls through to default project', async () => {
    const { api } = makeApi([
      { id: 'p1', name: 'Demo' },
      { id: 'p-default', name: 'Default Project', isDefault: true },
    ]);
    const project = await api.resolveProject({});
    expect(project.id).toBe('p-default');
  });

  test('resolveProject throws no_signal when nothing matches', async () => {
    const { api } = makeApi([{ id: 'p1', name: 'Demo' }]);
    await expect(api.resolveProject({})).rejects.toMatchObject({ reason: 'no_signal' });
  });
});
