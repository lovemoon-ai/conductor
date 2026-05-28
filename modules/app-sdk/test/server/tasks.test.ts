/**
 * Contract tests for TasksApi REST methods.
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

const RAW_TASK = {
  id: 't_1',
  project_id: 'p_1',
  title: 'Investigate billing',
  status: 'running',
  backend_type: 'claude_code',
  session_id: null,
  session_file_path: null,
  created_at: '2026-05-17T00:00:00Z',
  updated_at: '2026-05-17T00:01:00Z',
};

const RAW_MESSAGE = {
  id: 'm_1',
  task_id: 't_1',
  role: 'sdk',
  content: 'hello',
  metadata: { audit: { actor: 'app' } },
  attachments: [],
  created_at: '2026-05-17T00:00:00Z',
};

describe('TasksApi.create', () => {
  it('POSTs snake_case body + initialMessage → initial_content', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_TASK), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const task = await client.tasks.create({
      projectId: 'p_1',
      title: 'Investigate billing',
      initialMessage: 'look at last 24h',
      backendType: 'claude_code',
    });
    expect(task.id).toBe('t_1');
    expect(task.projectId).toBe('p_1');
    expect(task.backendType).toBe('claude_code');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/tasks$/);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.project_id).toBe('p_1');
    expect(body.title).toBe('Investigate billing');
    expect(body.initial_content).toBe('look at last 24h');
    expect(body.backend_type).toBe('claude_code');
    expect(body.task_type).toBe('ai_task');
    await client.close();
  });

  it('validates required fields without hitting fetch', async () => {
    const fetch = vi.fn();
    const client = await connect({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: fetch as never,
    });
    await expect(
      client.tasks.create({ projectId: '', title: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      client.tasks.create({ projectId: 'p', title: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Whitespace-only title is rejected (treated as empty) — and never hits fetch.
    await expect(
      client.tasks.create({ projectId: 'p', title: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('trims title before sending', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_TASK), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.create({ projectId: 'p_1', title: '  trimmed  ' });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.title).toBe('trimmed');
    await client.close();
  });
});

describe('TasksApi.get', () => {
  it('GETs the task by id and normalizes the payload', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_TASK), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const task = await client.tasks.get('t_1');
    expect(task.id).toBe('t_1');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t_1$/);
    await client.close();
  });

  it('encodes special characters in taskId', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_TASK), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.get('t/with slash');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t%2Fwith%20slash$/);
    await client.close();
  });
});

describe('TasksApi.sendMessage', () => {
  it('POSTs with auto-generated clientRequestId + audit metadata', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_MESSAGE), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const msg = await client.tasks.sendMessage('t_1', 'hello');
    expect(msg.id).toBe('m_1');
    expect(msg.role).toBe('sdk');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t_1\/messages$/);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.content).toBe('hello');
    expect(body.role).toBe('sdk');
    expect(typeof body.clientRequestId).toBe('string');
    expect((body.clientRequestId as string).length).toBeGreaterThan(0);
    const audit = (body.metadata as { audit?: { actor?: string } }).audit;
    expect(audit?.actor).toBe('app');
    await client.close();
  });

  it('cannot be defeated by caller-supplied audit.actor (security)', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_MESSAGE), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.sendMessage('t_1', {
      content: 'hello',
      metadata: {
        // Caller tries to forge actor='fake' and sneaky sdkName/sdkVersion.
        audit: { actor: 'fake', sdkName: 'evil', sdkVersion: '99', custom: 'ok' },
        other: 'preserved',
      },
    });
    const body = calls[0].body as Record<string, unknown>;
    const audit = (body.metadata as { audit: Record<string, unknown> }).audit;
    // SDK fields always win.
    expect(audit.actor).toBe('app');
    expect(audit.sdkName).toMatch(/^@love-moon\/app-sdk$/);
    expect(audit.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    // Other audit keys + sibling metadata keys still flow through.
    expect(audit.custom).toBe('ok');
    expect((body.metadata as Record<string, unknown>).other).toBe('preserved');
    await client.close();
  });

  it('respects caller-supplied clientRequestId', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response(JSON.stringify(RAW_MESSAGE), { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.sendMessage('t_1', {
      content: 'hello',
      clientRequestId: 'abc-123',
    });
    expect((calls[0].body as { clientRequestId?: string }).clientRequestId).toBe('abc-123');
    await client.close();
  });

  it('rejects empty content', async () => {
    const fetch = vi.fn();
    const client = await connect({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: fetch as never,
    });
    await expect(client.tasks.sendMessage('t_1', '   ')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('TasksApi.history', () => {
  it('GETs paginated history and normalizes', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () =>
        new Response(
          JSON.stringify({
            messages: [RAW_MESSAGE, RAW_MESSAGE],
            pagination: {
              has_more_before: true,
              oldest_message_id: 'm_oldest',
              page_size: 50,
            },
          }),
          { status: 200 },
        ),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    const page = await client.tasks.history('t_1', { beforeId: 'm_x', limit: 50 });
    expect(page.messages).toHaveLength(2);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.oldestMessageId).toBe('m_oldest');
    expect(calls[0].url).toMatch(/before_id=m_x/);
    expect(calls[0].url).toMatch(/limit=50/);
    expect(calls[0].url).toMatch(/pagination=1/);
    await client.close();
  });
});

describe('TasksApi.interrupt', () => {
  it('POSTs target_reply_to', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response('{}', { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.interrupt('t_1', { targetReplyTo: 'r_42' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t_1\/interrupt$/);
    expect((calls[0].body as { target_reply_to?: string }).target_reply_to).toBe('r_42');
    await client.close();
  });

  it('validates required fields', async () => {
    const fetch = vi.fn();
    const client = await connect({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: fetch as never,
    });
    await expect(
      client.tasks.interrupt('', { targetReplyTo: 'r_1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      client.tasks.interrupt('t_1', { targetReplyTo: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('TasksApi.restart', () => {
  it('POSTs restart_mode when provided', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response('{}', { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.restart('t_1', { restartMode: 'refresh_session' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t_1\/restart$/);
    expect((calls[0].body as { restart_mode?: string }).restart_mode).toBe('refresh_session');
    await client.close();
  });

  it('omits restart_mode when not provided (empty body)', async () => {
    const { fetch, calls } = makeRecordingFetch(
      () => new Response('{}', { status: 200 }),
    );
    const client = await connect({ baseUrl: 'http://x', bearerToken: 'tok', fetch });
    await client.tasks.restart('t_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/tasks\/t_1\/restart$/);
    expect((calls[0].body as Record<string, unknown>).restart_mode).toBeUndefined();
    await client.close();
  });

  it('validates required taskId', async () => {
    const fetch = vi.fn();
    const client = await connect({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: fetch as never,
    });
    await expect(client.tasks.restart('')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });
});
