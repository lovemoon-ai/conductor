'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { ChatView } from '@/features/chat';
import { TerminalView, useTerminalStore } from '@/features/terminal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useTasksStore } from '../store';

interface TaskDetailPaneProps {
  taskId: string;
  showBack?: boolean;
  onBack?: () => void;
  compactHeader?: boolean;
  showConnectionStatus?: boolean;
  hideHeader?: boolean;
}

// View mode for AI tasks. The two views are mutually exclusive (only one is
// mounted at a time) so that we never have multiple writers for the same
// AI session ID — that would lead to the daemon receiving overlapping
// messages from both the chat composer and an interactive terminal CLI.
type AiTaskViewMode = 'chat' | 'terminal';

const VIEW_MODE_STORAGE_PREFIX = 'conductor:ai-task-view:';

const readStoredViewMode = (taskId: string): AiTaskViewMode => {
  if (typeof window === 'undefined') {
    return 'chat';
  }
  try {
    const value = window.sessionStorage.getItem(`${VIEW_MODE_STORAGE_PREFIX}${taskId}`);
    return value === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
};

const writeStoredViewMode = (taskId: string, mode: AiTaskViewMode) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(`${VIEW_MODE_STORAGE_PREFIX}${taskId}`, mode);
  } catch {
    // sessionStorage unavailable (e.g., privacy mode) — fall back to component state only.
  }
};

export function TaskDetailPane({
  taskId,
  showBack = false,
  onBack,
  compactHeader = false,
  showConnectionStatus = false,
  hideHeader = false,
}: TaskDetailPaneProps) {
  const { tasks, fetchTask, markTaskRead } = useTasksStore();
  const [blockingLoadTaskId, setBlockingLoadTaskId] = useState<string | null>(null);
  const [aiViewMode, setAiViewMode] = useState<AiTaskViewMode>(() => readStoredViewMode(taskId));
  const terminalConnectionState = useTerminalStore((state) => state.byTask[taskId]?.connectionState ?? 'idle');
  const task = tasks.find((item) => item.id === taskId);

  useEffect(() => {
    setAiViewMode(readStoredViewMode(taskId));
  }, [taskId]);

  const handleSelectAiViewMode = (next: AiTaskViewMode) => {
    setAiViewMode((current) => {
      if (current === next) return current;
      writeStoredViewMode(taskId, next);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;

    if (taskId) {
      if (!task) {
        setBlockingLoadTaskId(taskId);
      } else {
        setBlockingLoadTaskId((current) => (current === taskId ? null : current));
      }

      void fetchTask(taskId).finally(() => {
        if (!cancelled) {
          setBlockingLoadTaskId((current) => (current === taskId ? null : current));
        }
      });
    } else {
      setBlockingLoadTaskId(null);
    }

    return () => {
      cancelled = true;
    };
  }, [fetchTask, taskId]);

  useEffect(() => {
    if (task) {
      setBlockingLoadTaskId((current) => (current === taskId ? null : current));
    }
  }, [task, taskId]);

  useEffect(() => {
    if (taskId) {
      markTaskRead(taskId);
    }
  }, [markTaskRead, taskId]);

  if (!task && blockingLoadTaskId === taskId) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!task) {
    return (
      <>
        {!hideHeader ? (
          <Header
            title="Task Not Found"
            showBack={showBack}
            onBack={onBack}
            compact={compactHeader}
          />
        ) : null}
        <div className="flex flex-1 items-center justify-center px-6 text-center text-muted">
          <p>This task does not exist or has been deleted.</p>
        </div>
      </>
    );
  }

  const taskType = task.taskType ?? 'ai_task';
  const isAiTask = taskType === 'ai_task';
  const isAiTerminalSessionStarted =
    terminalConnectionState === 'connecting' ||
    terminalConnectionState === 'open' ||
    terminalConnectionState === 'exited' ||
    terminalConnectionState === 'error';
  const lockAiTerminalView = isAiTask && aiViewMode === 'terminal' && isAiTerminalSessionStarted;
  const aiViewToggle = isAiTask ? (
    <AiTaskViewToggle
      value={aiViewMode}
      onChange={handleSelectAiViewMode}
      lockTerminalView={lockAiTerminalView}
    />
  ) : null;
  // pty_task always renders the terminal; ai_task respects the toggle.
  // Mounting one view at a time guarantees a single writer per AI session.
  const showTerminal = taskType === 'pty_task' || (isAiTask && aiViewMode === 'terminal');

  return (
    <>
      {!hideHeader ? (
        <Header
          title={task.title}
          showBack={showBack}
          onBack={onBack}
          showConnectionStatus={showConnectionStatus}
          compact={compactHeader}
          connectionTaskId={taskId}
          actions={aiViewToggle}
        />
      ) : isAiTask ? (
        // When the outer header is hidden (e.g., embedded layouts), render a
        // slim toggle bar so the user can still switch between Chat and Terminal.
        <div className="flex items-center justify-end border-b border-border bg-panel/60 px-3 py-1.5">
          {aiViewToggle}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {showTerminal ? (
          <TerminalView task={task} />
        ) : (
          <ChatView taskId={taskId} autoFocusComposer={hideHeader} />
        )}
      </div>
    </>
  );
}

interface AiTaskViewToggleProps {
  value: AiTaskViewMode;
  onChange: (next: AiTaskViewMode) => void;
  lockTerminalView?: boolean;
}

function AiTaskViewToggle({ value, onChange, lockTerminalView = false }: AiTaskViewToggleProps) {
  const baseBtn =
    'px-3 py-1 text-xs font-medium tracking-[0.04em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60';
  const activeBtn = 'bg-[var(--accent)]/15 text-[var(--accent)]';
  const inactiveBtn = 'text-muted hover:text-ink hover:bg-[var(--border)]/40';
  return (
    <div
      role="tablist"
      aria-label="AI task view"
      className="inline-flex items-center overflow-hidden rounded-full border border-border bg-panel/60"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'chat'}
        disabled={lockTerminalView}
        onClick={() => onChange('chat')}
        className={`${baseBtn} ${value === 'chat' ? activeBtn : inactiveBtn} ${lockTerminalView ? 'cursor-not-allowed opacity-45' : ''}`}
        title={lockTerminalView ? 'Terminal mode owns this AI session' : undefined}
      >
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'terminal'}
        onClick={() => onChange('terminal')}
        className={`${baseBtn} ${value === 'terminal' ? activeBtn : inactiveBtn}`}
        title="Open the AI session in an interactive terminal"
      >
        Terminal
      </button>
    </div>
  );
}
