'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/conductor/layout/Header';
import { ChatView } from '@/components/conductor/chat/ChatView';
import { TerminalView } from '@/components/conductor/terminal/TerminalView';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { LoadingSpinner } from '@/components/conductor/common/LoadingSpinner';

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.taskId as string;

  const { tasks, fetchTask, markTaskRead } = useTasksStore();
  const [isLoading, setIsLoading] = useState(true);

  const task = tasks.find((t) => t.id === taskId);

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
  }, [taskId, markTaskRead]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!task) {
    return (
      <>
        <Header
          title="Task Not Found"
          showBack
          onBack={() => router.push('/app/tasks')}
        />
        <div className="flex-1 flex items-center justify-center text-muted">
          <p>This task does not exist or has been deleted.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title={task.title}
        showBack
        onBack={() => router.push('/app/tasks')}
        showConnectionStatus={task.taskType !== 'pty_task'}
      />
      <div className="flex-1 overflow-hidden">
        {task.taskType === 'pty_task' ? (
          <TerminalView task={task} />
        ) : (
          <ChatView taskId={taskId} />
        )}
      </div>
    </>
  );
}
