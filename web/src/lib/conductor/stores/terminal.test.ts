import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OUTPUT_BUFFER_BYTES,
  TERMINAL_FRESH_RESUME_FALLBACK_MS,
  TERMINAL_RESUME_SNAPSHOT_PERSIST_DELAY_MS,
  clearAllTerminalOutputSnapshots,
  getTerminalOutputSnapshot,
  subscribeTerminalOutput,
  subscribeTerminalTransportSignal,
  useTerminalStore,
} from './terminal';

const textEncoder = new TextEncoder();

describe('terminal store', () => {
  beforeEach(() => {
    clearAllTerminalOutputSnapshots();
    sessionStorage.clear();
    useTerminalStore.setState({
      byTask: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks attached open sessions as reconnecting when websocket disconnects', () => {
    useTerminalStore.getState().markOpened({
      task_id: 'task-pty-1',
      pty_session_id: 'pty-1',
      cwd: '/tmp/worktree',
      shell: '/bin/zsh',
    });

    useTerminalStore.getState().markSocketDisconnected();

    expect(useTerminalStore.getState().byTask['task-pty-1']).toMatchObject({
      connectionState: 'connecting',
      banner: {
        tone: 'warning',
        message: 'Connection lost. Reconnecting…',
      },
    });
  });

  it('switches to view-only mode immediately on the client', () => {
    useTerminalStore.getState().markOpened({
      task_id: 'task-pty-2',
      pty_session_id: 'pty-2',
    });
    useTerminalStore.getState().updateAccess({
      task_id: 'task-pty-2',
      write_access: true,
      writer_active: true,
      viewer_count: 1,
    });

    useTerminalStore.getState().setPreferredMode('task-pty-2', 'view');

    expect(useTerminalStore.getState().byTask['task-pty-2']).toMatchObject({
      preferredMode: 'view',
      hasWriteAccess: false,
      banner: {
        tone: 'info',
        message: 'Read-only terminal.',
      },
    });
  });

  it('surfaces writer contention and takeover state', () => {
    useTerminalStore.getState().markAttaching('task-pty-3', {
      preferredMode: 'write',
      reason: 'initial',
    });

    useTerminalStore.getState().updateAccess({
      task_id: 'task-pty-3',
      write_access: false,
      writer_active: true,
      viewer_count: 2,
    });

    expect(useTerminalStore.getState().byTask['task-pty-3']).toMatchObject({
      hasWriteAccess: false,
      viewerCount: 2,
      banner: {
        tone: 'warning',
        message: 'Another session is controlling this terminal.',
      },
    });

    useTerminalStore.getState().updateAccess({
      task_id: 'task-pty-3',
      write_access: true,
      writer_active: true,
      viewer_count: 2,
    });

    expect(useTerminalStore.getState().byTask['task-pty-3']).toMatchObject({
      hasWriteAccess: true,
      viewerCount: 2,
      banner: {
        tone: 'success',
        message: 'Write access granted.',
      },
    });
  });

  it('marks terminal sessions exited when task status becomes killed', () => {
    useTerminalStore.getState().markOpened({
      task_id: 'task-pty-4',
      pty_session_id: 'pty-4',
      cwd: '/tmp/worktree',
    });
    useTerminalStore.getState().updateAccess({
      task_id: 'task-pty-4',
      write_access: true,
      writer_active: true,
      viewer_count: 1,
    });

    useTerminalStore.getState().markTaskStatus('task-pty-4', 'killed');

    expect(useTerminalStore.getState().byTask['task-pty-4']).toMatchObject({
      connectionState: 'exited',
      isAttached: false,
      hasWriteAccess: false,
      banner: {
        tone: 'warning',
        message: 'Task was killed. Terminal session is no longer active.',
      },
    });
  });

  it('keeps a bounded output snapshot for remount restore', () => {
    const firstChunk = 'a'.repeat(MAX_OUTPUT_BUFFER_BYTES - 8);
    const secondChunk = 'bcdefghij';

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-5',
      seq: 1,
      data: firstChunk,
    });
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-5',
      seq: 2,
      data: secondChunk,
    });

    const snapshot = getTerminalOutputSnapshot('task-pty-5');
    expect(snapshot.bufferedByteCount).toBe(MAX_OUTPUT_BUFFER_BYTES);
    expect(snapshot.chunks.join('').endsWith(secondChunk)).toBe(true);
    expect(snapshot.chunks.join('').startsWith('a')).toBe(true);
    expect(snapshot.appendCount).toBe(2);
  });

  it('trims oversized utf8 chunks on byte boundaries', () => {
    const oversizedChunk = '中'.repeat(Math.floor(MAX_OUTPUT_BUFFER_BYTES / 3) + 1);

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-6',
      seq: 1,
      data: oversizedChunk,
    });

    const snapshot = getTerminalOutputSnapshot('task-pty-6');
    const restored = snapshot.chunks.join('');
    expect(textEncoder.encode(restored).length).toBeLessThanOrEqual(MAX_OUTPUT_BUFFER_BYTES);
    expect(restored.startsWith('中')).toBe(true);
    expect(restored.endsWith('中')).toBe(true);
    expect(snapshot.bufferedByteCount).toBe(textEncoder.encode(restored).length);
  });

  it('persists a bounded terminal resume snapshot for fresh reloads', () => {
    vi.useFakeTimers();

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-resume-storage',
      seq: 1,
      data: 'echo hello\r\n',
    });
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-resume-storage',
      seq: 2,
      data: 'hello\r\n',
    });

    vi.advanceTimersByTime(TERMINAL_RESUME_SNAPSHOT_PERSIST_DELAY_MS);

    expect(
      JSON.parse(sessionStorage.getItem('conductor-terminal-resume:task-pty-resume-storage') || 'null'),
    ).toMatchObject({
      lastSeq: 2,
      data: 'echo hello\r\nhello\r\n',
    });
  });

  it('retries resume snapshot persistence after an initial storage write failure', () => {
    vi.useFakeTimers();

    sessionStorage.setItem(
      'conductor-terminal-resume:older-task',
      JSON.stringify({
        lastSeq: 1,
        data: 'older\r\n',
        updatedAt: '2026-03-23T00:00:00.000Z',
      }),
    );

    const originalSetItem = Storage.prototype.setItem;
    let shouldFailFirstWrite = true;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string, value: string) {
      if (key === 'conductor-terminal-resume:task-pty-resume-quota' && shouldFailFirstWrite) {
        shouldFailFirstWrite = false;
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-resume-quota',
      seq: 1,
      data: 'latest\r\n',
    });

    vi.advanceTimersByTime(TERMINAL_RESUME_SNAPSHOT_PERSIST_DELAY_MS);

    expect(JSON.parse(sessionStorage.getItem('conductor-terminal-resume:task-pty-resume-quota') || 'null')).toMatchObject({
      lastSeq: 1,
      data: 'latest\r\n',
    });

    setItemSpy.mockRestore();
  });

  it('replaces the snapshot and flushes queued output after a fresh attach snapshot arrives', () => {
    const receivedEvents: Array<{ replace: boolean; data: string; seq: number }> = [];
    const unsubscribe = subscribeTerminalOutput('task-pty-fresh-attach', (event) => {
      receivedEvents.push({
        replace: event.replace === true,
        data: event.data,
        seq: event.seq,
      });
    });

    useTerminalStore.getState().beginFreshResumeAttach('task-pty-fresh-attach');
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-fresh-attach',
      seq: 6,
      data: 'tail\r\n',
    });

    expect(getTerminalOutputSnapshot('task-pty-fresh-attach')).toMatchObject({
      lastSeq: 0,
      chunks: [],
    });

    useTerminalStore.getState().applySnapshot({
      task_id: 'task-pty-fresh-attach',
      last_seq: 5,
      data: 'history\r\n',
    });

    expect(receivedEvents).toEqual([
      { replace: true, data: 'history\r\n', seq: 5 },
      { replace: false, data: 'tail\r\n', seq: 6 },
    ]);
    expect(getTerminalOutputSnapshot('task-pty-fresh-attach')).toMatchObject({
      lastSeq: 6,
      chunks: ['history\r\n', 'tail\r\n'],
    });

    unsubscribe();
  });

  it('falls back to queued terminal_output when a fresh attach snapshot never arrives', () => {
    vi.useFakeTimers();
    const receivedEvents: Array<{ replace: boolean; data: string; seq: number }> = [];
    const unsubscribe = subscribeTerminalOutput('task-pty-fresh-fallback', (event) => {
      receivedEvents.push({
        replace: event.replace === true,
        data: event.data,
        seq: event.seq,
      });
    });

    useTerminalStore.getState().beginFreshResumeAttach('task-pty-fresh-fallback');
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-fresh-fallback',
      seq: 2,
      data: 'legacy replay\r\n',
    });

    expect(getTerminalOutputSnapshot('task-pty-fresh-fallback')).toMatchObject({
      lastSeq: 0,
      chunks: [],
    });

    vi.advanceTimersByTime(TERMINAL_FRESH_RESUME_FALLBACK_MS);

    expect(receivedEvents).toEqual([
      { replace: false, data: 'legacy replay\r\n', seq: 2 },
    ]);
    expect(getTerminalOutputSnapshot('task-pty-fresh-fallback')).toMatchObject({
      lastSeq: 2,
      chunks: ['legacy replay\r\n'],
    });

    unsubscribe();
  });

  it('ignores terminal_snapshot replacement when the viewer is already hydrated', () => {
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-ignore-snapshot',
      seq: 3,
      data: 'existing output\r\n',
    });

    useTerminalStore.getState().applySnapshot({
      task_id: 'task-pty-ignore-snapshot',
      last_seq: 4,
      data: 'recent tail\r\n',
    });

    expect(getTerminalOutputSnapshot('task-pty-ignore-snapshot')).toMatchObject({
      lastSeq: 3,
      chunks: ['existing output\r\n'],
    });
  });

  it('stores PTY transport session state separately from terminal control state', () => {
    useTerminalStore.getState().updateTransportSession({
      task_id: 'task-pty-7',
      session_id: 'transport-1',
      transport_policy: 'direct_preferred',
      writer_connection_id: 'conn-1',
      issued_at: '2026-03-17T10:00:00.000Z',
      expires_at: '2026-03-17T10:00:30.000Z',
      direct_candidate: true,
    });

    expect(useTerminalStore.getState().byTask['task-pty-7']).toMatchObject({
      transportState: 'relay',
      transportSession: {
        sessionId: 'transport-1',
        transportState: 'relay',
        transportPolicy: 'direct_preferred',
        writerConnectionId: 'conn-1',
        directCandidate: true,
      },
    });
  });

  it('keeps current direct transport state when session metadata refresh arrives', () => {
    useTerminalStore.setState({
      byTask: {
        'task-pty-direct-refresh': {
          taskId: 'task-pty-direct-refresh',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 2,
          preferredMode: 'write',
          transportState: 'direct',
          transportSession: {
            sessionId: 'transport-refresh-1',
            transportState: 'direct',
            transportPolicy: 'direct_preferred',
            issuedAt: null,
            expiresAt: null,
            writerConnectionId: 'conn-1',
            ticket: null,
            directCandidate: true,
          },
          banner: null,
        },
      },
    });

    useTerminalStore.getState().updateTransportSession({
      task_id: 'task-pty-direct-refresh',
      session_id: 'transport-refresh-1',
      transport_policy: 'direct_preferred',
      writer_connection_id: 'conn-1',
      direct_candidate: true,
    });

    expect(useTerminalStore.getState().byTask['task-pty-direct-refresh']).toMatchObject({
      transportState: 'direct',
      transportSession: {
        sessionId: 'transport-refresh-1',
        transportState: 'direct',
      },
    });
  });

  it('emits PTY transport signaling messages to task-scoped listeners', () => {
    const signals: string[] = [];
    const unsubscribe = subscribeTerminalTransportSignal('task-pty-8', (signal) => {
      signals.push(signal.signalType);
    });

    useTerminalStore.getState().handleTransportSignal({
      task_id: 'task-pty-8',
      session_id: 'transport-8',
      signal_type: 'answer',
      description: {
        type: 'answer',
        sdp: 'v=0',
      },
    });

    unsubscribe();
    expect(signals).toEqual(['answer']);
  });
});
