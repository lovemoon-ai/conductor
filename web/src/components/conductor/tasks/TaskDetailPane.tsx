'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/conductor/layout/Header';
import { ChatView } from '@/components/conductor/chat/ChatView';
import { TerminalView } from '@/components/conductor/terminal/TerminalView';
import { LoadingSpinner } from '@/components/conductor/common/LoadingSpinner';
import { useTasksStore } from '@/lib/conductor/stores/tasks';

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
  const [isLoading, setIsLoading] = useState(true);
  const task = tasks.find((item) => item.id === taskId);

  useEffect(() => {
    let cancelled = false;

    const loadTask = async () => {
      setIsLoading(true);
      await fetchTask(taskId);
      if (!cancelled) {
        setIsLoading(false);
      }
    };

    if (taskId) {
      void loadTask();
    } else {
      setIsLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [fetchTask, taskId]);

  useEffect(() => {
    if (taskId) {
      markTaskRead(taskId);
    }
  }, [markTaskRead, taskId]);

  if (isLoading) {
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
          <ChatView taskId={taskId} />
        )}
      </div>
    </>
  );
}
