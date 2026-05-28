'use client';

import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { ChatView } from '@/features/chat';
import { TerminalView } from '@/features/terminal';
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

export function TaskDetailPane({
  taskId,
  showBack = false,
  onBack,
  compactHeader = false,
  showConnectionStatus = false,
  hideHeader = false,
}: TaskDetailPaneProps) {
  const { tasks, fetchTask, markTaskRead } = useTasksStore();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const task = tasks.find((item) => item.id === taskId);
  const taskExistsRef = useRef(false);
  taskExistsRef.current = Boolean(task);

  useEffect(() => {
    let cancelled = false;

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    markTaskRead(taskId);
    const shouldBlock = !taskExistsRef.current;
    if (shouldBlock) {
      setPendingTaskId(taskId);
    }

    void fetchTask(taskId).finally(() => {
      if (!cancelled && shouldBlock) {
        setPendingTaskId((current) => (current === taskId ? null : current));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fetchTask, markTaskRead, taskId]);

  if (!task && pendingTaskId === taskId) {
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
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {task.taskType === 'pty_task' ? (
          <TerminalView task={task} />
        ) : (
          <ChatView taskId={taskId} autoFocusComposer={hideHeader} />
        )}
      </div>
    </>
  );
}
