/**
 * Contract tests for ProjectsApi against a mock fetch that asserts:
 *   - bind() does match-path first, then POST /api/projects only on miss
 *   - bind() stamps metadata.audit.createdByApp
 *   - list() / get() normalize snake_case backend payloads to camelCase
 */
import { describe, it, expect, vi } from 'vitest';
import { connect } from '../../src/server/index.js';

interface CallLog {
  method: string;
  url: string;
  body: unknown;
}

function makeRecordingFetch(
  handler: (call: CallLog) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    let parsedBody: unknown = null;
    if (typeof init?.body === 'string' && init.body) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const call: CallLog = { method: init?.method ?? 'GET', url, body: parsedBody };
    calls.push(call);
    return await handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const RAW_PROJECT = {
  id: 'p_1',
  name: 'Acme Dashboard',
  daemon_host: 'duino-mbp',
  workspace_path: '/Users/me/work/acme',
  repo_root: '/Users/me/work/acme',
  worktree_branch: 'main',
  last_commit: 'abc123',
  last_commit_at: '2026-05-17T00:00:00Z',
  file_count: 42,
  is_default: false,
  metadata: {
    ownership: { kind: 'app', ownerTokenId: 'tok_x', appDisplayName: 'Acme' },
  },
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-17T00:00:00Z',
};

describe('ProjectsApi.bind', () => {
  it('returns existing project from match-path (no POST /api/projects)', async () => {
    const { fetch, calls } = makeRecordingFetch((call) => {
      if (call.url.endsWith('/api/projects/match-path')) {
        return new Response(
          JSON.stringify({ project: RAW_PROJECT, matched_path: '/Users/me/work/acme' }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected call ${call.method} ${call.url}`);
    });
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
    });
    const project = await client.projects.bind({
      name: 'Acme Dashboard',
      daemonHost: 'duino-mbp',
      workspacePath: '/Users/me/work/acme',
    });
    expect(project.id).toBe('p_1');
    expect(project.daemonHost).toBe('duino-mbp');
    expect(project.workspacePath).toBe('/Users/me/work/acme');
    expect(project.fileCount).toBe(42);
    expect(project.createdByApp).toBe(true); // from metadata.ownership.kind=='app'
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/projects\/match-path$/);
    await client.close();
  });

  it('creates a new project when match-path returns null and stamps audit metadata', async () => {
    const { fetch, calls } = makeRecordingFetch((call) => {
      if (call.url.endsWith('/api/projects/match-path')) {
        return new Response(JSON.stringify({ project: null, matched_path: null }), {
          status: 200,
        });
      }
      if (call.method === 'POST' && call.url.endsWith('/api/projects')) {
        // Backend echoes back a confirmed project.
        return new Response(JSON.stringify(RAW_PROJECT), { status: 200 });
      }
      throw new Error(`unexpected call ${call.method} ${call.url}`);
    });
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
    });
    const project = await client.projects.bind({
      name: 'Acme Dashboard',
      daemonHost: 'duino-mbp',
      workspacePath: '/Users/me/work/acme',
    });
    expect(project.id).toBe('p_1');
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toMatch(/\/api\/projects$/);
    const body = calls[1].body as Record<string, unknown>;
    expect(body.name).toBe('Acme Dashboard');
    expect(body.daemonHost).toBe('duino-mbp');
    expect(body.workspacePath).toBe('/Users/me/work/acme');
    const audit = (body.metadata as { audit?: { createdByApp?: { name?: string } } })?.audit;
    expect(audit?.createdByApp?.name).toBe('Acme Dashboard');
    await client.close();
  });

  it('propagates daemon_offline error from POST /api/projects', async () => {
    const { fetch } = makeRecordingFetch((call) => {
      if (call.url.endsWith('/api/projects/match-path')) {
        return new Response(JSON.stringify({ project: null }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: 'Project daemon duino-mbp is offline' }),
        { status: 409 },
      );
    });
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
    });
    await expect(
      client.projects.bind({
        name: 'Acme',
        daemonHost: 'duino-mbp',
        workspacePath: '/x',
      }),
    ).rejects.toMatchObject({ code: 'daemon_offline' });
    await client.close();
  });

  it('rejects on missing required fields without hitting the network', async () => {
    const fetch = vi.fn();
    const client = await connect({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: fetch as never,
    });
    await expect(
      client.projects.bind({ name: '', daemonHost: 'h', workspacePath: '/x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      client.projects.bind({ name: 'x', daemonHost: '', workspacePath: '/x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      client.projects.bind({ name: 'x', daemonHost: 'h', workspacePath: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('ProjectsApi.list', () => {
  it('normalizes a bare array response', async () => {
    const { fetch } = makeRecordingFetch(
      () => new Response(JSON.stringify([RAW_PROJECT]), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const projects = await client.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0].daemonHost).toBe('duino-mbp');
    await client.close();
  });

  it('normalizes a { projects: [...] } response', async () => {
    const { fetch } = makeRecordingFetch(
      () => new Response(JSON.stringify({ projects: [RAW_PROJECT] }), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const projects = await client.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('p_1');
    await client.close();
  });
});
