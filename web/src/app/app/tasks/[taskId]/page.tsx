'use client';

import { useParams, useRouter } from 'next/navigation';
import { TaskDetailPane } from '@/features/tasks';

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.taskId as string;

  return (
    <TaskDetailPane
      taskId={taskId}
      showBack
      onBack={() => router.push('/app/tasks')}
      showConnectionStatus
    />
  );
}
