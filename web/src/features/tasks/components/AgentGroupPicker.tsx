'use client';

import { useEffect, useState } from 'react';
import { InlineNotice } from '@/components/common/InlineNotice';
import { getApiClient } from '@/shared/api/client';
import type { CreateTaskInput } from '@/shared/types';

// RFC 0033: a reviewer row in the multi-agent selector. `backend === ''` means
// "inherit the worker's backend".
export interface ReviewerRow {
  name: string;
  backend: string;
}

export interface AgentRegistryOption {
  name: string;
  description: string | null;
  backend: string | null;
}

/** Cap mirrors MAX_AGENTS_PER_TASK on the server (1 worker + up to 7 reviewers). */
export const MAX_REVIEWER_ROWS = 7;

export interface AgentGroupSelection {
  workerAgent: string;
  reviewers: ReviewerRow[];
}

export type AgentGroupAction =
  | { type: 'set-worker-agent'; workerAgent: string }
  | { type: 'add-reviewer' }
  | { type: 'remove-reviewer'; index: number }
  | { type: 'set-reviewer-name'; index: number; name: string }
  | { type: 'set-reviewer-backend'; index: number; backend: string }
  | { type: 'reconcile-agent-registry'; names: string[] };

export function reduceAgentGroup<S extends AgentGroupSelection>(state: S, action: AgentGroupAction): S {
  switch (action.type) {
    case 'set-worker-agent':
      return {
        ...state,
        workerAgent: action.workerAgent,
        reviewers: state.reviewers.map((row) =>
          row.name === action.workerAgent ? { ...row, name: '' } : row,
        ),
      };
    case 'add-reviewer':
      if (state.reviewers.length >= MAX_REVIEWER_ROWS) return state;
      return { ...state, reviewers: [...state.reviewers, { name: '', backend: '' }] };
    case 'remove-reviewer':
      return { ...state, reviewers: state.reviewers.filter((_, i) => i !== action.index) };
    case 'set-reviewer-name':
      return {
        ...state,
        reviewers: state.reviewers.map((row, i) =>
          i === action.index ? { ...row, name: action.name } : row,
        ),
      };
    case 'set-reviewer-backend':
      return {
        ...state,
        reviewers: state.reviewers.map((row, i) =>
          i === action.index ? { ...row, backend: action.backend } : row,
        ),
      };
    case 'reconcile-agent-registry': {
      const availableNames = new Set(action.names);
      if (!state.workerAgent || !availableNames.has(state.workerAgent)) {
        return { ...state, workerAgent: '', reviewers: [] };
      }
      const selectedNames = new Set([state.workerAgent]);
      return {
        ...state,
        reviewers: state.reviewers.map((row) => {
          if (
            !row.name ||
            !availableNames.has(row.name) ||
            selectedNames.has(row.name)
          ) {
            return row.name ? { ...row, name: '' } : row;
          }
          selectedNames.add(row.name);
          return row;
        }),
      };
    }
    default:
      return state;
  }
}

/**
 * The request `agents` field: agents[0] is the worker, the rest are reviewers.
 * Undefined when no worker is named (reviewer inputs are hidden until then), so
 * clearing the worker drops the whole group and falls back to a plain task.
 */
export function buildAgentGroupRequest({
  workerAgent,
  reviewers,
}: AgentGroupSelection): CreateTaskInput['agents'] {
  const trimmedWorkerAgent = workerAgent.trim();
  if (!trimmedWorkerAgent) return undefined;
  return [
    { name: trimmedWorkerAgent },
    ...reviewers
      .map((row) => ({ name: row.name.trim(), backend: row.backend.trim() }))
      .filter((row) => row.name)
      .map((row) => ({ name: row.name, backend: row.backend || null })),
  ];
}

/**
 * Load the agents registered in a project's .conductor/settings.yaml (pass
 * `null` to skip). A successful load reconciles the current selection against
 * the registry. Fail-soft: any error just leaves the list empty; a failed fetch
 * is not evidence that saved worker/reviewer names are invalid.
 */
export function useProjectAgentRegistry(
  projectId: string | null,
  dispatch: (action: AgentGroupAction) => void,
) {
  // Keyed by project so a stale response never shows for another project and
  // "loading" is derived instead of set synchronously inside the effect.
  const [registry, setRegistry] = useState<{
    projectId: string;
    agents: AgentRegistryOption[];
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getApiClient()
      .get<{ agents: AgentRegistryOption[] }>(`/projects/${projectId}/agents`)
      .then((res) => {
        if (cancelled) return;
        const nextAgents = Array.isArray(res?.agents) ? res.agents : [];
        setRegistry({ projectId, agents: nextAgents, failed: false });
        dispatch({
          type: 'reconcile-agent-registry',
          names: nextAgents.map((agent) => agent.name),
        });
      })
      .catch(() => {
        if (!cancelled) setRegistry({ projectId, agents: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, dispatch]);

  const current = projectId && registry?.projectId === projectId ? registry : null;
  const availableAgents = current?.agents ?? [];
  const isLoadingAgents = Boolean(projectId) && !current;
  const agentsLoadFailed = current?.failed ?? false;
  return { availableAgents, isLoadingAgents, agentsLoadFailed };
}

/** Worker agent select plus reviewer rows (each with an optional backend). */
export function AgentGroupPicker({
  id,
  availableAgents,
  isLoadingAgents,
  agentsLoadFailed,
  availableBackends,
  workerAgent,
  reviewers,
  dispatch,
  onSelectBackend,
  disabled = false,
}: AgentGroupSelection & {
  /** DOM id of the worker select, for an external `<label htmlFor>`. */
  id: string;
  availableAgents: AgentRegistryOption[];
  isLoadingAgents: boolean;
  agentsLoadFailed: boolean;
  availableBackends: string[];
  dispatch: (action: AgentGroupAction) => void;
  /** Called with the worker's registry default backend when the daemon advertises it. */
  onSelectBackend: (backend: string) => void;
  disabled?: boolean;
}) {
  if (isLoadingAgents) {
    return <InlineNotice variant="info">Loading registered agents…</InlineNotice>;
  }
  if (agentsLoadFailed) {
    return (
      <InlineNotice variant="error">
        Could not load this project&apos;s agent registry. Check that its daemon is
        online, then reopen the dialog.
      </InlineNotice>
    );
  }
  if (availableAgents.length === 0) {
    return (
      <InlineNotice variant="info">
        No agents registered for this project. Add an <code>agents:</code> block to
        <code> .conductor/settings.yaml</code> to enable worker/reviewer agents.
      </InlineNotice>
    );
  }
  return (
    <>
      <select
        id={id}
        value={workerAgent}
        onChange={(e) => {
          const nextWorkerAgent = e.target.value;
          dispatch({ type: 'set-worker-agent', workerAgent: nextWorkerAgent });
          const agentDefaultBackend = availableAgents.find(
            (agent) => agent.name === nextWorkerAgent,
          )?.backend;
          if (agentDefaultBackend && availableBackends.includes(agentDefaultBackend)) {
            onSelectBackend(agentDefaultBackend);
          }
        }}
        className="webapp-input w-full"
        aria-label="Worker agent"
        disabled={disabled}
      >
        <option value="">None (plain task)</option>
        {availableAgents.map((agent) => (
          <option key={agent.name} value={agent.name}>
            {agent.description ? `${agent.name} — ${agent.description}` : agent.name}
          </option>
        ))}
      </select>

      {workerAgent.trim() ? (
        <div className="mt-3 space-y-2">
          {reviewers.map((row, index) => {
            const selectedElsewhere = new Set(
              reviewers
                .filter((_, reviewerIndex) => reviewerIndex !== index)
                .map((reviewer) => reviewer.name)
                .filter(Boolean),
            );
            const selectedAgent = availableAgents.find(
              (agent) => agent.name === row.name,
            );
            return (
              <div key={index} className="flex items-center gap-2">
                <select
                  value={row.name}
                  onChange={(e) =>
                    dispatch({ type: 'set-reviewer-name', index, name: e.target.value })
                  }
                  className="webapp-input flex-1"
                  aria-label={`Reviewer ${index + 1} agent`}
                  disabled={disabled}
                >
                  <option value="">Select reviewer agent…</option>
                  {availableAgents
                    .filter(
                      (agent) =>
                        agent.name !== workerAgent &&
                        (!selectedElsewhere.has(agent.name) || agent.name === row.name),
                    )
                    .map((agent) => (
                      <option key={agent.name} value={agent.name}>
                        {agent.description
                          ? `${agent.name} — ${agent.description}`
                          : agent.name}
                      </option>
                    ))}
                </select>
                <select
                  value={row.backend}
                  onChange={(e) =>
                    dispatch({ type: 'set-reviewer-backend', index, backend: e.target.value })
                  }
                  className="webapp-input w-40"
                  aria-label={`Reviewer ${index + 1} backend`}
                  disabled={disabled}
                >
                  <option value="">
                    {selectedAgent?.backend
                      ? `agent default (${selectedAgent.backend})`
                      : 'inherit worker backend'}
                  </option>
                  {availableBackends.map((backend) => (
                    <option key={backend} value={backend}>
                      {backend}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'remove-reviewer', index })}
                  className="rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--border)]/50"
                  aria-label={`Remove reviewer ${index + 1}`}
                  disabled={disabled}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {reviewers.length < MAX_REVIEWER_ROWS &&
            reviewers.every((row) => row.name) &&
            reviewers.length + 1 < availableAgents.length ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'add-reviewer' })}
              className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--border)]/50"
              disabled={disabled}
            >
              + Add reviewer
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
