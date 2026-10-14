/**
 * Model quota ("session limit") handling for fire.
 *
 * When a backend turn fails because the subscription quota is used up, fire
 * parks the task until the quota resets instead of failing every following
 * message. The resume itself is a one-off Conductor scheduled message
 * (`source: "quota_resume"`), so it survives fire/daemon restarts and shows up
 * in the task's schedule list where a person can cancel it.
 */

const QUOTA_ERROR_PATTERNS = [
  /hit your (?:[\w-]+ )?limit/i,
  /usage limit (?:reached|exceeded)/i,
  /\b(?:session|5-hour|five-hour|weekly|daily|opus|sonnet) limit\b/i,
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Used when the error names no reset time at all. */
export const QUOTA_FALLBACK_WAIT_MS = HOUR_MS;
/** Resume this long after the reset at the earliest, so the quota has really refilled. */
export const QUOTA_RESUME_MIN_DELAY_MS = MINUTE_MS;
/** Extra random spread on top, so tasks sharing one subscription do not all start at once. */
export const QUOTA_RESUME_JITTER_MS = 4 * MINUTE_MS;
/** Consecutive quota hits on resume before fire stops scheduling more. */
export const QUOTA_RESUME_MAX_ATTEMPTS = 3;

export const QUOTA_RESUME_PROMPT =
  "[额度已恢复，自动继续] 模型额度用完时中断了你的工作。请继续中断前未完成的工作。";

export function isQuotaLimitError(message) {
  const text = String(message || "");
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Recognises a quota error and works out when the quota resets.
 * Returns null for any other error; `resetAt` is null when the text names no time.
 */
export function parseQuotaLimitError(message, { now = new Date(), defaultTimeZone } = {}) {
  const text = String(message || "");
  if (!isQuotaLimitError(text)) {
    return null;
  }
  return { resetAt: parseQuotaResetAt(text, { now, defaultTimeZone }) };
}

export function parseQuotaResetAt(text, { now = new Date(), defaultTimeZone } = {}) {
  const nowMs = now.getTime();

  // Older Claude Code: "Claude AI usage limit reached|1759561200"
  const epoch = /limit reached\|(\d{10,13})/i.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    return new Date(epoch[1].length === 10 ? value * 1000 : value);
  }

  // "try again in 2 hours 13 minutes"
  const relative = /try again in\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    return new Date(nowMs + Number(relative[1] || 0) * HOUR_MS + Number(relative[2] || 0) * MINUTE_MS);
  }

  // "resets 1:20am (Asia/Shanghai)", "resets Oct 7, 2am (Asia/Shanghai)", "try again at 3:05 PM"
  const clock =
    /(?:resets?|try again at)\s+(?:at\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!clock) {
    return null;
  }
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = clock;
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (meridiem) {
    const pm = meridiem.toLowerCase().startsWith("p");
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  const timeZone = resolveTimeZone(zoneText) || resolveTimeZone(defaultTimeZone) || undefined;
  const today = zonedParts(nowMs, timeZone);

  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const day = Number(dayText);
    let resetMs = zonedWallTimeToUtc({ year: today.year, month: month + 1, day, hour, minute }, timeZone);
    if (resetMs < nowMs - DAY_MS) {
      resetMs = zonedWallTimeToUtc({ year: today.year + 1, month: month + 1, day, hour, minute }, timeZone);
    }
    return new Date(resetMs);
  }

  let resetMs = zonedWallTimeToUtc({ ...today, hour, minute }, timeZone);
  if (resetMs <= nowMs - 10 * MINUTE_MS) {
    // A time-only reset already behind us means tomorrow.
    resetMs = zonedWallTimeToUtc({ ...today, day: today.day + 1, hour, minute }, timeZone);
  } else if (resetMs < nowMs) {
    resetMs = nowMs;
  }
  return new Date(resetMs);
}

/** When to send the resume message: after the reset, plus jitter. */
export function computeQuotaResumeAt(resetAt, { now = new Date(), random = Math.random } = {}) {
  const nowMs = now.getTime();
  const base = resetAt instanceof Date && Number.isFinite(resetAt.getTime())
    ? resetAt.getTime()
    : nowMs + QUOTA_FALLBACK_WAIT_MS;
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * QUOTA_RESUME_JITTER_MS);
  return new Date(Math.max(base, nowMs) + QUOTA_RESUME_MIN_DELAY_MS + jitter);
}

/**
 * The prompt for the resume turn: the resume note plus every message that has
 * not been handled yet (the one whose turn hit the quota, then those that
 * arrived while waiting).
 */
export function buildQuotaResumePrompt(queued = []) {
  const parts = [QUOTA_RESUME_PROMPT];
  const pending = queued.filter((item) => item && String(item.content || "").trim());
  if (pending.length) {
    parts.push(`以下 ${pending.length} 条消息还没有处理（按时间顺序）：`);
    pending.forEach((item, index) => {
      parts.push(`--- 消息 ${index + 1} ---\n${String(item.content).trim()}`);
    });
  }
  return parts.join("\n\n");
}

export function isQuotaResumePrompt(content) {
  return String(content || "").trim().startsWith(QUOTA_RESUME_PROMPT);
}

const RESUME_ITEM_SEPARATOR = /\n\n--- 消息 \d+ ---\n/;

/**
 * The pending messages a resume prompt lists (the inverse of
 * buildQuotaResumePrompt), so a fire that restarted mid-wait can carry them on.
 */
export function parseQuotaResumePrompt(content) {
  const text = String(content || "").trim();
  if (!isQuotaResumePrompt(text)) {
    return [];
  }
  return text
    .split(RESUME_ITEM_SEPARATOR)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ messageId: null, content: part }));
}

/** Concatenates pending-message lists, dropping repeats of the same text. */
export function mergeQueuedMessages(...lists) {
  const seen = new Set();
  const merged = [];
  for (const item of lists.flat()) {
    const key = String(item?.content || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function formatResumeTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: resolveTimeZone(timeZone) || undefined,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Creates and cancels the resume schedule through the Conductor HTTP API.
 * Returns null when fire has no backend URL/token (e.g. a guest daemon).
 */
export function createQuotaResumeScheduler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const backendUrl = typeof env.CONDUCTOR_BACKEND_URL === "string" ? env.CONDUCTOR_BACKEND_URL.trim() : "";
  const token = typeof env.CONDUCTOR_AGENT_TOKEN === "string" ? env.CONDUCTOR_AGENT_TOKEN.trim() : "";
  if (!backendUrl || !token || typeof fetchImpl !== "function") {
    return null;
  }
  const base = backendUrl.replace(/\/+$/, "");
  // No X-Conductor-Actor header: this is fire itself, not the agent, so the
  // task's agent schedule-access setting must not block it.
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const schedulesUrl = (taskId) => `${base}/api/tasks/${encodeURIComponent(taskId)}/scheduled-messages`;

  return {
    async schedule({ taskId, sendAt, content }) {
      const response = await fetchImpl(schedulesUrl(taskId), {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          source: "quota_resume",
          schedule: { mode: "at", sendAt: sendAt.toISOString() },
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`schedule quota resume failed: HTTP ${response.status} ${detail}`.trim());
      }
      const body = await response.json().catch(() => ({}));
      return { id: typeof body?.id === "string" ? body.id : null };
    },
    /** Active quota_resume schedules of the task (left behind by an earlier fire). */
    async listActive({ taskId }) {
      const response = await fetchImpl(`${schedulesUrl(taskId)}?status=active`, { method: "GET", headers });
      if (!response.ok) {
        throw new Error(`list quota resumes failed: HTTP ${response.status}`);
      }
      const body = await response.json().catch(() => ({}));
      const schedules = Array.isArray(body?.schedules) ? body.schedules : [];
      // Servers before `source` existed: recognise the resume by its text.
      return schedules.filter((row) =>
        row?.source ? row.source === "quota_resume" : isQuotaResumePrompt(row?.content),
      );
    },
    async update({ taskId, scheduleId, content }) {
      const response = await fetchImpl(`${schedulesUrl(taskId)}/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error(`update quota resume failed: HTTP ${response.status}`);
      }
    },
    async cancel({ taskId, scheduleId }) {
      // cancel_only: never delete a row the dispatcher already sent (that
      // would erase its history); a server without the flag still cancels
      // active rows, and fire only cancels before the send time.
      const response = await fetchImpl(
        `${schedulesUrl(taskId)}/${encodeURIComponent(scheduleId)}?cancel_only=1`,
        { method: "DELETE", headers },
      );
      if (!response.ok && response.status !== 404 && response.status !== 409) {
        throw new Error(`cancel quota resume failed: HTTP ${response.status}`);
      }
    },
  };
}

function resolveTimeZone(value) {
  const zone = typeof value === "string" ? value.trim() : "";
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms (local minus UTC). */
function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `timeZone` (day overflow is normalised). */
function zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}
