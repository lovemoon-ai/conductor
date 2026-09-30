/**
 * RFC 0039 persistent tasks: one Task, many rounds, each round a fresh AI
 * session. The whole state lives under `task.metadata.persistent`; round
 * boundaries are marked by messages (see the `*_KIND` constants).
 */

export const PERSISTENT_METADATA_KEY = 'persistent';
/** `sdk` divider message written when a new round starts. */
export const PERSISTENT_ROUND_START_KIND = 'persistent_round_start';
/** `user` message asking the AI for the rolling summary when a round ends. */
export const PERSISTENT_ROUND_END_KIND = 'persistent_round_end';

export interface PersistentTaskState {
  enabled: boolean;
  instructions: string;
  summary: string;
  /** End the round automatically after an hour without a user reply. Default on. */
  autoEndRound: boolean;
  round: number;
  roundEndedAt: string | null;
  roundEndMessageId: string | null;
  /** Set while a request is starting the next round, so concurrent starts back off. */
  /** A round start in flight; `clientMessageId` identifies its sender for retries. */
  roundStarting: { id: string; at: string; clientMessageId: string | null } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Returns null when the task has never been persistent. */
export const readPersistentTaskState = (metadata: unknown): PersistentTaskState | null => {
  if (!isRecord(metadata)) return null;
  const raw = metadata[PERSISTENT_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const round = typeof raw.round === 'number' && Number.isInteger(raw.round) && raw.round > 0
    ? raw.round
    : 1;
  return {
    enabled: raw.enabled === true,
    instructions: readString(raw.instructions),
    summary: readString(raw.summary),
    autoEndRound: raw.autoEndRound !== false,
    round,
    roundEndedAt: readOptionalString(raw.roundEndedAt),
    roundEndMessageId: readOptionalString(raw.roundEndMessageId),
    roundStarting:
      isRecord(raw.roundStarting) && readOptionalString(raw.roundStarting.id) && readOptionalString(raw.roundStarting.at)
        ? {
            id: raw.roundStarting.id as string,
            at: raw.roundStarting.at as string,
            clientMessageId: readOptionalString(raw.roundStarting.clientMessageId),
          }
        : null,
  };
};

export const isPersistentTask = (task: { metadata?: unknown } | null | undefined): boolean =>
  readPersistentTaskState(task?.metadata)?.enabled === true;

/** Per-project (and, since project rows are per user, per-user) list toggle. Default: show. */
export const SHOW_PERSISTENT_TASKS_METADATA_KEY = 'showPersistentTasks';

export const shouldShowPersistentTasks = (projectMetadata: unknown): boolean =>
  !isRecord(projectMetadata) || projectMetadata[SHOW_PERSISTENT_TASKS_METADATA_KEY] !== false;
