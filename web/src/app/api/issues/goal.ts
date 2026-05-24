/**
 * Parser + builders for the `/goal` directive embedded in Issue bodies.
 *
 * When an Issue's description starts with `/goal ...`, the Issue → Doing flow
 * routes the spawned task through fire's native goal mode (`session.runGoal`)
 * instead of the normal single-turn flow.
 *
 * Per-message detection design: the daemon delivers `initial_content` to fire
 * verbatim, and fire inspects EACH user message for a leading `/goal` line
 * (see `parseGoalDirectiveFromMessage` in `cli/bin/conductor-fire.js`). The
 * web layer's job is to:
 *   1. Stamp `metadata.aiMode = "goal"` on the task for UI surfaces (this is
 *      informational only — fire does not read it back).
 *   2. Deliver an initial content string that STARTS WITH `/goal\n` so fire's
 *      first-turn detector picks it up.
 *
 * There is no longer a `--goal` spawn flag; the daemon no longer reads
 * `launchConfig.aiMode` to make spawn decisions. Goal mode is a per-message
 * runtime concept now, not a launch-time flag.
 */

/**
 * Hard cap on objective length so we never blow past fire's prompt budget.
 * The `/goal\n` prefix (7 chars) added by `buildIssueGoalInitialContent` is
 * accounted for separately at build time so the parsed objective itself
 * remains bounded by this number.
 */
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

/**
 * Prefix that tells fire's per-message detector "treat the rest of this
 * message as a goal objective." Must match the directive grammar accepted by
 * `parseGoalDirective` and by the CLI's `parseGoalDirectiveFromMessage`.
 */
const GOAL_DIRECTIVE_PREFIX = '/goal\n';

/**
 * Backends that currently understand goal mode.
 *
 * N7 / goal-mode contract drift (Option A: documented mirroring): this Set
 * MUST mirror the `static capabilities = { goal: true }` declarations on the
 * ai-sdk session providers. Web doesn't have a runtime view of ai-sdk's
 * capability snapshot at issue-creation time, so we maintain a coarse local
 * copy as a pre-check; the CLI fire process also maintains its own copy
 * (`GOAL_CAPABLE_BACKENDS` in `cli/bin/conductor-fire.js`) for the same
 * reason. The authoritative source of truth is the post-spawn capability
 * check inside the ai-sdk session itself.
 *
 * Sibling lists that must be kept in sync:
 *   - `cli/bin/conductor-fire.js` → `GOAL_CAPABLE_BACKENDS`
 *   - `modules/ai-sdk/src/providers/*.js` → `static capabilities.goal`
 *
 * If you add a new goal-capable backend, update ALL THREE locations and run
 * `cd web && pnpm test` + `cd cli && pnpm test`.
 */
const GOAL_CAPABLE_BACKENDS = new Set(['claude', 'codex']);

export type GoalDirectiveResult =
  | { mode: 'turn' }
  | { mode: 'goal'; objective: string };

/** Marker appended to truncated objectives so callers can see something was dropped. */
const TRUNCATION_MARKER = '\n\n...[truncated]';

/**
 * Truncate from the END (not the start) — the opening sentence of an
 * objective is usually the load-bearing part. We append a marker so callers
 * (and users staring at logs) can see something was dropped. The result is
 * guaranteed to be no longer than `limit`.
 */
const truncateToLimit = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  // Not enough room for the marker — just hard-truncate.
  if (limit <= TRUNCATION_MARKER.length) {
    return text.slice(0, Math.max(0, limit));
  }
  const slice = text.slice(0, limit - TRUNCATION_MARKER.length).replace(/\s+$/, '');
  return `${slice}${TRUNCATION_MARKER}`;
};

const truncateObjective = (objective: string): string =>
  truncateToLimit(objective, MAX_GOAL_OBJECTIVE_LENGTH);

/**
 * Inspect an Issue body and decide whether to dispatch as a goal-mode run.
 *
 * Rules:
 *   - The directive must appear on the FIRST non-empty line. `/goal` anywhere
 *     else in the body is treated as plain prose (no surprise mode switches
 *     when users mention `/goal` later in the description).
 *   - `/goal <inline>` → objective = inline text + rest of body.
 *   - `/goal` alone on its line → objective = rest of body.
 *   - Empty objective after trimming → fall back to turn mode rather than
 *     dispatching a no-op goal.
 *   - Objective is capped at MAX_GOAL_OBJECTIVE_LENGTH; longer text is
 *     truncated from the end with a marker.
 */
export const parseGoalDirective = (
  issueBody: string | null | undefined,
): GoalDirectiveResult => {
  if (typeof issueBody !== 'string') {
    return { mode: 'turn' };
  }
  const body = issueBody.replace(/\r\n/g, '\n');
  if (!body.trim()) {
    return { mode: 'turn' };
  }

  const lines = body.split('\n');
  let firstNonEmptyIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length > 0) {
      firstNonEmptyIndex = i;
      break;
    }
  }
  if (firstNonEmptyIndex < 0) {
    return { mode: 'turn' };
  }

  const firstLine = lines[firstNonEmptyIndex];
  // Case-insensitive: accept `/Goal`, `/GOAL`, etc. Requires whitespace (or EOL)
  // after `/goal` so `/goalsomething` is treated as ordinary prose.
  const match = /^\s*\/goal(?:\s+(.*))?\s*$/i.exec(firstLine);
  if (!match) {
    return { mode: 'turn' };
  }

  const inlineTail = (match[1] ?? '').trim();
  const remainingLines = lines.slice(firstNonEmptyIndex + 1).join('\n').trim();

  let objective: string;
  if (inlineTail && remainingLines) {
    objective = `${inlineTail}\n\n${remainingLines}`;
  } else if (inlineTail) {
    objective = inlineTail;
  } else if (remainingLines) {
    objective = remainingLines;
  } else {
    return { mode: 'turn' };
  }

  objective = objective.trim();
  if (!objective) {
    return { mode: 'turn' };
  }

  return { mode: 'goal', objective: truncateObjective(objective) };
};

/**
 * Build the initial content delivered to fire when the issue spawns in goal
 * mode.
 *
 * Per the per-message detection design, the returned string is
 * `"/goal\n<objective>"` so fire's `parseGoalDirectiveFromMessage` (see
 * `cli/bin/conductor-fire.js`) sees the directive on the first turn and
 * dispatches `session.runGoal`. The daemon does NOT special-case this string
 * — it ships the content to fire verbatim.
 *
 * The objective body is still bounded by `MAX_GOAL_OBJECTIVE_LENGTH` (the
 * prefix is reserved separately), so callers who persist the trimmed
 * objective elsewhere (e.g. `launch_config.goal.objective`) can rely on that
 * bound. The full returned string is `prefix.length + objective.length`.
 *
 * We intentionally do NOT prepend an `Issue: <title>` framing line — the task
 * already carries the title in its own column, and any framing would
 * recreate the three-way divergence the code reviewer flagged. The `title`
 * arg is kept for call-site symmetry with `buildIssueInitialContent` and is
 * deliberately unused.
 */
export const buildIssueGoalInitialContent = (args: {
  title: string;
  objective: string;
}): string => {
  void args.title;
  const trimmed = truncateObjective(args.objective.trim());
  return `${GOAL_DIRECTIVE_PREFIX}${trimmed}`;
};

/** True when the backend supports goal-mode dispatch today. */
export const isGoalCapableBackend = (backendType: string | null | undefined): boolean =>
  typeof backendType === 'string' && GOAL_CAPABLE_BACKENDS.has(backendType);
