'use client';

import { create } from 'zustand';

export type TerminalConnectionState = 'idle' | 'connecting' | 'open' | 'exited' | 'error';
export type TerminalPreferredMode = 'write' | 'view';
export type TerminalBannerTone = 'info' | 'warning' | 'error' | 'success';
export type TerminalTransportState = 'relay' | 'negotiating' | 'direct' | 'fallback_relay';
export type TerminalTransportPolicy = 'relay_only' | 'direct_preferred';

export interface TerminalBanner {
  tone: TerminalBannerTone;
  message: string;
}

export interface TerminalLatencySample {
  clientInputSeq: number | null;
  clientSentAt: string | null;
  serverReceivedAt: string | null;
  daemonReceivedAt: string | null;
  firstOutputAt: string | null;
  daemonInputToFirstOutputMs: number | null;
  clientInputToRenderMs: number | null;
  renderedAt: string;
}

export interface TerminalTransportSession {
  sessionId: string;
  transportState: TerminalTransportState;
  transportPolicy: TerminalTransportPolicy;
  issuedAt: string | null;
  expiresAt: string | null;
  writerConnectionId: string | null;
  ticket: string | null;
  directCandidate: boolean;
}

export interface TerminalOutputSnapshot {
  taskId: string;
  lastSeq: number;
  chunks: string[];
  bufferedByteCount: number;
  appendCount: number;
}

export interface TerminalOutputEvent {
  taskId: string;
  seq: number;
  data: string;
  snapshot: TerminalOutputSnapshot;
  replace?: boolean;
}

export interface TerminalResumeSnapshot {
  taskId: string;
  lastSeq: number;
  data: string;
  bufferedByteCount: number;
  truncated: boolean;
  updatedAt: string | null;
}

export interface TerminalTransportSignal {
  taskId: string;
  sessionId: string;
  signalType: string;
  description?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface TerminalSessionState {
  taskId: string;
  ptySessionId?: string | null;
  connectionState: TerminalConnectionState;
  isAttached: boolean;
  hasWriteAccess: boolean;
  viewerCount: number;
  preferredMode: TerminalPreferredMode;
  transportState: TerminalTransportState;
  transportSession?: TerminalTransportSession | null;
  pid?: number | null;
  cwd?: string | null;
  shell?: string | null;
  cols?: number | null;
  rows?: number | null;
  startedAt?: string | null;
  closedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  lastLatencySample?: TerminalLatencySample | null;
  banner?: TerminalBanner | null;
}

interface TerminalStoreState {
  byTask: Record<string, TerminalSessionState>;
  markAttaching: (
    taskId: string,
    options?: { preferredMode?: TerminalPreferredMode; reason?: 'initial' | 'reconnect' | 'manual' | 'takeover' },
  ) => void;
  markDetached: (taskId: string) => void;
  setPreferredMode: (taskId: string, mode: TerminalPreferredMode) => void;
  markSocketDisconnected: () => void;
  beginFreshResumeAttach: (taskId: string) => void;
  markOpened: (payload: Record<string, unknown>) => void;
  appendOutput: (payload: Record<string, unknown>) => void;
  applySnapshot: (payload: Record<string, unknown>) => void;
  markExit: (payload: Record<string, unknown>) => void;
  markError: (payload: Record<string, unknown>) => void;
  markTaskStatus: (taskId: string, status: string) => void;
  updateAccess: (payload: Record<string, unknown>) => void;
  updateTransportSession: (payload: Record<string, unknown>) => void;
  handleTransportSignal: (payload: Record<string, unknown>) => void;
  clearBanner: (taskId: string) => void;
  clearTask: (taskId: string) => void;
}

export const MAX_OUTPUT_BUFFER_BYTES = 2 * 1024 * 1024;
export const TERMINAL_RESUME_SNAPSHOT_MAX_BYTES = 128 * 1024;
export const TERMINAL_RESUME_SNAPSHOT_PERSIST_DELAY_MS = 200;
export const TERMINAL_FRESH_RESUME_FALLBACK_MS = 500;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const terminalOutputSnapshots = new Map<string, TerminalOutputSnapshot>();
const terminalResumeSnapshots = new Map<string, TerminalResumeSnapshot>();
const terminalOutputListeners = new Map<string, Set<(event: TerminalOutputEvent) => void>>();
const terminalTransportSignalListeners = new Map<string, Set<(signal: TerminalTransportSignal) => void>>();
const pendingResumeHydrationTaskIds = new Set<string>();
const pendingResumeOutputPayloads = new Map<string, Record<string, unknown>[]>();
const pendingResumePersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingResumeFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TERMINAL_RESUME_SNAPSHOT_STORAGE_PREFIX = 'conductor-terminal-resume:';

const normalizeTaskId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
};

const normalizeInteger = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return null;
};

const normalizeNonNegativeInteger = (value: unknown): number | null => {
  const parsed = normalizeInteger(value);
  if (parsed === null || parsed < 0) {
    return null;
  }
  return parsed;
};

const normalizeIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
};

const normalizeTransportState = (value: unknown): TerminalTransportState => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'direct') return 'direct';
  if (normalized === 'negotiating') return 'negotiating';
  if (normalized === 'fallback_relay' || normalized === 'fallback-relay') return 'fallback_relay';
  return 'relay';
};

const normalizeTransportPolicy = (value: unknown): TerminalTransportPolicy => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'direct_preferred' || normalized === 'direct-preferred' ? 'direct_preferred' : 'relay_only';
};

const buildLatencySample = (payload: Record<string, unknown>): TerminalLatencySample | null => {
  const latencySample =
    payload.latency_sample && typeof payload.latency_sample === 'object' && !Array.isArray(payload.latency_sample)
      ? (payload.latency_sample as Record<string, unknown>)
      : null;
  if (!latencySample) {
    return null;
  }

  const renderedAt = new Date().toISOString();
  const clientSentAt = normalizeIsoTimestamp(latencySample.client_sent_at ?? latencySample.clientSentAt);
  const renderedAtMs = Date.parse(renderedAt);
  const clientSentAtMs = clientSentAt ? Date.parse(clientSentAt) : Number.NaN;

  return {
    clientInputSeq: normalizeNonNegativeInteger(latencySample.client_input_seq ?? latencySample.clientInputSeq),
    clientSentAt,
    serverReceivedAt: normalizeIsoTimestamp(latencySample.server_received_at ?? latencySample.serverReceivedAt),
    daemonReceivedAt: normalizeIsoTimestamp(latencySample.daemon_received_at ?? latencySample.daemonReceivedAt),
    firstOutputAt: normalizeIsoTimestamp(latencySample.first_output_at ?? latencySample.firstOutputAt),
    daemonInputToFirstOutputMs: normalizeNonNegativeInteger(
      latencySample.daemon_input_to_first_output_ms ?? latencySample.daemonInputToFirstOutputMs,
    ),
    clientInputToRenderMs:
      Number.isFinite(renderedAtMs) && Number.isFinite(clientSentAtMs)
        ? Math.max(0, renderedAtMs - clientSentAtMs)
        : null,
    renderedAt,
  };
};

const getChunkByteLength = (value: string): number => textEncoder.encode(value).length;

const trimChunkToTailBytes = (value: string, maxBytes: number): string => {
  const encoded = textEncoder.encode(value);
  if (encoded.length <= maxBytes) {
    return value;
  }
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return textDecoder.decode(encoded.subarray(start));
};

const createSession = (taskId: string): TerminalSessionState => ({
  taskId,
  connectionState: 'idle',
  isAttached: false,
  hasWriteAccess: false,
  viewerCount: 0,
  preferredMode: 'write',
  transportState: 'relay',
  transportSession: null,
  lastLatencySample: null,
  banner: null,
});

const createOutputSnapshot = (taskId: string): TerminalOutputSnapshot => ({
  taskId,
  lastSeq: 0,
  chunks: [],
  bufferedByteCount: 0,
  appendCount: 0,
});

const createResumeSnapshot = (taskId: string): TerminalResumeSnapshot => ({
  taskId,
  lastSeq: 0,
  data: '',
  bufferedByteCount: 0,
  truncated: false,
  updatedAt: null,
});

const cloneOutputSnapshot = (snapshot: TerminalOutputSnapshot): TerminalOutputSnapshot => ({
  ...snapshot,
  chunks: [...snapshot.chunks],
});

const cloneResumeSnapshot = (snapshot: TerminalResumeSnapshot): TerminalResumeSnapshot => ({ ...snapshot });

const getSessionStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const getResumeSnapshotStorageKey = (taskId: string): string => `${TERMINAL_RESUME_SNAPSHOT_STORAGE_PREFIX}${taskId}`;

const clearPendingResumePersistTimer = (taskId: string): void => {
  const timer = pendingResumePersistTimers.get(taskId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  pendingResumePersistTimers.delete(taskId);
};

const clearPendingResumeFallbackTimer = (taskId: string): void => {
  const timer = pendingResumeFallbackTimers.get(taskId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  pendingResumeFallbackTimers.delete(taskId);
};

const safeStorageRemoveItem = (storage: Storage, key: string): void => {
  try {
    storage.removeItem(key);
  } catch {}
};

const listPersistedResumeSnapshotKeys = (storage: Storage): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(TERMINAL_RESUME_SNAPSHOT_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
};

const evictPersistedResumeSnapshots = (storage: Storage, preserveKey: string): void => {
  const candidates = listPersistedResumeSnapshotKeys(storage)
    .filter((key) => key !== preserveKey)
    .map((key) => {
      let updatedAt = 0;
      try {
        const raw = storage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const normalizedUpdatedAt = normalizeIsoTimestamp(parsed.updatedAt);
          updatedAt = normalizedUpdatedAt ? Date.parse(normalizedUpdatedAt) : 0;
        }
      } catch {}
      return { key, updatedAt };
    })
    .sort((left, right) => left.updatedAt - right.updatedAt);

  for (const candidate of candidates) {
    safeStorageRemoveItem(storage, candidate.key);
  }
};

const persistResumeSnapshotNow = (taskId: string): void => {
  clearPendingResumePersistTimer(taskId);
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  const snapshot = terminalResumeSnapshots.get(taskId);
  const key = getResumeSnapshotStorageKey(taskId);
  if (!snapshot || (snapshot.lastSeq === 0 && !snapshot.data)) {
    safeStorageRemoveItem(storage, key);
    return;
  }
  const serialized = JSON.stringify({
    lastSeq: snapshot.lastSeq,
    data: snapshot.data,
    bufferedByteCount: snapshot.bufferedByteCount,
    truncated: snapshot.truncated,
    updatedAt: snapshot.updatedAt,
  });
  try {
    storage.setItem(key, serialized);
  } catch {
    evictPersistedResumeSnapshots(storage, key);
    try {
      storage.setItem(key, serialized);
    } catch {}
  }
};

const scheduleResumeSnapshotPersist = (taskId: string): void => {
  clearPendingResumePersistTimer(taskId);
  pendingResumePersistTimers.set(
    taskId,
    setTimeout(() => {
      persistResumeSnapshotNow(taskId);
    }, TERMINAL_RESUME_SNAPSHOT_PERSIST_DELAY_MS),
  );
};

const clearPersistedResumeSnapshot = (taskId: string): void => {
  clearPendingResumePersistTimer(taskId);
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  safeStorageRemoveItem(storage, getResumeSnapshotStorageKey(taskId));
};

const loadPersistedResumeSnapshot = (taskId: string): TerminalResumeSnapshot | null => {
  const existing = terminalResumeSnapshots.get(taskId);
  if (existing) {
    return existing;
  }
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(getResumeSnapshotStorageKey(taskId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = typeof parsed.data === 'string' ? parsed.data : '';
    const bufferedByteCount = getChunkByteLength(data);
    const snapshot: TerminalResumeSnapshot = {
      taskId,
      lastSeq: normalizeNonNegativeInteger(parsed.lastSeq) ?? 0,
      data,
      bufferedByteCount,
      truncated: parsed.truncated === true,
      updatedAt: normalizeIsoTimestamp(parsed.updatedAt) ?? null,
    };
    terminalResumeSnapshots.set(taskId, snapshot);
    return snapshot;
  } catch {
    safeStorageRemoveItem(storage, getResumeSnapshotStorageKey(taskId));
    return null;
  }
};

const createOutputSnapshotFromResumeSnapshot = (
  taskId: string,
  resumeSnapshot: TerminalResumeSnapshot,
): TerminalOutputSnapshot => ({
  taskId,
  lastSeq: resumeSnapshot.lastSeq,
  chunks: resumeSnapshot.data ? [resumeSnapshot.data] : [],
  bufferedByteCount: resumeSnapshot.bufferedByteCount,
  appendCount: resumeSnapshot.data ? 1 : 0,
});

const updateResumeSnapshot = (taskId: string, lastSeq: number, data: string): TerminalResumeSnapshot => {
  const trimmedData = trimChunkToTailBytes(data, TERMINAL_RESUME_SNAPSHOT_MAX_BYTES);
  const bufferedByteCount = getChunkByteLength(trimmedData);
  const snapshot = terminalResumeSnapshots.get(taskId) ?? createResumeSnapshot(taskId);
  const nextSnapshot: TerminalResumeSnapshot = {
    taskId,
    lastSeq: Math.max(0, lastSeq),
    data: trimmedData,
    bufferedByteCount,
    truncated: bufferedByteCount < getChunkByteLength(data),
    updatedAt: new Date().toISOString(),
  };
  terminalResumeSnapshots.set(taskId, nextSnapshot);
  scheduleResumeSnapshotPersist(taskId);
  return nextSnapshot;
};

const appendToResumeSnapshot = (taskId: string, seq: number, data: string): TerminalResumeSnapshot => {
  const currentSnapshot = terminalResumeSnapshots.get(taskId) ?? loadPersistedResumeSnapshot(taskId) ?? createResumeSnapshot(taskId);
  if (seq <= currentSnapshot.lastSeq) {
    return currentSnapshot;
  }

  const combinedData = `${currentSnapshot.data}${data}`;
  const combinedByteCount = getChunkByteLength(combinedData);
  const trimmedData = trimChunkToTailBytes(combinedData, TERMINAL_RESUME_SNAPSHOT_MAX_BYTES);
  const nextSnapshot: TerminalResumeSnapshot = {
    taskId,
    lastSeq: seq,
    data: trimmedData,
    bufferedByteCount: getChunkByteLength(trimmedData),
    truncated: currentSnapshot.truncated || combinedByteCount > TERMINAL_RESUME_SNAPSHOT_MAX_BYTES,
    updatedAt: new Date().toISOString(),
  };
  terminalResumeSnapshots.set(taskId, nextSnapshot);
  scheduleResumeSnapshotPersist(taskId);
  return nextSnapshot;
};

const getOrCreateOutputSnapshot = (taskId: string): TerminalOutputSnapshot => {
  const existing = terminalOutputSnapshots.get(taskId);
  if (existing) {
    return existing;
  }
  const persistedResumeSnapshot = loadPersistedResumeSnapshot(taskId);
  const created = persistedResumeSnapshot
    ? createOutputSnapshotFromResumeSnapshot(taskId, persistedResumeSnapshot)
    : createOutputSnapshot(taskId);
  terminalOutputSnapshots.set(taskId, created);
  return created;
};

const withTask = (
  byTask: Record<string, TerminalSessionState>,
  taskId: string,
  update: (current: TerminalSessionState) => TerminalSessionState,
): Record<string, TerminalSessionState> => {
  const current = byTask[taskId] ?? createSession(taskId);
  return {
    ...byTask,
    [taskId]: update(current),
  };
};

const buildAttachBanner = (
  reason: 'initial' | 'reconnect' | 'manual' | 'takeover' | undefined,
  preferredMode: TerminalPreferredMode,
): TerminalBanner | null => {
  if (reason === 'reconnect') {
    return { tone: 'warning', message: 'Reconnecting to terminal…' };
  }
  if (reason === 'manual') {
    return { tone: 'info', message: 'Connecting to terminal…' };
  }
  if (reason === 'takeover') {
    return { tone: 'info', message: 'Connecting to terminal…' };
  }
  if (preferredMode === 'view') {
    return { tone: 'info', message: 'Read-only terminal.' };
  }
  return null;
};

const appendToOutputSnapshot = (taskId: string, payload: Record<string, unknown>): TerminalOutputEvent | null => {
  const data = typeof payload.data === 'string' ? payload.data : '';
  if (!data) {
    return null;
  }

  const snapshot = getOrCreateOutputSnapshot(taskId);
  const seq = normalizeInteger(payload.seq) ?? snapshot.lastSeq + 1;
  if (seq <= snapshot.lastSeq) {
    return null;
  }

  let bufferedData = data;
  let bufferedByteLength = getChunkByteLength(bufferedData);
  if (bufferedByteLength >= MAX_OUTPUT_BUFFER_BYTES) {
    bufferedData = trimChunkToTailBytes(bufferedData, MAX_OUTPUT_BUFFER_BYTES);
    bufferedByteLength = getChunkByteLength(bufferedData);
    snapshot.chunks = [bufferedData];
    snapshot.bufferedByteCount = bufferedByteLength;
  } else {
    snapshot.chunks.push(bufferedData);
    snapshot.bufferedByteCount += bufferedByteLength;
    let overflow = snapshot.bufferedByteCount - MAX_OUTPUT_BUFFER_BYTES;
    while (overflow > 0 && snapshot.chunks.length > 0) {
      const firstChunk = snapshot.chunks[0] ?? '';
      const firstChunkByteLength = getChunkByteLength(firstChunk);
      if (firstChunkByteLength <= overflow) {
        snapshot.chunks.shift();
        snapshot.bufferedByteCount -= firstChunkByteLength;
        overflow -= firstChunkByteLength;
        continue;
      }
      snapshot.chunks[0] = trimChunkToTailBytes(firstChunk, firstChunkByteLength - overflow);
      snapshot.bufferedByteCount -= overflow;
      overflow = 0;
    }
  }

  snapshot.lastSeq = seq;
  snapshot.appendCount += 1;
  appendToResumeSnapshot(taskId, snapshot.lastSeq, data);

  const event = {
    taskId,
    seq,
    data,
    snapshot: cloneOutputSnapshot(snapshot),
    replace: false,
  };

  const listeners = terminalOutputListeners.get(taskId);
  if (listeners && listeners.size > 0) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  return event;
};

const flushPendingResumeOutputs = (taskId: string): void => {
  const pendingOutputs = pendingResumeOutputPayloads.get(taskId) ?? [];
  pendingResumeOutputPayloads.delete(taskId);
  for (const pendingPayload of pendingOutputs) {
    appendToOutputSnapshot(taskId, pendingPayload);
  }
};

const clearPendingResumeHydration = (taskId: string): void => {
  pendingResumeHydrationTaskIds.delete(taskId);
  clearPendingResumeFallbackTimer(taskId);
};

const fallbackFreshResumeAttach = (taskId: string): void => {
  if (!pendingResumeHydrationTaskIds.has(taskId)) {
    return;
  }
  clearPendingResumeHydration(taskId);
  flushPendingResumeOutputs(taskId);
};

const replaceOutputSnapshot = (taskId: string, payload: Record<string, unknown>): TerminalOutputEvent | null => {
  const nextLastSeq = normalizeNonNegativeInteger(payload.last_seq ?? payload.lastSeq) ?? 0;
  const data = typeof payload.data === 'string' ? payload.data : '';
  const currentSnapshot = getOrCreateOutputSnapshot(taskId);
  if (currentSnapshot.lastSeq > nextLastSeq) {
    return null;
  }

  const trimmedData = trimChunkToTailBytes(data, MAX_OUTPUT_BUFFER_BYTES);
  const bufferedByteCount = getChunkByteLength(trimmedData);
  const nextSnapshot: TerminalOutputSnapshot = {
    taskId,
    lastSeq: nextLastSeq,
    chunks: trimmedData ? [trimmedData] : [],
    bufferedByteCount,
    appendCount: currentSnapshot.appendCount + 1,
  };
  terminalOutputSnapshots.set(taskId, nextSnapshot);
  updateResumeSnapshot(taskId, nextLastSeq, trimmedData);

  return {
    taskId,
    seq: nextLastSeq,
    data: trimmedData,
    snapshot: cloneOutputSnapshot(nextSnapshot),
    replace: true,
  };
};

export const getTerminalOutputSnapshot = (taskId: string): TerminalOutputSnapshot =>
  cloneOutputSnapshot(getOrCreateOutputSnapshot(taskId));

export const subscribeTerminalOutput = (taskId: string, listener: (event: TerminalOutputEvent) => void): (() => void) => {
  const listeners = terminalOutputListeners.get(taskId) ?? new Set<(event: TerminalOutputEvent) => void>();
  listeners.add(listener);
  terminalOutputListeners.set(taskId, listeners);
  return () => {
    const current = terminalOutputListeners.get(taskId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      terminalOutputListeners.delete(taskId);
    }
  };
};

export const subscribeTerminalTransportSignal = (
  taskId: string,
  listener: (signal: TerminalTransportSignal) => void,
): (() => void) => {
  const listeners =
    terminalTransportSignalListeners.get(taskId) ?? new Set<(signal: TerminalTransportSignal) => void>();
  listeners.add(listener);
  terminalTransportSignalListeners.set(taskId, listeners);
  return () => {
    const current = terminalTransportSignalListeners.get(taskId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      terminalTransportSignalListeners.delete(taskId);
    }
  };
};

export const clearAllTerminalOutputSnapshots = (): void => {
  for (const taskId of pendingResumePersistTimers.keys()) {
    clearPendingResumePersistTimer(taskId);
  }
  for (const taskId of pendingResumeFallbackTimers.keys()) {
    clearPendingResumeFallbackTimer(taskId);
  }
  terminalOutputSnapshots.clear();
  terminalResumeSnapshots.clear();
  terminalOutputListeners.clear();
  terminalTransportSignalListeners.clear();
  pendingResumeHydrationTaskIds.clear();
  pendingResumeOutputPayloads.clear();
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(TERMINAL_RESUME_SNAPSHOT_STORAGE_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    safeStorageRemoveItem(storage, key);
  }
};

const clearTerminalOutputSnapshot = (taskId: string): void => {
  clearPendingResumePersistTimer(taskId);
  clearPendingResumeFallbackTimer(taskId);
  terminalOutputSnapshots.delete(taskId);
  terminalResumeSnapshots.delete(taskId);
  terminalOutputListeners.delete(taskId);
  terminalTransportSignalListeners.delete(taskId);
  pendingResumeHydrationTaskIds.delete(taskId);
  pendingResumeOutputPayloads.delete(taskId);
  clearPersistedResumeSnapshot(taskId);
};

export const useTerminalStore = create<TerminalStoreState>()((set) => ({
  byTask: {},

  markAttaching: (taskId, options) => set((state) => ({
    byTask: withTask(state.byTask, taskId, (current) => {
      const preferredMode = options?.preferredMode ?? current.preferredMode;
      return {
        ...current,
        isAttached: true,
        preferredMode,
        hasWriteAccess: preferredMode === 'write' ? current.hasWriteAccess : false,
        connectionState: current.connectionState === 'open' ? 'open' : 'connecting',
        error: null,
        banner: buildAttachBanner(options?.reason, preferredMode),
      };
    }),
  })),

  markDetached: (taskId) => set((state) => ({
    byTask: withTask(state.byTask, taskId, (current) => ({
      ...current,
      isAttached: false,
      hasWriteAccess: false,
      viewerCount: Math.max(0, current.viewerCount - 1),
      connectionState:
        current.connectionState === 'open' || current.connectionState === 'connecting'
          ? 'idle'
          : current.connectionState,
      banner: null,
    })),
  })),

  setPreferredMode: (taskId, mode) => set((state) => ({
    byTask: withTask(state.byTask, taskId, (current) => ({
      ...current,
      preferredMode: mode,
      hasWriteAccess: mode === 'view' ? false : current.hasWriteAccess,
      banner:
        mode === 'view'
          ? {
              tone: 'info',
              message: 'Read-only terminal.',
            }
          : current.banner,
    })),
  })),

  markSocketDisconnected: () => set((state) => {
    const nextByTask: Record<string, TerminalSessionState> = {};
    for (const [taskId, session] of Object.entries(state.byTask)) {
      nextByTask[taskId] =
        session.isAttached && session.connectionState === 'open'
          ? {
              ...session,
              connectionState: 'connecting',
              banner: {
                tone: 'warning',
                message: 'Connection lost. Reconnecting…',
              },
            }
          : session;
    }
    return { byTask: nextByTask };
  }),

  beginFreshResumeAttach: (taskId) => set((state) => {
    pendingResumeHydrationTaskIds.add(taskId);
    pendingResumeOutputPayloads.set(taskId, []);
    clearPendingResumeFallbackTimer(taskId);
    pendingResumeFallbackTimers.set(
      taskId,
      setTimeout(() => {
        fallbackFreshResumeAttach(taskId);
      }, TERMINAL_FRESH_RESUME_FALLBACK_MS),
    );
    return state;
  }),

  markOpened: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }
    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        ptySessionId: normalizeOptionalString(payload.pty_session_id ?? payload.ptySessionId) ?? current.ptySessionId ?? null,
        connectionState: 'open',
        isAttached: true,
        pid: normalizeInteger(payload.pid),
        cwd: normalizeOptionalString(payload.cwd) ?? current.cwd ?? null,
        shell: normalizeOptionalString(payload.shell) ?? current.shell ?? null,
        cols: normalizeInteger(payload.cols) ?? current.cols ?? null,
        rows: normalizeInteger(payload.rows) ?? current.rows ?? null,
        startedAt: normalizeOptionalString(payload.started_at ?? payload.startedAt) ?? current.startedAt ?? null,
        closedAt: null,
        exitCode: null,
        signal: null,
        error: null,
        banner:
          current.banner?.tone === 'warning' || current.banner?.tone === 'info'
            ? null
            : current.banner ?? null,
      })),
    };
  }),

  appendOutput: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }

    if (pendingResumeHydrationTaskIds.has(taskId)) {
      const pending = pendingResumeOutputPayloads.get(taskId) ?? [];
      pending.push({ ...payload });
      pendingResumeOutputPayloads.set(taskId, pending);
      return state;
    }

    const appended = appendToOutputSnapshot(taskId, payload);
    if (!appended) {
      return state;
    }

    const latencySample = buildLatencySample(payload);
    const current = state.byTask[taskId];
    if (!current) {
      return {
        byTask: withTask(state.byTask, taskId, (session) => ({
          ...session,
          connectionState: 'open',
          lastLatencySample: latencySample ?? session.lastLatencySample ?? null,
        })),
      };
    }

    if (!latencySample && current.connectionState !== 'error') {
      return state;
    }

    return {
      byTask: withTask(state.byTask, taskId, (session) => ({
        ...session,
        connectionState: session.connectionState === 'error' ? 'error' : 'open',
        lastLatencySample: latencySample ?? session.lastLatencySample ?? null,
      })),
    };
  }),

  applySnapshot: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }

    const currentSnapshot = getOrCreateOutputSnapshot(taskId);
    const shouldApplySnapshot =
      pendingResumeHydrationTaskIds.has(taskId) || (currentSnapshot.lastSeq === 0 && currentSnapshot.chunks.length === 0);
    if (!shouldApplySnapshot) {
      return state;
    }

    const snapshotEvent = replaceOutputSnapshot(taskId, payload);
    clearPendingResumeHydration(taskId);

    if (snapshotEvent) {
      const listeners = terminalOutputListeners.get(taskId);
      if (listeners && listeners.size > 0) {
        for (const listener of listeners) {
          listener(snapshotEvent);
        }
      }
    }

    flushPendingResumeOutputs(taskId);

    return state;
  }),

  markExit: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }
    fallbackFreshResumeAttach(taskId);
    const exitCode = normalizeInteger(payload.exit_code ?? payload.exitCode);
    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        connectionState: 'exited',
        hasWriteAccess: false,
        closedAt: normalizeOptionalString(payload.closed_at ?? payload.closedAt) ?? current.closedAt ?? null,
        exitCode,
        signal: normalizeOptionalString(payload.signal) ?? null,
        banner: {
          tone: exitCode === 0 ? 'success' : 'warning',
          message: exitCode === 0 ? 'Terminal exited successfully.' : 'Terminal session exited.',
        },
      })),
    };
  }),

  markError: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }
    fallbackFreshResumeAttach(taskId);
    const message = normalizeOptionalString(payload.message) ?? 'terminal error';
    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        connectionState: 'error',
        hasWriteAccess: false,
        error: message,
        closedAt: normalizeOptionalString(payload.closed_at ?? payload.closedAt) ?? current.closedAt ?? null,
        isAttached: true,
        banner: {
          tone: 'error',
          message,
        },
      })),
    };
  }),

  markTaskStatus: (taskId, status) => set((state) => {
    const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';
    if (normalizedStatus !== 'completed' && normalizedStatus !== 'killed') {
      return state;
    }

    fallbackFreshResumeAttach(taskId);

    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        connectionState: 'exited',
        isAttached: false,
        hasWriteAccess: false,
        banner: {
          tone: normalizedStatus === 'completed' ? 'success' : 'warning',
          message:
            normalizedStatus === 'completed'
              ? 'Task completed. Terminal session is no longer active.'
              : 'Task was killed. Terminal session is no longer active.',
        },
      })),
    };
  }),

  updateAccess: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    if (!taskId) {
      return state;
    }
    const writeAccess = payload.write_access === true || payload.writeAccess === true;
    const writerActive = payload.writer_active === true || payload.writerActive === true;
    const viewerCount = normalizeInteger(payload.viewer_count ?? payload.viewerCount) ?? 0;

    return {
      byTask: withTask(state.byTask, taskId, (current) => {
        let banner = current.banner ?? null;
        if (current.hasWriteAccess && !writeAccess) {
          banner = {
            tone: 'warning',
            message: 'Terminal is now read-only.',
          };
        } else if (!current.hasWriteAccess && writeAccess) {
          banner = {
            tone: 'success',
            message: 'Write access granted.',
          };
        } else if (!writeAccess && writerActive && current.preferredMode === 'write') {
          banner = {
            tone: 'warning',
            message: 'Another session is controlling this terminal.',
          };
        } else if (!writerActive && current.preferredMode === 'view') {
          banner = {
            tone: 'info',
            message: 'No active controller.',
          };
        }

        return {
          ...current,
          hasWriteAccess: writeAccess,
          viewerCount,
          banner,
        };
      }),
    };
  }),

  updateTransportSession: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    const sessionId = normalizeOptionalString(payload.session_id ?? payload.sessionId);
    if (!taskId || !sessionId) {
      return state;
    }

    const hasTransportState =
      payload.transport_state !== undefined || payload.transportState !== undefined || payload.transport_mode !== undefined;
    const hasTransportPolicy =
      payload.transport_policy !== undefined || payload.transportPolicy !== undefined || payload.transport_mode !== undefined;

    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        transportState: hasTransportState
          ? normalizeTransportState(payload.transport_state ?? payload.transportState ?? payload.transport_mode)
          : current.transportState,
        transportSession: {
          sessionId,
          transportState: hasTransportState
            ? normalizeTransportState(payload.transport_state ?? payload.transportState ?? payload.transport_mode)
            : current.transportSession?.transportState ?? current.transportState,
          transportPolicy: hasTransportPolicy
            ? normalizeTransportPolicy(payload.transport_policy ?? payload.transportPolicy ?? payload.transport_mode)
            : current.transportSession?.transportPolicy ?? 'relay_only',
          issuedAt:
            normalizeIsoTimestamp(payload.issued_at ?? payload.issuedAt) ?? current.transportSession?.issuedAt ?? null,
          expiresAt:
            normalizeIsoTimestamp(payload.expires_at ?? payload.expiresAt) ?? current.transportSession?.expiresAt ?? null,
          writerConnectionId:
            normalizeOptionalString(payload.writer_connection_id ?? payload.writerConnectionId) ??
            current.transportSession?.writerConnectionId ??
            null,
          ticket: normalizeOptionalString(payload.ticket) ?? current.transportSession?.ticket ?? null,
          directCandidate:
            payload.direct_candidate === true ||
            payload.directCandidate === true ||
            ((payload.direct_candidate === undefined && payload.directCandidate === undefined)
              ? (current.transportSession?.directCandidate ?? false)
              : false),
        },
      })),
    };
  }),

  handleTransportSignal: (payload) => set((state) => {
    const taskId = normalizeTaskId(payload.task_id ?? payload.taskId);
    const sessionId = normalizeOptionalString(payload.session_id ?? payload.sessionId);
    const signalType = normalizeOptionalString(payload.signal_type ?? payload.signalType);
    if (!taskId || !sessionId || !signalType) {
      return state;
    }

    const listeners = terminalTransportSignalListeners.get(taskId);
    if (listeners && listeners.size > 0) {
      const signal: TerminalTransportSignal = {
        taskId,
        sessionId,
        signalType,
        description:
          payload.description && typeof payload.description === 'object' && !Array.isArray(payload.description)
            ? (payload.description as Record<string, unknown>)
            : undefined,
        candidate:
          payload.candidate && typeof payload.candidate === 'object' && !Array.isArray(payload.candidate)
            ? (payload.candidate as Record<string, unknown>)
            : undefined,
        payload,
      };
      for (const listener of listeners) {
        listener(signal);
      }
    }

    return {
      byTask: withTask(state.byTask, taskId, (current) => ({
        ...current,
        transportState:
          current.transportSession?.sessionId === sessionId && current.transportState === 'relay'
            ? 'negotiating'
            : current.transportState,
      })),
    };
  }),

  clearBanner: (taskId) => set((state) => ({
    byTask: withTask(state.byTask, taskId, (current) => ({
      ...current,
      banner: null,
    })),
  })),

  clearTask: (taskId) => set((state) => {
    clearTerminalOutputSnapshot(taskId);
    const nextByTask = { ...state.byTask };
    delete nextByTask[taskId];
    return { byTask: nextByTask };
  }),
}));
