'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import {
  ACHIEVED_TASKS_PATH,
  AchievedTaskManager,
} from '@/features/achieved-tasks';
import { SETTINGS_ROOT_PATH, useSettingsNavStore } from '@/features/settings';

export default function AchievedTasksPage() {
  const { push } = useRouter();
  const setLastSettingsPath = useSettingsNavStore((state) => state.setLastPath);

  useEffect(() => {
    setLastSettingsPath(ACHIEVED_TASKS_PATH);
  }, [setLastSettingsPath]);

  return (
    <>
      <Header
        title="Achieved tasks"
        compact
        showBack
        onBack={() => push(SETTINGS_ROOT_PATH)}
      />
      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <AchievedTaskManager />
      </div>
    </>
  );
}
