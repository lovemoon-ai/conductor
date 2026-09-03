'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getApiClient } from '@/shared/api/client';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { useAgentsStore } from '@/features/agents';
import {
  RESUME_SESSION_BACKENDS,
  defaultResumeTaskTitle,
  formatRelativeTime,
  getPathTail,
  getSessionsErrorMessage,
  isSessionActive,
  normalizeDaemonSession,
  sessionDisplayTitle,
  sortSessionsForDisplay,
  type DaemonSessionSummary,
  type DaemonSessionsBackendError,
} from '../utils/resume-sessions';
import { getCreateTaskErrorMessage } from './CreateTaskDialog';

interface ResumeSessionPanelProps {
  onClose: () => void;
  onCreatedTask?: (taskId: string) => void;
}

const sessionKey = (session: DaemonSessionSummary): string =>
  `${session.backend}:${session.sessionId}`;

/**
 * "Resume a computer session" mode inside CreateTaskDialog: lists recent AI
 * backend sessions found on a daemon and creates a task that resumes one.
 */
export function ResumeSessionPanel({ onClose, onCreatedTask }: ResumeSessionPanelProps) {
  const { push } = useRouter();
  const createTask = useTasksStore((state) => state.createTask);
  const projects = useProjectsStore((state) => state.projects);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));

  const [requestedHost, setRequestedHost] = useState('');
  const [sessions, setSessions] = useState<DaemonSessionSummary[] | null>(null);
  const [backendErrors, setBackendErrors] = useState<DaemonSessionsBackendError[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [fallbackProjectId, setFallbackProjectId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Single online daemon ⇒ auto-selected; otherwise first daemon by default.
  const host = requestedHost && daemons.some((daemon) => daemon.host === requestedHost)
    ? requestedHost
    : (daemons[0]?.host ?? '');

  useEffect(() => {
    if (!host) {
      setSessions(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setSessions(null);
    setBackendErrors([]);
    setSelectedKey(null);
    getApiClient()
      .get<{ sessions?: unknown[]; errors?: DaemonSessionsBackendError[] }>(
        `/agents/${encodeURIComponent(host)}/sessions?backends=${RESUME_SESSION_BACKENDS.join(',')}&limit=30`,
      )
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.sessions) ? res.sessions : [];
        setSessions(
          sortSessionsForDisplay(
            list
              .map((entry) => normalizeDaemonSession(entry))
              .filter((entry): entry is DaemonSessionSummary => entry !== null),
          ),
        );
        setBackendErrors(Array.isArray(res?.errors) ? res.errors : []);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(getSessionsErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host, reloadToken]);

  const selectedSession = useMemo(
    () => sessions?.find((session) => sessionKey(session) === selectedKey) ?? null,
    [sessions, selectedKey],
  );
  const daemonProjects = useMemo(
    () => projects.filter((project) => project.daemonHost === host),
    [projects, host],
  );
  const needsProjectPick = Boolean(selectedSession) && !selectedSession?.projectId;
  const resolvedProjectId = selectedSession?.projectId
    ?? (daemonProjects.some((project) => project.id === fallbackProjectId) ? fallbackProjectId : '');
  const sessionProjectName = selectedSession?.projectId
    ? projects.find((project) => project.id === selectedSession.projectId)?.name ?? null
    : null;
  const now = Date.now();

  const handleSelectSession = (session: DaemonSessionSummary) => {
    if (session.linkedTaskId) {
      // Already resumed once — jump to the existing task instead of creating
      // a duplicate.
      onClose();
      push(`/app/tasks/${session.linkedTaskId}`);
      return;
    }
    const key = sessionKey(session);
    setSelectedKey((current) => (current === key ? null : key));
    setFallbackProjectId('');
    setInstruction('');
    setSubmitError(null);
  };

  const handleResume = async () => {
    if (!selectedSession || !resolvedProjectId || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const trimmedInstruction = instruction.trim();
      const task = await createTask({
        title: defaultResumeTaskTitle(selectedSession),
        projectId: resolvedProjectId,
        backendType: selectedSession.backend,
        agentHost: host,
        sessionId: selectedSession.sessionId,
        ...(selectedSession.sessionFilePath
          ? { sessionFilePath: selectedSession.sessionFilePath }
          : {}),
        ...(trimmedInstruction ? { initialContent: trimmedInstruction } : {}),
      });
      onClose();
      if (onCreatedTask) {
        onCreatedTask(task.id);
        return;
      }
      push(`/app/tasks/${task.id}`);
    } catch (error) {
      setSubmitError(getCreateTaskErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (daemons.length === 0) {
    return (
      <InlineNotice variant="warning" title="No daemon online">
        Connect conductor daemon on your computer first, then resume its AI sessions from here.
      </InlineNotice>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="resume-session-daemon" className="mb-2 block text-sm font-medium">Daemon</label>
        <select
          id="resume-session-daemon"
          value={host}
          onChange={(e) => setRequestedHost(e.target.value)}
          className="webapp-input w-full"
          disabled={daemons.length === 1}
        >
          {daemons.map((daemon) => (
            <option key={daemon.host} value={daemon.host}>
              {daemon.host}
            </option>
          ))}
        </select>
      </div>

      {backendErrors.length > 0 ? (
        <InlineNotice variant="warning">
          {backendErrors.map((entry) => `${entry.backend}: ${entry.message}`).join(' · ')}
        </InlineNotice>
      ) : null}

      {isLoading ? (
        <InlineNotice variant="info">Loading sessions from {host}…</InlineNotice>
      ) : loadError ? (
        <InlineNotice variant="error" title="Could not load sessions">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            className="ml-2 font-medium underline"
          >
            Retry
          </button>
        </InlineNotice>
      ) : sessions && sessions.length === 0 ? (
        <InlineNotice variant="info">
          No recent AI sessions found on this daemon.
        </InlineNotice>
      ) : sessions ? (
        <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1 webapp-scrollbar">
          {sessions.map((session) => {
            const key = sessionKey(session);
            const isSelected = key === selectedKey;
            const isLinked = Boolean(session.linkedTaskId);
            const relativeTime = formatRelativeTime(session.updatedAt, now);
            const cwdTail = getPathTail(session.cwd);
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleSelectSession(session)}
                title={isLinked ? 'Open the task already linked to this session' : undefined}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/8'
                    : 'border-border bg-paper/60 hover:border-accent/40 hover:bg-panel'
                } ${isLinked ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                    {session.backend}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {sessionDisplayTitle(session)}
                  </span>
                  {isSessionActive(session.updatedAt, now) ? (
                    <span
                      className="shrink-0 rounded-full bg-[var(--accent)]/12 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]"
                      title="This session may still be in use on your computer."
                    >
                      Active ⚡
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                  {cwdTail ? <span className="truncate">{cwdTail}</span> : null}
                  {relativeTime ? <span className="shrink-0">{relativeTime}</span> : null}
                  {isLinked ? (
                    <span className="shrink-0 rounded-full bg-border/50 px-2 py-0.5 text-[11px] font-medium">
                      Linked task
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {selectedSession ? (
        <div className="space-y-3 rounded-2xl border border-border bg-paper/50 p-4">
          {needsProjectPick ? (
            daemonProjects.length > 0 ? (
              <div>
                <label htmlFor="resume-session-project" className="mb-2 block text-sm font-medium">Project</label>
                <select
                  id="resume-session-project"
                  value={fallbackProjectId}
                  onChange={(e) => setFallbackProjectId(e.target.value)}
                  className="webapp-input w-full"
                >
                  <option value="">Select a project…</option>
                  {daemonProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <InlineNotice variant="warning">
                This session has no matching project, and this daemon has no bound project to
                attach it to. Bind a project on the daemon first.
              </InlineNotice>
            )
          ) : sessionProjectName ? (
            <p className="text-xs text-muted">Project: {sessionProjectName}</p>
          ) : null}

          <div>
            <label htmlFor="resume-session-instruction" className="mb-2 block text-sm font-medium">
              Follow-up instruction <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="resume-session-instruction"
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setSubmitError(null);
              }}
              rows={3}
              placeholder="Sent to the resumed session as the next message. Leave empty to just take it over."
              className="webapp-input w-full resize-y"
            />
          </div>

          {submitError ? (
            <InlineNotice variant="error" title="Resume failed">
              {submitError}
            </InlineNotice>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleResume}
              disabled={!resolvedProjectId || isSubmitting}
              className="webapp-btn-primary px-5 py-2.5 text-sm"
            >
              {isSubmitting ? 'Resuming...' : 'Resume Session'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
