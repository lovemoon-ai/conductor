/**
 * ConductorAppError: every error thrown out of the SDK is one of these.
 * Callers can `if (err instanceof ConductorAppError) switch (err.code)`.
 *
 * `code` is open-vocabulary for forward compat; the SDK promises to never
 * remove existing codes, only add new ones, and to bump the minor version
 * when a new code is introduced.
 */
export class ConductorAppError extends Error {
  override readonly name = 'ConductorAppError';
  readonly code: ConductorErrorCode | string;
  readonly status?: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(args: {
    code: ConductorErrorCode | string;
    message: string;
    status?: number;
    details?: unknown;
    requestId?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.code = args.code;
    this.status = args.status;
    this.details = args.details;
    this.requestId = args.requestId;
  }
}

export type ConductorErrorCode =
  // Auth / scope
  | 'unauthorized'
  | 'forbidden'
  | 'token_revoked'

  // Validation / inputs
  | 'invalid_input'
  | 'project_not_found'
  | 'task_not_found'
  | 'message_not_found'

  // Project binding flow
  | 'daemon_offline'
  | 'workspace_path_conflict'
  | 'binding_validation_failed'

  // Task lifecycle
  | 'task_not_running'
  | 'task_type_not_messageable'
  | 'task_type_not_interruptible'
  | 'task_fire_owner_offline'

  // Transport
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'

  // Subscribe / stream
  | 'subscribe_failed'
  | 'stream_aborted';

/** Helper: type-guard for callers that don't want `instanceof`. */
export function isConductorAppError(error: unknown): error is ConductorAppError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ConductorAppError'
  );
}
