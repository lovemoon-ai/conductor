const PLAN_LIMIT_MESSAGES: Record<string, string> = {
  manual_fire_active_task: 'Free plan limit reached: only 1 active fire task is allowed.',
  app_active_task: 'Free plan limit reached: only 1 active app task is allowed.',
  daemon_active_connection: 'Free plan limit reached: only 1 active daemon connection is allowed.',
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text ? text : null;
}

function getMessageByLimitType(limitType: string): string | null {
  const normalized = limitType.trim().toLowerCase();
  if (normalized in PLAN_LIMIT_MESSAGES) {
    return PLAN_LIMIT_MESSAGES[normalized];
  }
  if (normalized === 'free_daemon_connection' || normalized === 'free-daemon-limit') {
    return PLAN_LIMIT_MESSAGES.daemon_active_connection;
  }
  return null;
}

function inferFromText(raw: unknown): string | null {
  const text = normalizeText(raw);
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (lower.includes('one active manual fire task')) {
    return PLAN_LIMIT_MESSAGES.manual_fire_active_task;
  }
  if (lower.includes('one active app task')) {
    return PLAN_LIMIT_MESSAGES.app_active_task;
  }
  if (lower.includes('one active daemon connection')) {
    return PLAN_LIMIT_MESSAGES.daemon_active_connection;
  }
  if (lower.includes('free plan task limit reached')) {
    return 'Free plan task limit reached: only 1 active fire task and 1 active app task are allowed.';
  }
  return null;
}

export function getPlanLimitMessageFromDetails(details: unknown): string | null {
  if (!details) {
    return null;
  }
  if (typeof details === 'string') {
    return inferFromText(details);
  }
  if (typeof details !== 'object') {
    return null;
  }

  const payload = details as Record<string, unknown>;
  const byType = normalizeText(payload.limit_type);
  if (byType) {
    const mapped = getMessageByLimitType(byType);
    if (mapped) {
      return mapped;
    }
  }

  return inferFromText(payload.message) ?? inferFromText(payload.error);
}

export function getPlanLimitMessageFromError(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const payload = error as Record<string, unknown>;
  return (
    getPlanLimitMessageFromDetails(payload.details) ??
    inferFromText(payload.message)
  );
}

export function getPlanLimitMessageFromRealtimeEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const payload = event as Record<string, unknown>;
  if (typeof payload.type === 'string' && payload.type !== 'error') {
    return null;
  }
  return getPlanLimitMessageFromDetails(payload.payload);
}
