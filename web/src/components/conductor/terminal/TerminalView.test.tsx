import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';
import { MAX_OUTPUT_BUFFER_BYTES, clearAllTerminalOutputSnapshots, useTerminalStore } from '@/lib/conductor/stores/terminal';
import { useWebSocketStore } from '@/lib/conductor/stores/websocket';

const { terminalWriteMock, terminalClearMock, MockTerminal, MockFitAddon } = vi.hoisted(() => {
  const terminalWriteMock = vi.fn();
  const terminalClearMock = vi.fn();

  class HoistedMockTerminal {
    cols = 80;
    rows = 24;

    open() {}

    write(data: string) {
      terminalWriteMock(data);
    }

    clear() {
      terminalClearMock();
    }

    focus() {}

    dispose() {}

    loadAddon() {}

    onData() {
      return { dispose() {} };
    }
  }

  class HoistedMockFitAddon {
    fit() {}
  }

  return {
    terminalWriteMock,
    terminalClearMock,
    MockTerminal: HoistedMockTerminal,
    MockFitAddon: HoistedMockFitAddon,
  };
});

vi.mock('./xterm-loader', () => ({
  loadXtermModules: vi.fn().mockResolvedValue({
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
  }),
}));

const sendMock = vi.fn();

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const renderTerminalView = async (task: any) => {
  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(<TerminalView task={task} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return view as ReturnType<typeof render>;
};

describe('TerminalView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMock.mockReset();
    terminalWriteMock.mockReset();
    terminalClearMock.mockReset();
    useWebSocketStore.setState({
      status: 'connected',
      ws: null,
      reconnectAttempts: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: sendMock,
    });
    clearAllTerminalOutputSnapshots();
    useTerminalStore.setState({
      byTask: {},
    });
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not send a stale detach when the same task remounts quickly', async () => {
    const task = {
      id: 'task-pty-remount',
      title: 'PTY Remount',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    const firstRender = render(<TerminalView task={task} />);
    await flushMicrotasks();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_attach',
      payload: expect.objectContaining({
        task_id: 'task-pty-remount',
        mode: 'write',
        force: true,
      }),
    }));

    sendMock.mockClear();
    firstRender.unmount();

    const secondRender = render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_attach',
      payload: expect.objectContaining({
        task_id: 'task-pty-remount',
      }),
    }));

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_detach',
    }));

    secondRender.unmount();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(sendMock).toHaveBeenCalledWith({
      type: 'terminal_detach',
      payload: {
        task_id: 'task-pty-remount',
      },
    });
  });

  it('restores buffered terminal output after remounting the same task', async () => {
    const task = {
      id: 'task-pty-history',
      title: 'PTY History',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
        lastOutputSeq: 2,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-history',
      seq: 1,
      data: 'echo hello\r\n',
    });
    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-history',
      seq: 2,
      data: 'hello\r\n',
    });

    const firstRender = render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(terminalWriteMock).toHaveBeenCalledWith('echo hello\r\nhello\r\n');

    terminalWriteMock.mockClear();
    firstRender.unmount();

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(terminalWriteMock).toHaveBeenCalledWith('echo hello\r\nhello\r\n');
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByText('view only')).toBeNull();
    expect(screen.queryByText(/viewers:/i)).toBeNull();
  });

  it('appends new output after buffer trimming without replaying the whole screen', async () => {
    const initialChunk = 'a'.repeat(MAX_OUTPUT_BUFFER_BYTES - 5);
    const appendedChunk = '123456';
    const task = {
      id: 'task-pty-trim',
      title: 'PTY Trim',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
        lastOutputSeq: 2,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.getState().appendOutput({
      task_id: 'task-pty-trim',
      seq: 1,
      data: initialChunk,
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    terminalWriteMock.mockClear();
    terminalClearMock.mockClear();

    act(() => {
      useTerminalStore.getState().appendOutput({
        task_id: 'task-pty-trim',
        seq: 2,
        data: appendedChunk,
      });
    });

    expect(terminalClearMock).not.toHaveBeenCalled();
    expect(terminalWriteMock).toHaveBeenCalledWith(appendedChunk);
  });

  it('does not auto-reattach when the terminal is already in an error state', async () => {
    const task = {
      id: 'task-pty-error',
      title: 'PTY Error',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-error': {
          taskId: 'task-pty-error',
          connectionState: 'error',
          isAttached: true,
          hasWriteAccess: false,
          viewerCount: 0,
          preferredMode: 'write',
          transportState: 'relay',
          error: 'Agent offline',
          banner: {
            tone: 'error',
            message: 'Agent offline',
          },
        },
      },
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_attach',
      payload: expect.objectContaining({
        task_id: 'task-pty-error',
      }),
    }));
    expect(screen.queryByRole('button', { name: /reattach/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view only/i })).toBeNull();
  });

  it('does not render terminal action buttons for killed tasks', async () => {
    const task = {
      id: 'task-pty-killed',
      title: 'PTY Killed',
      taskType: 'pty_task',
      status: 'killed',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_attach',
      payload: expect.objectContaining({
        task_id: 'task-pty-killed',
      }),
    }));
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reattach/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view only/i })).toBeNull();
  });

  it('shows relay transport state in the terminal header', async () => {
    const task = {
      id: 'task-pty-transport',
      title: 'PTY Transport',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.getState().updateTransportSession({
      task_id: 'task-pty-transport',
      session_id: 'transport-1',
      transport_state: 'relay',
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(screen.getByText('Relay')).toBeInTheDocument();
  });

  it('sends common shortcut input from the header dropdown', async () => {
    const task = {
      id: 'task-pty-shortcuts',
      title: 'PTY Shortcuts',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-shortcuts': {
          taskId: 'task-pty-shortcuts',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          banner: null,
        },
      },
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();
    sendMock.mockClear();

    fireEvent.change(screen.getByRole('combobox', { name: /terminal shortcuts/i }), {
      target: { value: 'ctrl_c' },
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'terminal_input',
        payload: expect.objectContaining({
          task_id: 'task-pty-shortcuts',
          data: '\u0003',
        }),
      }),
    );
  });

  it('renders shortcut dropdown as mobile-only UI', async () => {
    const task = {
      id: 'task-pty-shortcuts-mobile',
      title: 'PTY Shortcuts Mobile',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-shortcuts-mobile': {
          taskId: 'task-pty-shortcuts-mobile',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          banner: null,
        },
      },
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(screen.getByRole('combobox', { name: /terminal shortcuts/i })).toHaveClass('md:hidden');
  });

  it('disables shortcut dropdown when terminal is not writable', async () => {
    const task = {
      id: 'task-pty-shortcuts-disabled',
      title: 'PTY Shortcuts Disabled',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-shortcuts-disabled': {
          taskId: 'task-pty-shortcuts-disabled',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: false,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          banner: null,
        },
      },
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(screen.getByRole('combobox', { name: /terminal shortcuts/i })).toBeDisabled();
  });

  it('starts direct negotiation and falls back to relay when RTC direct path is unavailable', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      class MockRTCPeerConnection {
        onicecandidate: ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void) | null =
          null;

        createDataChannel() {
          return {
            close() {},
            onopen: null,
            onclose: null,
          };
        }

        async createOffer() {
          return {
            type: 'offer' as const,
            sdp: 'v=0',
          };
        }

        async setLocalDescription() {}

        async setRemoteDescription() {}

        async addIceCandidate() {}

        close() {}
      } as unknown as typeof RTCPeerConnection,
    );

    const task = {
      id: 'task-pty-direct',
      title: 'PTY Direct',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-direct': {
          taskId: 'task-pty-direct',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          transportSession: {
            sessionId: 'transport-direct-1',
            transportState: 'relay',
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

    await renderTerminalView(task);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pty_transport_signal',
        payload: expect.objectContaining({
          task_id: 'task-pty-direct',
          session_id: 'transport-direct-1',
          signal_type: 'offer',
          protocol: 'webrtc-datachannel-v1',
          description: {
            type: 'offer',
            sdp: 'v=0',
          },
        }),
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    expect(useTerminalStore.getState().byTask['task-pty-direct']).toMatchObject({
      transportState: 'fallback_relay',
    });
  });

  it('accepts a relayed RTC answer and moves terminal transport into direct state', async () => {
    let channelRef:
      | {
          close: () => void;
          onopen: null | (() => void);
          onclose: null | (() => void);
        }
      | null = null;

    class MockRTCPeerConnection {
      onicecandidate: ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void) | null =
        null;

      createDataChannel() {
        channelRef = {
          close() {},
          onopen: null,
          onclose: null,
        };
        return channelRef;
      }

      async createOffer() {
        return {
          type: 'offer' as const,
          sdp: 'v=0',
        };
      }

      async setLocalDescription() {}

      async setRemoteDescription() {}

      async addIceCandidate() {}

      close() {}
    }

    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection);

    const task = {
      id: 'task-pty-answer',
      title: 'PTY Answer',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-answer': {
          taskId: 'task-pty-answer',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          transportSession: {
            sessionId: 'transport-answer-1',
            transportState: 'relay',
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

    await renderTerminalView(task);

    await act(async () => {
      useTerminalStore.getState().handleTransportSignal({
        task_id: 'task-pty-answer',
        session_id: 'transport-answer-1',
        signal_type: 'answer',
        description: {
          type: 'answer',
          sdp: 'v=0-answer',
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      channelRef?.onopen?.();
      await Promise.resolve();
    });

    expect(useTerminalStore.getState().byTask['task-pty-answer']).toMatchObject({
      transportState: 'direct',
    });
  });

  it('retries direct negotiation when writer control returns with a fresh transport session epoch', async () => {
    let offerCount = 0;

    class MockRTCPeerConnection {
      onicecandidate: ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void) | null =
        null;

      createDataChannel() {
        return {
          close() {},
          onopen: null,
          onclose: null,
        };
      }

      async createOffer() {
        offerCount += 1;
        return {
          type: 'offer' as const,
          sdp: `v=0-offer-${offerCount}`,
        };
      }

      async setLocalDescription() {}

      async setRemoteDescription() {}

      async addIceCandidate() {}

      close() {}
    }

    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection);

    const task = {
      id: 'task-pty-epoch-retry',
      title: 'PTY Epoch Retry',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-epoch-retry': {
          taskId: 'task-pty-epoch-retry',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          transportSession: {
            sessionId: 'transport-epoch-1',
            transportState: 'relay',
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

    await renderTerminalView(task);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pty_transport_signal',
        payload: expect.objectContaining({
          task_id: 'task-pty-epoch-retry',
          session_id: 'transport-epoch-1',
          signal_type: 'offer',
        }),
      }),
    );

    sendMock.mockClear();

    await act(async () => {
      useTerminalStore.getState().updateAccess({
        task_id: 'task-pty-epoch-retry',
        write_access: false,
        writer_active: true,
        viewer_count: 2,
      });
      await Promise.resolve();
    });

    expect(useTerminalStore.getState().byTask['task-pty-epoch-retry']).toMatchObject({
      hasWriteAccess: false,
      transportState: 'fallback_relay',
    });

    await act(async () => {
      useTerminalStore.getState().updateAccess({
        task_id: 'task-pty-epoch-retry',
        write_access: true,
        writer_active: true,
        viewer_count: 1,
      });
      useTerminalStore.getState().updateTransportSession({
        task_id: 'task-pty-epoch-retry',
        session_id: 'transport-epoch-2',
        transport_state: 'relay',
        transport_policy: 'direct_preferred',
        writer_connection_id: 'conn-1',
        direct_candidate: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pty_transport_signal',
        payload: expect.objectContaining({
          task_id: 'task-pty-epoch-retry',
          session_id: 'transport-epoch-2',
          signal_type: 'offer',
        }),
      }),
    );
  });

  it('does not detach the terminal when transport state changes during direct negotiation', async () => {
    const task = {
      id: 'task-pty-no-detach',
      title: 'PTY No Detach',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-no-detach': {
          taskId: 'task-pty-no-detach',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          transportSession: {
            sessionId: 'transport-no-detach-1',
            transportState: 'relay',
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

    await renderTerminalView(task);
    sendMock.mockClear();

    await act(async () => {
      useTerminalStore.getState().updateTransportSession({
        task_id: 'task-pty-no-detach',
        session_id: 'transport-no-detach-1',
        transport_state: 'negotiating',
        transport_policy: 'direct_preferred',
        direct_candidate: true,
      });
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(sendMock).not.toHaveBeenCalledWith({
      type: 'terminal_detach',
      payload: {
        task_id: 'task-pty-no-detach',
      },
    });
  });

  it('falls back to relay locally when direct writer loses write access', async () => {
    const task = {
      id: 'task-pty-writer-revoked',
      title: 'PTY Writer Revoked',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-writer-revoked': {
          taskId: 'task-pty-writer-revoked',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: false,
          viewerCount: 2,
          preferredMode: 'view',
          transportState: 'direct',
          transportSession: {
            sessionId: 'transport-writer-revoked-1',
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

    await renderTerminalView(task);

    expect(useTerminalStore.getState().byTask['task-pty-writer-revoked']).toMatchObject({
      hasWriteAccess: false,
      transportState: 'fallback_relay',
      transportSession: expect.objectContaining({
        sessionId: 'transport-writer-revoked-1',
        transportState: 'fallback_relay',
        directCandidate: false,
      }),
    });
    expect(sendMock).not.toHaveBeenCalledWith({
      type: 'terminal_detach',
      payload: {
        task_id: 'task-pty-writer-revoked',
      },
    });
  });

  it('shows the latest PTY latency sample in the terminal header', async () => {
    const task = {
      id: 'task-pty-latency',
      title: 'PTY Latency',
      taskType: 'pty_task',
      status: 'running',
      agentHost: 'debug',
      executionHost: 'debug',
      launchConfig: null,
      ptySession: {
        cols: 80,
        rows: 24,
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: null,
    } as any;

    useTerminalStore.setState({
      byTask: {
        'task-pty-latency': {
          taskId: 'task-pty-latency',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'relay',
          lastLatencySample: {
            clientInputSeq: 9,
            clientSentAt: '2026-03-17T02:00:00.000Z',
            serverReceivedAt: '2026-03-17T02:00:00.020Z',
            daemonReceivedAt: '2026-03-17T02:00:00.040Z',
            firstOutputAt: '2026-03-17T02:00:00.120Z',
            daemonInputToFirstOutputMs: 80,
            clientInputToRenderMs: 120,
            renderedAt: '2026-03-17T02:00:00.120Z',
          },
          banner: null,
        },
      },
    });

    render(<TerminalView task={task} />);
    await flushMicrotasks();

    expect(screen.getByText('Latency 120ms')).toBeInTheDocument();
  });
});
