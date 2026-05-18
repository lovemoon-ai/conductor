/**
 * Fetcher unit tests: auth/header injection, error mapping, timeout, abort,
 * 404 soft-miss, JSON parse errors, 401 onUnauthorized hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { Fetcher } from '../../src/server/fetcher.js';
import { ConductorAppError } from '../../src/types/errors.js';

function makeMockFetch(responses: Array<Response | ((req: Request) => Response | Promise<Response>)>) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as string, init);
    const entry = responses[i++] ?? responses[responses.length - 1];
    if (typeof entry === 'function') return entry(req);
    return entry;
  });
}

describe('Fetcher', () => {
  it('injects Authorization, Accept, User-Agent', async () => {
    const seenHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.forEach((v, k) => {
        seenHeaders[k.toLowerCase()] = v;
      });
      return new Response('{"ok":true}', { status: 200 });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok-abc',
      fetch: mockFetch as never,
    });
    await fetcher.request({ method: 'GET', path: '/api/x' });
    expect(seenHeaders['authorization']).toBe('Bearer tok-abc');
    expect(seenHeaders['accept']).toBe('application/json');
    expect(seenHeaders['user-agent']).toMatch(/^conductor-app-sdk\//);
  });

  it('resolves async token providers', async () => {
    const provider = vi.fn(async () => 'rotated-token');
    const mockFetch = vi.fn(async (_input, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      expect(auth).toBe('Bearer rotated-token');
      return new Response('{}', { status: 200 });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: provider,
      fetch: mockFetch as never,
    });
    await fetcher.request({ method: 'GET', path: '/api/x' });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('serializes JSON bodies and sets content-type', async () => {
    const mockFetch = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.body).toBe('{"a":1}');
      const ct = new Headers(init?.headers).get('content-type');
      expect(ct).toBe('application/json');
      return new Response('{}', { status: 200 });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: mockFetch as never,
    });
    await fetcher.request({ method: 'POST', path: '/api/x', body: { a: 1 } });
  });

  it('maps 401 → ConductorAppError code unauthorized + calls onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('{"error":"nope"}', { status: 401 })]) as never,
      onUnauthorized,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/x' })).rejects.toMatchObject({
      name: 'ConductorAppError',
      code: 'unauthorized',
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('maps 404 task → code task_not_found', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('{"error":"Task not found"}', { status: 404 })]) as never,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/tasks/t1' })).rejects.toMatchObject({
      code: 'task_not_found',
    });
  });

  it('maps 404 project → code project_not_found', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('{"error":"Project not found"}', { status: 404 })]) as never,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/projects' })).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });

  it('honors resolveOn404 — returns undefined instead of throwing', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('', { status: 404 })]) as never,
    });
    const res = await fetcher.request({ method: 'GET', path: '/api/x', resolveOn404: true });
    expect(res).toBeUndefined();
  });

  it('maps 409 daemon offline → daemon_offline', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([
        new Response('{"error":"Project daemon foo is offline"}', { status: 409 }),
      ]) as never,
    });
    await expect(fetcher.request({ method: 'POST', path: '/api/tasks' })).rejects.toMatchObject({
      code: 'daemon_offline',
    });
  });

  it('maps 429 → rate_limited', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('{}', { status: 429 })]) as never,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/x' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps 500 → server_error', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('boom', { status: 500 })]) as never,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/x' })).rejects.toMatchObject({
      code: 'server_error',
      status: 500,
    });
  });

  it('times out and throws code timeout', async () => {
    const slowFetch = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        });
        // never resolves otherwise
      });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: slowFetch as never,
    });
    await expect(
      fetcher.request({ method: 'GET', path: '/api/x', timeoutMs: 25 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('propagates caller-supplied AbortSignal as stream_aborted', async () => {
    const controller = new AbortController();
    // Mock fetch must check `signal.aborted` synchronously *before*
    // registering its abort listener — otherwise an already-aborted signal
    // (the case when caller aborts before fetch is called) is silently
    // dropped. This is exactly how native fetch behaves.
    const slowFetch = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort);
      });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: slowFetch as never,
    });
    const promise = fetcher.request({
      method: 'GET',
      path: '/api/x',
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'stream_aborted' });
  });

  it('handles 204 No Content', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response(null, { status: 204 })]) as never,
    });
    const res = await fetcher.request({ method: 'POST', path: '/api/x' });
    expect(res).toBeUndefined();
  });

  it('throws server_error on non-JSON 200 body', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      fetch: makeMockFetch([new Response('<html>err</html>', { status: 200 })]) as never,
    });
    await expect(fetcher.request({ method: 'GET', path: '/api/x' })).rejects.toMatchObject({
      code: 'server_error',
    });
  });

  it('encodes query params', async () => {
    let seenUrl = '';
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response('{}', { status: 200 });
    });
    const fetcher = new Fetcher({
      baseUrl: 'http://x/',
      bearerToken: 'tok',
      fetch: mockFetch as never,
    });
    await fetcher.request({
      method: 'GET',
      path: '/api/x',
      query: { a: 1, b: 'hello world', c: undefined, d: null },
    });
    expect(seenUrl).toBe('http://x/api/x?a=1&b=hello+world');
  });

  it('rejects when bearerToken provider returns empty', async () => {
    const fetcher = new Fetcher({
      baseUrl: 'http://x',
      bearerToken: async () => '',
      fetch: vi.fn() as never,
    });
    await expect(
      fetcher.request({ method: 'GET', path: '/api/x' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('throws invalid_input when no fetch impl is available', () => {
    const realFetch = globalThis.fetch;
    // Pretend globalThis.fetch is missing (covers Node <18 deployments).
    // @ts-expect-error — patching global for this single assertion.
    delete globalThis.fetch;
    try {
      expect(
        () =>
          new Fetcher({
            baseUrl: 'http://x',
            bearerToken: 'tok',
          }),
      ).toThrow(ConductorAppError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
