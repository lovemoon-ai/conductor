'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/features/auth';
import { useWebSocket } from '@/features/realtime';
import { useAuthStorageSync } from '@/features/auth';
import { useProjectsStore } from '@/features/projects';
import { useAgentsStore } from '@/features/agents';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileNav } from '@/components/layout/MobileNav';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'conductor-sidebar-collapsed';

export default function WebAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const session = useAuthStore((state) => state.session);
  const initFromStorage = useAuthStore((state) => state.initFromStorage);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);
  const startAgentsPolling = useAgentsStore((state) => state.startPolling);
  const stopAgentsPolling = useAgentsStore((state) => state.stopPolling);

  const pathSegments = pathname.split('/').filter(Boolean);
  const isTaskChatPage =
    pathSegments.length === 3 &&
    pathSegments[0] === 'app' &&
    pathSegments[1] === 'tasks';

  // Initialize WebSocket connection
  useWebSocket();
  useAuthStorageSync(initFromStorage);

  // Initialize auth from localStorage on mount
  useEffect(() => {
    initFromStorage().finally(() => setIsInitializing(false));
  }, [initFromStorage]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    setIsSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, isSidebarCollapsed ? '1' : '0');
  }, [isSidebarCollapsed]);

  useEffect(() => {
    // Wait for initialization to complete
    if (isInitializing) return;

    // Check auth after initialization
    if (!session) {
      stopAgentsPolling();
      router.replace('/login');
      return;
    }

    // Fetch initial data
    fetchProjects();
    fetchAgents();
  }, [isInitializing, session, router, fetchProjects, fetchAgents, stopAgentsPolling]);

  useEffect(() => {
    if (isInitializing || !session) {
      stopAgentsPolling();
      return;
    }

    startAgentsPolling();
    return () => {
      stopAgentsPolling();
    };
  }, [isInitializing, session, startAgentsPolling, stopAgentsPolling]);

  // Show loading while initializing or checking auth
  if (isInitializing || !session) {
    return (
      <div className="h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Desktop Sidebar */}
        <div className="hidden md:block">
          <Sidebar
            collapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed((prev) => !prev)}
          />
        </div>

        {/* Main Content */}
        <main
          className={`flex-1 flex flex-col overflow-hidden ${
            isTaskChatPage ? 'pb-0' : 'pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0'
          }`}
        >
          {children}
        </main>

        {/* Mobile Navigation */}
        {!isTaskChatPage && <MobileNav />}
      </div>
    </div>
  );
}
