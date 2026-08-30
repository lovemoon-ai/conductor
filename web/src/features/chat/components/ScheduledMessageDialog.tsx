'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { useToast } from '@/components/common/FeedbackProvider';
import { getApiClient } from '@/shared/api/client';
import type { Message, ScheduledMessageSummary } from '@/shared/types';
import { ScheduledMessageForm } from './ScheduledMessageForm';
import {
  ScheduledMessageList,
  type ScheduleStatusFilter,
} from './ScheduledMessageList';

type DialogView = 'form' | 'list';

interface ScheduledMessageDialogProps {
  open: boolean;
  taskId: string;
  message: Message | null;
  onClose: () => void;
  /** Fires after any create/edit/cancel/delete so callers can refresh badges. */
  onChanged?: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

const tabClassName = (active: boolean) =>
  `flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    active
      ? 'webapp-gradient-bg text-white shadow-sm'
      : 'bg-paper text-muted hover:bg-border/35'
  }`;

/**
 * Management surface for a task's scheduled messages: create, browse/search,
 * edit and remove. Opens straight into the form when the caller brought
 * content along (a picked message or a non-empty composer draft), and into the
 * list otherwise.
 */
export function ScheduledMessageDialog({
  open,
  taskId,
  message,
  onClose,
  onChanged,
}: ScheduledMessageDialogProps) {
  const { pushToast } = useToast();
  const initialContent = message?.content ?? '';
  const [view, setView] = useState<DialogView>('form');
  // Remembers how the dialog was entered, so saving returns the user where
  // they started instead of always closing.
  const [openedInList, setOpenedInList] = useState(false);
  const [editing, setEditing] = useState<ScheduledMessageSummary | null>(null);
  const [schedules, setSchedules] = useState<ScheduledMessageSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<ScheduleStatusFilter>('all');
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Guards against an in-flight list response overwriting a newer one.
  const listRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const listFirst = !initialContent.trim();
    setOpenedInList(listFirst);
    setView(listFirst ? 'list' : 'form');
    setEditing(null);
    setKeyword('');
    setStatusFilter('all');
    setPendingId(null);
    setListError(null);
  }, [open, initialContent, message?.id]);

  const loadSchedules = useCallback(async () => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    setListLoading(true);
    try {
      const query = new URLSearchParams();
      if (statusFilter !== 'all') query.set('status', statusFilter);
      if (keyword.trim()) query.set('q', keyword.trim());
      const search = query.toString();
      const response = await getApiClient().get<{ schedules?: ScheduledMessageSummary[] }>(
        `/tasks/${taskId}/scheduled-messages${search ? `?${search}` : ''}`,
      );
      if (listRequestRef.current !== requestId) return;
      setSchedules(response?.schedules ?? []);
      setListError(null);
    } catch (error) {
      if (listRequestRef.current !== requestId) return;
      setListError(error instanceof Error ? error.message : 'Failed to load scheduled messages.');
    } finally {
      if (listRequestRef.current === requestId) {
        setListLoading(false);
      }
    }
  }, [keyword, statusFilter, taskId]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void loadSchedules();
    }, keyword ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [open, keyword, loadSchedules]);

  const handleSaved = useCallback(() => {
    onChanged?.();
    void loadSchedules();
    if (editing || openedInList) {
      // The user came from the list, so send them back to see the new plan
      // rather than dropping them out of the dialog entirely.
      setEditing(null);
      setView('list');
      return;
    }
    onClose();
  }, [editing, loadSchedules, onChanged, onClose, openedInList]);

  const handleRemove = useCallback(
    async (schedule: ScheduledMessageSummary) => {
      setPendingId(schedule.id);
      try {
        await getApiClient().delete(`/tasks/${taskId}/scheduled-messages/${schedule.id}`);
        pushToast({
          title: schedule.status === 'active' ? 'Schedule canceled' : 'Schedule deleted',
          variant: 'success',
        });
        onChanged?.();
        await loadSchedules();
      } catch (error) {
        setListError(error instanceof Error ? error.message : 'Failed to remove scheduled message.');
      } finally {
        setPendingId(null);
      }
    },
    [loadSchedules, onChanged, pushToast, taskId],
  );

  const handleEdit = useCallback((schedule: ScheduledMessageSummary) => {
    setEditing(schedule);
    setView('form');
  }, []);

  const handleFormCancel = useCallback(() => {
    if (editing || openedInList) {
      setEditing(null);
      setView('list');
      return;
    }
    onClose();
  }, [editing, onClose, openedInList]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Scheduled Message' : 'Scheduled Messages'}
      description={
        editing
          ? 'Update the message or its schedule. Timing restarts from now.'
          : 'Send this message later, or manage the schedules already set on this task.'
      }
      maxWidthClassName="max-w-lg"
    >
      <div className="mb-4 flex gap-2 rounded-xl border border-border bg-paper/50 p-1">
        <button
          type="button"
          className={tabClassName(view === 'form')}
          onClick={() => setView('form')}
        >
          {editing ? 'Edit' : 'New'}
        </button>
        <button
          type="button"
          className={tabClassName(view === 'list')}
          onClick={() => {
            setEditing(null);
            setView('list');
          }}
        >
          {`Manage${schedules.length ? ` (${schedules.length})` : ''}`}
        </button>
      </div>

      {view === 'form' ? (
        <ScheduledMessageForm
          key={editing?.id ?? `new:${message?.id ?? ''}`}
          taskId={taskId}
          initialContent={editing?.content ?? initialContent}
          sourceMessageId={message?.id || null}
          schedule={editing}
          onSaved={handleSaved}
          onCancel={handleFormCancel}
        />
      ) : (
        <ScheduledMessageList
          schedules={schedules}
          loading={listLoading}
          error={listError}
          keyword={keyword}
          statusFilter={statusFilter}
          pendingId={pendingId}
          onKeywordChange={setKeyword}
          onStatusFilterChange={setStatusFilter}
          onRefresh={() => void loadSchedules()}
          onEdit={handleEdit}
          onRemove={(schedule) => void handleRemove(schedule)}
          onCreate={() => {
            setEditing(null);
            setView('form');
          }}
        />
      )}
    </Dialog>
  );
}
