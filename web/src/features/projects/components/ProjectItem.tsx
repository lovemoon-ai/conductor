'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SyntheticEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project } from '@/shared/types';
import { copyToClipboard } from '@/lib/clipboard';
import { useProjectsStore } from '../store';
import { useAgentsStore } from '@/features/agents';
import { useSwipeActions } from '@/shared/hooks/useSwipeActions';
import { formatBindingLabel } from '../utils/format-binding-label';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';

interface ProjectItemProps {
  project: Project;
  /**
   * All members of the merged project group this card represents. Defaults to
   * `[project]` for single-member groups. When > 1, the card displays a
   * daemon badge for each member and primary actions (hide/delete) fan out to
   * all members via the corresponding *_Group store actions.
   */
  mergedMembers?: Project[];
  isSelected?: boolean;
  isHidden?: boolean;
  onSelect?: (projectId: string) => void;
  onHide?: (projectId: string) => void;
  onUnhide?: (projectId: string) => void;
  /**
   * Optional sortable id override. ProjectList passes the merged group's
   * `key` so dnd-kit treats the whole group as a single draggable. Defaults
   * to `project.id` for backward compatibility.
   */
  sortableId?: string;
  dragDisabled?: boolean;
}

const ACTIONS_WIDTH = 72;
type SortableActivatorName = 'onPointerDown' | 'onMouseDown' | 'onTouchStart' | 'onKeyDown';
type SortableActivatorListeners = Partial<Record<SortableActivatorName, (event: SyntheticEvent) => void>>;

const TrashIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const HideIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c1.461 0 2.855-.296 4.122-.831M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l12.544 12.544M9.88 9.88a3 3 0 104.24 4.24" />
  </svg>
);

const ShowIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.43 0 .637C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const InviteIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 14v4m2-2h-4M15 8a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0" />
  </svg>
);

const LeaveIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6A2.25 2.25 0 005.25 5.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h11.25" />
  </svg>
);

// Heroicons "link" — used when the card represents an unmerged project that
// has a same-name peer on another daemon, so clicking the button fuses them.
const MergeIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  </svg>
);

// Heroicons "link-slash" — used when the card is a merged cross-daemon group
// and clicking the button breaks it back into individual daemon cards.
const SplitIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.181 8.68a4.503 4.503 0 011.903 6.405m-9.768-2.782L3.56 14.06a4.5 4.5 0 006.364 6.364l1.757-1.757m4.682-4.682l4.5-4.5a4.5 4.5 0 00-6.364-6.364l-1.757 1.757M3 3l18 18" />
  </svg>
);

const stopEventPropagation = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

const readBindingCandidate = (
  metadata: Record<string, unknown> | null | undefined,
): { daemonHost: string; workspacePath: string } | null => {
  if (!metadata) {
    return null;
  }

  const rawCandidate =
    Object.prototype.hasOwnProperty.call(metadata, 'bindingCandidate')
      ? metadata.bindingCandidate
      : Object.prototype.hasOwnProperty.call(metadata, 'binding_candidate')
        ? metadata.binding_candidate
        : null;
  if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) {
    return null;
  }

  const candidate = rawCandidate as Record<string, unknown>;
  const daemonHost =
    typeof candidate.daemonHost === 'string'
      ? candidate.daemonHost.trim()
      : typeof candidate.daemon_host === 'string'
        ? candidate.daemon_host.trim()
        : '';
  const workspacePath =
    typeof candidate.workspacePath === 'string'
      ? candidate.workspacePath.trim()
      : typeof candidate.workspace_path === 'string'
        ? candidate.workspace_path.trim()
        : '';
  if (!daemonHost || !workspacePath) {
    return null;
  }

  return { daemonHost, workspacePath };
};

export function ProjectItem({
  project,
  mergedMembers,
  isSelected = false,
  isHidden = false,
  onSelect,
  onHide,
  onUnhide,
  sortableId,
  dragDisabled = false,
}: ProjectItemProps) {
  const groupMembers = mergedMembers && mergedMembers.length > 0 ? mergedMembers : [project];
  const isMergedGroup = groupMembers.length > 1;
  const [isEditing, setIsEditing] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartXRef = useRef(0);
  const longPressStartYRef = useRef(0);
  const longPressFiredRef = useRef(false);
  const renamingRef = useRef(false);
  const skipRenameOnBlurRef = useRef(false);

  const {
    updateProject,
    deleteProject,
    deleteProjectGroup,
    hideProjectGroup,
    unhideProjectGroup,
    startProjectCollaboration,
    leaveCollaboration,
    setProjectMergeOptOut,
  } = useProjectsStore();
  const allProjects = useProjectsStore((state) => state.projects);
  const agents = useAgentsStore((state) => state.agents);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();

  const projectRecord = project as Project & Record<string, unknown>;
  const isDefault = Boolean(projectRecord.isDefault);
  // `icon` is sourced from `.conductor/settings.yaml`. The server resolves
  // filesystem paths to `data:` URIs server-side, so by the time we get here
  // an "image" icon always starts with `http(s)://`, `data:`, or `/`. Anything
  // else (emoji, short text) is rendered as inline text. Empty/whitespace is
  // treated as unset so we fall through to the default folder SVG.
  const customIconRaw = typeof projectRecord.icon === 'string' ? projectRecord.icon.trim() : '';
  const customIcon = customIconRaw || null;
  const isImageIcon = customIcon ? /^(https?:\/\/|data:|\/)/i.test(customIcon) : false;
  const daemonHost = typeof projectRecord.daemonHost === 'string' ? projectRecord.daemonHost : null;
  const workspacePath = typeof projectRecord.workspacePath === 'string' ? projectRecord.workspacePath : null;
  const repoRoot = typeof projectRecord.repoRoot === 'string' ? projectRecord.repoRoot : null;
  const metadata = projectRecord.metadata && typeof projectRecord.metadata === 'object' && !Array.isArray(projectRecord.metadata)
    ? (projectRecord.metadata as Record<string, unknown>)
    : null;
  const isGitProject = Boolean(repoRoot);
  const bindingCandidate = readBindingCandidate(metadata);
  const isBoundProject = Boolean(daemonHost) && !isDefault;
  const isPendingBinding = !isDefault && !daemonHost && Boolean(bindingCandidate);
  const isDaemonOnline = !daemonHost || agents.some((agent) => agent.host === daemonHost);
  const isUnavailable = isBoundProject && !isDaemonOnline;
  const pendingBindingLabel = bindingCandidate
    ? formatBindingLabel(bindingCandidate.daemonHost, bindingCandidate.workspacePath)
    : null;
  const daemonLabel = daemonHost?.trim() || bindingCandidate?.daemonHost || null;
  const daemonTitle = daemonHost?.trim()
    ? formatBindingLabel(daemonHost, workspacePath)
    : pendingBindingLabel;
  const taskStatusCounts = projectRecord.taskStatusCounts as Record<string, number> | undefined;
  // For merged groups sum task counts across every daemon's underlying project
  // so a single chip captures the full picture.
  const aggregatedRunningCount = groupMembers.reduce(
    (sum, member) => sum + (member.taskStatusCounts?.running ?? 0),
    0,
  );
  const aggregatedKilledCount = groupMembers.reduce(
    (sum, member) => sum + (member.taskStatusCounts?.killed ?? 0),
    0,
  );
  const runningCount = isMergedGroup ? aggregatedRunningCount : taskStatusCounts?.running ?? 0;
  const killedCount = isMergedGroup ? aggregatedKilledCount : taskStatusCounts?.killed ?? 0;
  const collaboration = project.collaboration ?? null;
  const collaborationMemberCount = collaboration?.memberCount ?? collaboration?.members.length ?? 0;
  const hasCollaboration = Boolean(collaboration);
  const hasMetadataChips = isGitProject || Boolean(daemonLabel) || isUnavailable || isPendingBinding || hasCollaboration || runningCount > 0 || killedCount > 0;
  const projectTitleId = `project-title-${project.id}`;
  const [isCollaborationBusy, setIsCollaborationBusy] = useState(false);
  const canInvite = !isDefault;
  const canLeaveCollaboration = Boolean(collaboration && collaborationMemberCount > 1);
  const canHide = Boolean(onHide) && !isHidden;
  const canUnhide = Boolean(onUnhide) && isHidden;
  const canDelete = !isDefault;
  // Find every project on a different daemon that shares this project's name.
  // The cross-daemon merge predicate `canMergeProjects` keys off
  // (same name, distinct non-empty daemonHost, neither side opted out), so
  // surfacing the manual toggle only when at least one such peer exists
  // matches what the user actually sees on the list. Projects with no peers
  // simply hide the button — no need to confuse single-daemon installs.
  const sameNameOtherDaemonPeers = useMemo(() => {
    const thisName = project.name;
    const thisHost = (daemonHost ?? '').trim();
    if (!thisName || !thisHost) return [] as Project[];
    return allProjects.filter((candidate) => {
      if (candidate.id === project.id) return false;
      if (candidate.name !== thisName) return false;
      const peerHost = (candidate.daemonHost ?? '').trim();
      return Boolean(peerHost) && peerHost !== thisHost;
    });
  }, [allProjects, daemonHost, project.id, project.name]);
  const canSplitMerge = isMergedGroup;
  const canRequestMerge = !isMergedGroup && sameNameOtherDaemonPeers.length > 0;
  // Default projects are not eligible — they have no daemon binding and never
  // merge by definition (their `daemonHost` is null).
  const showMergeToggle = !isDefault && (canSplitMerge || canRequestMerge);
  const [isMergeBusy, setIsMergeBusy] = useState(false);
  const swipeActionsWidth =
    (canInvite ? ACTIONS_WIDTH : 0)
    + (canLeaveCollaboration ? ACTIONS_WIDTH : 0)
    + (showMergeToggle ? ACTIONS_WIDTH : 0)
    + (canHide || canUnhide ? ACTIONS_WIDTH : 0)
    + (canDelete ? ACTIONS_WIDTH : 0);
  const swipe = useSwipeActions({
    maxOffset: swipeActionsWidth,
  });

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const selectProject = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (isEditing) {
      return;
    }
    onSelect?.(project.id);
  };

  const openProjectDetails = () => {
    if (isEditing) {
      return;
    }
    // Details show metadata only (incl. the memo timeline), so a pending or
    // offline daemon should not block opening the dialog — the toasts that
    // previously gated the tasks navigation are intentionally dropped.
    setIsDetailsOpen(true);
  };

  const handleRename = async () => {
    if (skipRenameOnBlurRef.current) {
      skipRenameOnBlurRef.current = false;
      return;
    }
    if (renamingRef.current) {
      return;
    }
    const nextName = editName.trim();
    if (!nextName) {
      setEditName(project.name);
      setIsEditing(false);
      return;
    }

    renamingRef.current = true;
    if (nextName !== project.name) {
      try {
        await updateProject(project.id, { name: nextName });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename project';
        pushToast({
          title: 'Failed to rename project',
          description: message,
          variant: 'error',
        });
        renamingRef.current = false;
        return;
      }
    }
    setIsEditing(false);
    renamingRef.current = false;
    swipe.closeActions();
  };

  const handleCancelRename = () => {
    skipRenameOnBlurRef.current = true;
    setEditName(project.name);
    setIsEditing(false);
    swipe.closeActions();
  };

  const handleTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    if (isDefault || isEditing) {
      return;
    }
    e.stopPropagation();
    clearLongPress();
    longPressStartXRef.current = e.clientX;
    longPressStartYRef.current = e.clientY;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      skipRenameOnBlurRef.current = false;
      setEditName(project.name);
      setIsEditing(true);
      swipe.closeActions();
    }, 500);
  }, [clearLongPress, isDefault, isEditing, project.name, swipe]);

  const handleTitlePointerUp = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const clearLongPressAfterMove = useCallback((clientX: number, clientY: number) => {
    if (!longPressTimerRef.current) {
      return;
    }
    const dx = clientX - longPressStartXRef.current;
    const dy = clientY - longPressStartYRef.current;
    if (dx * dx + dy * dy > 100) {
      clearLongPress();
    }
  }, [clearLongPress]);

  const handleTitlePointerMove = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    clearLongPressAfterMove(e.clientX, e.clientY);
  }, [clearLongPressAfterMove]);

  const handleCardPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPressAfterMove(e.clientX, e.clientY);
    swipe.onPointerMove(e);
  }, [clearLongPressAfterMove, swipe]);

  const handleCardPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    swipe.onPointerUp(e);
  }, [clearLongPress, swipe]);

  const handleCardPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    swipe.onPointerCancel(e);
  }, [clearLongPress, swipe]);

  const handleDelete = async () => {
    if (isDefault) {
      pushToast({
        title: 'Cannot delete the default project',
        variant: 'warning',
      });
      return;
    }
    const memberIds = groupMembers.map((member) => member.id);
    const memberCount = memberIds.length;
    const accepted = await confirm({
      title: isMergedGroup
        ? `Delete merged project "${project.name}" on ${memberCount} daemons?`
        : `Delete project "${project.name}"?`,
      description: isMergedGroup
        ? 'This deletes the project from every daemon it is bound to. This action cannot be undone.'
        : 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (accepted) {
      try {
        if (isMergedGroup) {
          await deleteProjectGroup(memberIds);
        } else {
          await deleteProject(project.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete project';
        pushToast({
          title: 'Failed to delete project',
          description: message,
          variant: 'error',
        });
      }
    }
    swipe.closeActions();
  };

  const handleHide = () => {
    if (isEditing || !canHide) {
      return;
    }
    if (isMergedGroup) {
      hideProjectGroup(groupMembers.map((member) => member.id));
    } else {
      onHide?.(project.id);
    }
    pushToast({
      title: isMergedGroup ? 'Merged project hidden across daemons' : 'Project hidden',
      description: 'Double-click Projects to show hidden projects.',
    });
    swipe.closeActions();
  };

  const handleUnhide = () => {
    if (isEditing || !canUnhide) {
      return;
    }
    if (isMergedGroup) {
      unhideProjectGroup(groupMembers.map((member) => member.id));
    } else {
      onUnhide?.(project.id);
    }
    pushToast({
      title: isMergedGroup ? 'Merged project restored' : 'Project restored',
    });
    swipe.closeActions();
  };

  const handleToggleMerge = async () => {
    if (isMergeBusy) {
      return;
    }
    setIsMergeBusy(true);
    try {
      if (canSplitMerge) {
        // Opt out every member of the merged group at once. A single-side
        // opt-out would leave a 3+ member group as "1 standalone + (N-1)
        // still merged", which surprises users who expect "Split" to fully
        // separate the daemons. Two-member groups (the common case) split
        // cleanly either way.
        await Promise.all(
          groupMembers.map((member) => setProjectMergeOptOut(member.id, true)),
        );
        pushToast({
          title: 'Project split across daemons',
          description: 'Each daemon now shows its own card.',
        });
      } else if (canRequestMerge) {
        // Clear opt-out on this project AND every same-name peer so the
        // merge predicate fuses them regardless of which side had been
        // opted out previously.
        await Promise.all([
          setProjectMergeOptOut(project.id, false),
          ...sameNameOtherDaemonPeers.map((peer) =>
            setProjectMergeOptOut(peer.id, false),
          ),
        ]);
        pushToast({
          title: 'Same-name projects merged',
          description: 'They now show as one card with multiple daemons.',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update merge state';
      pushToast({
        title: 'Failed to update merge state',
        description: message,
        variant: 'error',
      });
    } finally {
      setIsMergeBusy(false);
      swipe.closeActions();
    }
  };

  const copyInviteLink = async (
    target: { inviteUrl?: string; inviteToken: string },
  ): Promise<{ inviteUrl: string | null; copied: boolean }> => {
    if (typeof window === 'undefined') {
      return { inviteUrl: null, copied: false };
    }
    // Prefer the URL the server constructed from the request origin so reverse
    // proxies / different API hosts stay consistent; fall back to building it
    // locally from window.location.origin if the API didn't include one.
    const inviteUrl = target.inviteUrl?.trim()
      || `${window.location.origin}/app/invite/${encodeURIComponent(target.inviteToken)}`;
    return { inviteUrl, copied: await copyToClipboard(inviteUrl) };
  };

  const handleInvite = async (event: SyntheticEvent) => {
    stopEventPropagation(event);
    if (isCollaborationBusy) {
      return;
    }
    setIsCollaborationBusy(true);
    try {
      const nextCollaboration = collaboration ?? await startProjectCollaboration(project.id);
      const { inviteUrl, copied } = await copyInviteLink(nextCollaboration);
      pushToast(copied
        ? {
          title: 'Invite link copied',
          description: `${nextCollaboration.memberCount}/${nextCollaboration.maxMembers} members joined.`,
          variant: 'success',
        }
        : {
          // The link exists either way; surface it so the user can copy manually.
          title: 'Invite link created',
          description: inviteUrl ?? 'Open the project to copy the invite link.',
          variant: 'success',
        });
    } catch (error) {
      pushToast({
        title: 'Failed to create invite link',
        description: error instanceof Error ? error.message : 'Try again later.',
        variant: 'error',
      });
    } finally {
      setIsCollaborationBusy(false);
      swipe.closeActions();
    }
  };

  const handleLeaveCollaboration = async (event: SyntheticEvent) => {
    stopEventPropagation(event);
    if (!collaboration || isCollaborationBusy) {
      return;
    }
    const accepted = await confirm({
      title: 'Leave collaboration?',
      description: 'This project will stop sharing its issue board with the other members.',
      confirmLabel: 'Leave',
      tone: 'danger',
    });
    if (!accepted) {
      return;
    }
    setIsCollaborationBusy(true);
    try {
      await leaveCollaboration(collaboration.id);
      pushToast({
        title: 'Left collaboration',
        variant: 'success',
      });
    } catch (error) {
      pushToast({
        title: 'Failed to leave collaboration',
        description: error instanceof Error ? error.message : 'Try again later.',
        variant: 'error',
      });
    } finally {
      setIsCollaborationBusy(false);
      swipe.closeActions();
    }
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId ?? project.id,
    disabled: dragDisabled,
  });

  const forwardSortableActivator = useCallback((name: SortableActivatorName, e: SyntheticEvent) => {
    (listeners as SortableActivatorListeners | undefined)?.[name]?.(e);
  }, [listeners]);

  const handleCardPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    swipe.onPointerDown(e);
  }, [swipe]);

  const handleDragHandlePointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    forwardSortableActivator('onPointerDown', e);
  }, [forwardSortableActivator]);

  const handleDragHandleMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    e.stopPropagation();
    forwardSortableActivator('onMouseDown', e);
  }, [forwardSortableActivator]);

  const handleDragHandleTouchStart = useCallback((e: ReactTouchEvent<HTMLElement>) => {
    e.stopPropagation();
    forwardSortableActivator('onTouchStart', e);
  }, [forwardSortableActivator]);

  const handleDragHandleClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    e.stopPropagation();
  }, []);

  const handleDragHandleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    forwardSortableActivator('onKeyDown', e);
  }, [forwardSortableActivator]);

  const handleTitleMouseDown = useCallback((e: ReactMouseEvent<HTMLHeadingElement>) => {
    e.stopPropagation();
  }, []);

  const handleTitleTouchStart = useCallback((e: ReactTouchEvent<HTMLHeadingElement>) => {
    e.stopPropagation();
  }, []);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  const dragHandleStyle = {
    touchAction: dragDisabled ? 'auto' : 'none',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div className="relative overflow-hidden rounded-2xl">
      {swipeActionsWidth > 0 && (
        <div className="absolute inset-y-0 right-0 flex z-0" aria-hidden={!swipe.isOpen}>
          {canInvite ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label="Invite project"
              title="Invite"
              disabled={isCollaborationBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleInvite(e);
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--accent)]/10 text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20 disabled:opacity-60"
            >
              <InviteIcon />
            </button>
          ) : null}
          {canLeaveCollaboration ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label="Leave collaboration"
              title="Leave"
              disabled={isCollaborationBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleLeaveCollaboration(e);
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--warning)]/10 text-ink transition-colors hover:bg-[var(--warning)]/20 disabled:opacity-60"
            >
              <LeaveIcon />
            </button>
          ) : null}
          {showMergeToggle ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label={canSplitMerge ? 'Split cross-daemon merged project' : 'Merge same-name projects across daemons'}
              title={canSplitMerge ? 'Split' : 'Merge'}
              disabled={isMergeBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleToggleMerge();
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--accent)]/10 text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20 disabled:opacity-60"
            >
              {canSplitMerge ? <SplitIcon /> : <MergeIcon />}
            </button>
          ) : null}
          {canHide ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label="Hide project"
              title="Hide"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleHide();
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--paper)] text-muted hover:text-ink transition-colors"
            >
              <HideIcon />
            </button>
          ) : canUnhide ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label="Show project"
              title="Show"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleUnhide();
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              <ShowIcon />
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              tabIndex={swipe.isOpen ? 0 : -1}
              aria-label="Delete project"
              title="Delete"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleDelete();
              }}
              className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20 transition-colors"
            >
              <TrashIcon />
            </button>
          ) : null}
        </div>
      )}

      <div
        onClick={() => {
          if (swipe.consumeTap()) {
            return;
          }
          selectProject();
        }}
        onDoubleClick={openProjectDetails}
        className={`webapp-card relative z-10 cursor-pointer px-4 pb-4 pt-4 transition-colors hover:border-[var(--accent)] ${
          isSelected ? 'webapp-card-list-pane-active' : 'webapp-card-list-pane-idle'
        } ${isUnavailable || isPendingBinding ? 'opacity-70' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={project.name}
        aria-pressed={isSelected}
        data-project-id={project.id}
        onPointerDown={handleCardPointerDown}
        onPointerMove={handleCardPointerMove}
        onPointerUp={handleCardPointerUp}
        onPointerCancel={handleCardPointerCancel}
        style={swipe.panelStyle}
        onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Escape') {
            swipe.closeActions();
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (swipe.isOpen) {
              swipe.closeActions();
              return;
            }
            selectProject();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            {...attributes}
            aria-label="Drag project"
            aria-describedby={projectTitleId}
            title="Hold and drag to reorder"
            className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 cursor-grab active:cursor-grabbing overflow-hidden ${
              // Default project keeps its branded gradient regardless of the
              // custom icon so the home card stays recognizable.
              isDefault
                ? 'webapp-gradient-bg'
                : customIcon
                  ? isHidden
                    ? 'bg-muted/10'
                    : 'bg-transparent'
                  : isHidden
                    ? 'bg-muted/10'
                    : 'bg-accent/10'
            }`}
            style={dragHandleStyle}
            onPointerDown={handleDragHandlePointerDown}
            onMouseDown={handleDragHandleMouseDown}
            onTouchStart={handleDragHandleTouchStart}
            onClick={handleDragHandleClick}
            onKeyDown={handleDragHandleKeyDown}
          >
            {customIcon && !isDefault ? (
              isImageIcon ? (
                <Image
                  src={customIcon}
                  alt=""
                  width={40}
                  height={40}
                  unoptimized
                  loader={({ src }) => src}
                  draggable={false}
                  // Hidden projects render the icon as a grey "template" — full
                  // grayscale + low opacity matches the muted treatment the
                  // default folder icon already uses for the hidden state.
                  className={`h-full w-full object-cover ${isHidden ? 'grayscale opacity-30' : ''}`}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={`text-xl leading-none select-none ${isHidden ? 'grayscale opacity-30' : ''}`}
                >
                  {customIcon}
                </span>
              )
            ) : (
              <svg className={`w-5 h-5 ${isDefault ? 'text-white' : isHidden ? 'text-muted opacity-20' : 'text-accent'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap={isHidden ? 'butt' : 'round'}
                  strokeLinejoin="round"
                  strokeWidth={2}
                  strokeDasharray={isHidden ? '0.5 1.5' : undefined}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
            )}
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              {isEditing ? (
                <input
                  type="text"
                  aria-label="Edit project name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => void handleRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleRename();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      handleCancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent px-1 -mx-1 text-base font-medium text-ink outline-none ring-1 ring-[var(--accent)] rounded"
                />
              ) : (
                <h3
                  id={projectTitleId}
                  className="truncate font-medium select-none"
                  onPointerDown={handleTitlePointerDown}
                  onMouseDown={handleTitleMouseDown}
                  onTouchStart={handleTitleTouchStart}
                  onPointerUp={handleTitlePointerUp}
                  onPointerMove={handleTitlePointerMove}
                  onPointerCancel={handleTitlePointerUp}
                >
                  {project.name}
                </h3>
              )}
            </div>
            {hasMetadataChips || isMergedGroup ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                {isGitProject ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                    git
                  </span>
                ) : null}
                {isMergedGroup ? (
                  // Merged group: list each member's daemon as its own badge so
                  // the user can see at a glance which daemons own this name.
                  groupMembers.map((member) => {
                    const memberDaemon = typeof member.daemonHost === 'string' ? member.daemonHost.trim() : '';
                    if (!memberDaemon) return null;
                    const memberOnline = agents.some((agent) => agent.host === memberDaemon);
                    return (
                      <span
                        key={member.id}
                        title={formatBindingLabel(memberDaemon, member.workspacePath ?? null)}
                        className={`flex max-w-[12rem] items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium ${
                          memberOnline
                            ? 'bg-[var(--paper)] text-muted'
                            : 'bg-[var(--warning)]/10 text-ink'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`inline-block h-1.5 w-1.5 rounded-full ${memberOnline ? 'bg-emerald-500' : 'bg-[var(--warning)]'}`}
                        />
                        {memberDaemon}
                      </span>
                    );
                  })
                ) : daemonLabel ? (
                  <span
                    title={daemonTitle ?? daemonLabel}
                    className="flex max-w-[12rem] items-center gap-1 truncate rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted"
                  >
                    {daemonLabel}
                  </span>
                ) : null}
                {isMergedGroup ? (
                  <span
                    title={`${groupMembers.length} daemons share this project`}
                    className="flex items-center gap-1 rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]"
                  >
                    {groupMembers.length} daemons
                  </span>
                ) : null}
                {!isMergedGroup && isUnavailable ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--warning)]/10 px-1.5 py-0.5 text-xs font-medium text-ink">
                    Daemon offline
                  </span>
                ) : !isMergedGroup && isPendingBinding ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted">
                    Binding pending
                  </span>
                ) : null}
                {hasCollaboration ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                    {collaborationMemberCount}/{collaboration?.maxMembers ?? 5} members
                  </span>
                ) : null}
                {runningCount > 0 ? (
                  <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {runningCount} running
                  </span>
                ) : null}
                {killedCount > 0 ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--error)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--error)]">
                    {killedCount} killed
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      </div>
      {isDetailsOpen ? (
        // Lazy-mount the dialog so its inner content (which mirrors several
        // chips already on the card — daemon host, name, etc.) doesn't sit in
        // the DOM while closed. Keeping it mounted breaks Testing Library
        // queries like `getByText('daemon-a')` that expect a single match.
        <ProjectDetailsDialog
          open
          project={project}
          mergedMembers={isMergedGroup ? groupMembers : undefined}
          onClose={() => setIsDetailsOpen(false)}
        />
      ) : null}
    </div>
  );
}
