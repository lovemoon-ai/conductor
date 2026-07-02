'use client';

import { Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { TaskDetailPane } from '@/features/tasks';
import { useTasksStore } from '@/features/tasks/store';
import { useProjectsStore } from '@/features/projects';
import { normalizeTaskListReturnHref } from '@/features/tasks/utils/task-navigation';

const buildTaskListHref = (projectId?: string | null) => {
  const normalizedProjectId = projectId?.trim();
  if (!normalizedProjectId) {
    return '/app/tasks';
  }
  return `/app/tasks?projectId=${encodeURIComponent(normalizedProjectId)}`;
};

export default function TaskDetailPage() {
  const params = useParams();
  const { push } = useRouter();
  const searchParams = useSearchParams();
  const taskId = params.taskId as string;
  const task = useTasksStore((state) => state.tasks.find((item) => item.id === taskId));
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const backProjectId = task?.projectId || selectedProjectId;
  const returnHref = normalizeTaskListReturnHref(searchParams.get('from')) ?? buildTaskListHref(backProjectId);

  return (
    <Suspense fallback={null}>
      <TaskDetailPane
        taskId={taskId}
        showBack
        onBack={() => push(returnHref)}
        showConnectionStatus
      />
    </Suspense>
  );
}
