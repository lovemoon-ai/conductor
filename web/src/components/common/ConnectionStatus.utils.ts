export function normalizeTaskId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

export function formatPercent(value?: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const rounded = Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  return `${rounded}%`;
}

/**
 * Extract goal-mode info from a task's persisted metadata + launchConfig.
 *
 * Backend contract (see `web/src/lib/tasks/create-ai-task.ts`):
 *   - `metadata.aiMode === "goal"` is the persisted "this task was created
 *     in /goal mode" flag — used as a fallback when the live runtime has not
 *     yet reported `aiMode` (e.g. before the first turn dispatch). The live
 *     runtime field is the source of truth for the CURRENT turn's mode.
 *   - `metadata.goal = { source, issueId?, status? }` carries provenance.
 *   - `launchConfig.goal.objective` carries the bare objective text for UI
 *     display, with `metadata.initialContent` as a secondary fallback. Note
 *     these may differ from the actual prefill delivered to fire — which
 *     now includes a `/goal\n` prefix so fire's per-message detector picks
 *     it up.
 */
export function extractGoalInfo(
  metadata?: Record<string, unknown> | null,
  launchConfig?: Record<string, unknown> | null,
): {
  active: boolean;
  source?: string;
  status?: string;
  objective?: string;
  issueId?: string;
} {
  if (!metadata || typeof metadata !== 'object') {
    return { active: false };
  }
  const aiMode = typeof metadata.aiMode === 'string' ? metadata.aiMode : '';
  const goalBlock =
    metadata.goal && typeof metadata.goal === 'object' && !Array.isArray(metadata.goal)
      ? (metadata.goal as Record<string, unknown>)
      : null;
  const objectiveFromLaunch =
    launchConfig &&
    typeof launchConfig === 'object' &&
    launchConfig.goal &&
    typeof launchConfig.goal === 'object' &&
    !Array.isArray(launchConfig.goal)
      ? ((launchConfig.goal as Record<string, unknown>).objective as string | undefined)
      : undefined;
  const objectiveFromMetadata =
    typeof metadata.initialContent === 'string' ? (metadata.initialContent as string) : undefined;

  // We treat the task as goal-mode if EITHER aiMode says so OR the goal block
  // carries an objective (defensive — matches `isGoalModeLaunchConfig` on the
  // daemon side which accepts either signal).
  const inferred =
    aiMode === 'goal' ||
    (goalBlock && typeof goalBlock.objective === 'string' && (goalBlock.objective as string).trim().length > 0);

  if (!inferred) {
    return { active: false };
  }

  return {
    active: true,
    source: typeof goalBlock?.source === 'string' ? (goalBlock?.source as string) : undefined,
    status: typeof goalBlock?.status === 'string' ? (goalBlock?.status as string) : undefined,
    issueId: typeof goalBlock?.issueId === 'string' ? (goalBlock?.issueId as string) : undefined,
    objective: (objectiveFromLaunch || objectiveFromMetadata || '').trim() || undefined,
  };
}

/**
 * Decide which `aiMode` to render in the Runtime Details panel.
 *
 * Precedence (highest first):
 *   1. The live runtime field reported by fire on each dispatch
 *      (`runtimeAiMode`). The user can flip modes mid-chat by typing
 *      `/goal ...` at any time, so this is the only source that reflects the
 *      CURRENT turn's mode.
 *   2. The task's persisted `metadata.aiMode` (surfaced via `goalInfo.active`).
 *      Used as a fallback for the brief window before the first turn has
 *      dispatched, or for tasks where the runtime hasn't reported yet (e.g.
 *      the page just loaded and we have not received any runtime event).
 *
 * Returns the internal mode name ("goal" or "turn"); the UI layer is
 * responsible for translating that to the user-facing label ("goal" /
 * "normal").
 */
export function resolveEffectiveAiMode(
  runtimeAiMode: 'goal' | 'turn' | undefined,
  metadataGoalActive: boolean,
): 'goal' | 'turn' {
  if (runtimeAiMode === 'goal' || runtimeAiMode === 'turn') {
    return runtimeAiMode;
  }
  return metadataGoalActive ? 'goal' : 'turn';
}
