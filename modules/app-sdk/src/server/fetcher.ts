/**
 * Internal HTTP client used by all `/server` modules.
 *
 * Responsibilities:
 *   - Resolve bearer token (string or async provider) per request.
 *   - Inject `Authorization`, `Accept`, `User-Agent`.
 *   - Apply per-request timeout via AbortController, composed with the
 *     caller-supplied `signal`.
 *   - Normalize all error paths (HTTP non-2xx, network failure, JSON parse
 *     failure, timeout, abort) into ConductorAppError.
 *   - Honor `onUnauthorized` callback on 401 (fire-and-forget; we still throw).
 *
 * Not responsible: retry/backoff. Callers add retries at the API layer where
 * idempotency semantics are known.
 */
import { ConductorAppError } from '../types/errors.js';
import { mapHttpStatusToErrorCode } from '../types/error-codes.js';
import { SDK_USER_AGENT } from '../index.js';

/** @internal */
export interface FetcherOptions {
  baseUrl: string;
  bearerToken: string | (() => Promise<string>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  onUnauthorized?: () => void;
}

/** @internal */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Override the default fetch timeout for this request. */
  timeoutMs?: number;
  /**
   * If true, treat 404 as a soft miss and resolve with `undefined` instead of
   * throwing. Used by find-or-create flows.
   */
  resolveOn404?: boolean;
  /**
   * Override the default JSON content-type for the body. Used by multipart
   * uploads. When set, `body` is sent as-is without JSON.stringify().
   */
  bodyType?: 'json' | 'raw';
  /** Extra headers; layered on top of SDK defaults. */
  headers?: Record<string, string>;
}

/** @internal */
export class Fetcher {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: FetcherOptions) {
    this.fetchImpl =
      options.fetch ?? (globalThis.fetch as typeof globalThis.fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new ConductorAppError({
        code: 'invalid_input',
        message:
          'No fetch implementation found. Provide options.fetch (Node ≥18 has globalThis.fetch built in).',
      });
    }
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T = unknown>(req: RequestOptions): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': SDK_USER_AGENT,
      ...(req.headers ?? {}),
    };

    const bodyType = req.bodyType ?? 'json';
    let body: BodyInit | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (bodyType === 'json') {
        headers['Content-Type'] ??= 'application/json';
        body = JSON.stringify(req.body);
      } else {
        body = req.body as BodyInit;
      }
    }

    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const composedSignal = composeAbortSignals(req.signal, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers,
        body,
        signal: composedSignal.signal,
      });
    } catch (cause) {
      composedSignal.dispose();
      // AbortError (timeout or caller-canceled) reaches here.
      if (isAbortError(cause)) {
        throw new ConductorAppError({
          code: composedSignal.timedOut ? 'timeout' : 'stream_aborted',
          message: composedSignal.timedOut
            ? `Request timed out after ${timeoutMs}ms: ${req.method ?? 'GET'} ${req.path}`
            : `Request aborted: ${req.method ?? 'GET'} ${req.path}`,
          cause,
        });
      }
      throw new ConductorAppError({
        code: 'network_error',
        message: `Network error on ${req.method ?? 'GET'} ${req.path}: ${
          (cause as Error)?.message ?? String(cause)
        }`,
        cause,
      });
    }
    composedSignal.dispose();

    if (response.status === 401) {
      try {
        this.options.onUnauthorized?.();
      } catch {
        // never let a user callback escape into request flow
      }
    }

    if (response.status === 404 && req.resolveOn404) {
      return undefined as unknown as T;
    }

    if (!response.ok) {
      const { details, message } = await readErrorBody(response);
      const code = mapHttpStatusToErrorCode(response.status, details, message);
      throw new ConductorAppError({
        code,
        status: response.status,
        message:
          message ||
          `Conductor returned ${response.status} on ${req.method ?? 'GET'} ${req.path}`,
        details,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }

    // Successful responses: parse JSON, tolerate empty bodies.
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    const text = await response.text();
    if (!text) {
      return undefined as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ConductorAppError({
        code: 'server_error',
        message: `Conductor returned non-JSON body on ${req.method ?? 'GET'} ${req.path}`,
        details: { rawBody: text.slice(0, 1024) },
        cause,
      });
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${base}${cleanPath}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const queryString = params.toString();
    return queryString ? `${url}?${queryString}` : url;
  }

  private async resolveToken(): Promise<string> {
    const { bearerToken } = this.options;
    if (typeof bearerToken === 'string') return bearerToken;
    const resolved = await bearerToken();
    if (!resolved) {
      throw new ConductorAppError({
        code: 'unauthorized',
        message: 'bearerToken provider returned empty string',
      });
    }
    return resolved;
  }
}

function composeAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: boolean } {
  const controller = new AbortController();
  let timedOut = false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort);
    }
  }

  const dispose = () => {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  };

  return {
    signal: controller.signal,
    dispose,
    get timedOut() {
      return timedOut;
    },
  };
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError';
}

async function readErrorBody(
  response: Response,
): Promise<{ details: unknown; message: string | null }> {
  const text = await response.text().catch(() => '');
  if (!text) return { details: null, message: null };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.message === 'string'
          ? parsed.message
          : null;
    return { details: parsed, message };
  } catch {
    return { details: { rawBody: text.slice(0, 1024) }, message: null };
  }
}

// Status-to-error-code mapping lives in `src/types/error-codes.ts` so both
// `/server` (fetcher.ts) and `/react` (rest-adapter.ts) share one source of
// truth. See that file for the precedence rules at 404 / 409.
