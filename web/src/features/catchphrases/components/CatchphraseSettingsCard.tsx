'use client';

import { useEffect, useRef, useState } from 'react';
import {
  MAX_CATCHPHRASES_PER_USER as MAX_TOTAL,
  MAX_CATCHPHRASE_TEXT_LENGTH as MAX_TEXT_LENGTH,
} from '../limits';
import { useCatchphrasesStore, type Catchphrase } from '../store';

export function CatchphraseSettingsCard() {
  const { catchphrases, hydrated, loading, error, hydrate, create, update, remove, reorder } =
    useCatchphrasesStore();

  const [isCreating, setIsCreating] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const createTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // RFC 0032 round-2 review: a 3s timeout on the two-step delete confirm
  // protects against accidental misfires when the user clicks once, walks
  // away, and forgets they armed the button.
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
    }
  }, []);

  // If a realtime push (or a delete from another tab) removes the row that
  // the user is currently editing, close the editor instead of letting the
  // user hit Save against a 404.
  useEffect(() => {
    if (editingId && !catchphrases.some((row) => row.id === editingId)) {
      setEditingId(null);
      setEditingText('');
    }
    if (confirmingDeleteId && !catchphrases.some((row) => row.id === confirmingDeleteId)) {
      setConfirmingDeleteId(null);
    }
  }, [catchphrases, editingId, confirmingDeleteId]);

  useEffect(() => {
    if (!hydrated) {
      void hydrate();
    }
  }, [hydrate, hydrated]);

  useEffect(() => {
    if (isCreating) {
      createTextareaRef.current?.focus();
    }
  }, [isCreating]);

  useEffect(() => {
    if (editingId) {
      editTextareaRef.current?.focus();
      editTextareaRef.current?.setSelectionRange(
        editTextareaRef.current.value.length,
        editTextareaRef.current.value.length,
      );
    }
  }, [editingId]);

  const startCreate = () => {
    if (catchphrases.length >= MAX_TOTAL) {
      return;
    }
    setIsCreating(true);
    setDraftText('');
  };

  const cancelCreate = () => {
    setIsCreating(false);
    setDraftText('');
  };

  const saveCreate = async () => {
    const trimmed = draftText.trim();
    if (!trimmed) return;
    const created = await create(trimmed);
    if (created) {
      setIsCreating(false);
      setDraftText('');
    }
  };

  const startEdit = (row: Catchphrase) => {
    setEditingId(row.id);
    setEditingText(row.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const trimmed = editingText.trim();
    if (!trimmed) return;
    const saved = await update(editingId, trimmed);
    if (saved) {
      setEditingId(null);
      setEditingText('');
    }
  };

  const moveUp = async (index: number) => {
    if (index <= 0) return;
    const next = [...catchphrases];
    const tmp = next[index - 1];
    next[index - 1] = next[index];
    next[index] = tmp;
    await reorder(next.map((row) => row.id));
  };

  const moveDown = async (index: number) => {
    if (index >= catchphrases.length - 1) return;
    const next = [...catchphrases];
    const tmp = next[index + 1];
    next[index + 1] = next[index];
    next[index] = tmp;
    await reorder(next.map((row) => row.id));
  };

  const confirmDelete = async (id: string) => {
    if (confirmingDeleteId === id) {
      if (deleteConfirmTimerRef.current) {
        clearTimeout(deleteConfirmTimerRef.current);
        deleteConfirmTimerRef.current = null;
      }
      setConfirmingDeleteId(null);
      await remove(id);
      return;
    }
    setConfirmingDeleteId(id);
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
    }
    deleteConfirmTimerRef.current = setTimeout(() => {
      setConfirmingDeleteId((current) => (current === id ? null : current));
      deleteConfirmTimerRef.current = null;
    }, 3000);
  };

  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void saveEdit();
    }
  };

  const handleCreateKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCreate();
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void saveCreate();
    }
  };

  const reachedLimit = catchphrases.length >= MAX_TOTAL;

  return (
    <section className="webapp-card p-5" data-testid="catchphrase-settings-card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center">
            <svg className="size-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.835L3 20l1.04-3.39A8.01 8.01 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </div>
          <h3 className="font-semibold text-lg">Catchphrases</h3>
        </div>
        <button
          type="button"
          onClick={startCreate}
          disabled={reachedLimit || isCreating}
          data-testid="catchphrase-new"
          aria-label="新增口头禅"
          className="size-8 flex items-center justify-center rounded-md webapp-gradient-bg text-white disabled:opacity-50 disabled:cursor-not-allowed"
          title={reachedLimit ? `Up to ${MAX_TOTAL} catchphrases` : '新增口头禅'}
        >
          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {error ? (
        <div className="mb-3 p-2 text-sm bg-error/10 text-error rounded border border-error/40">
          {error}
        </div>
      ) : null}

      {isCreating ? (
        <div className="mb-3 p-3 border border-border rounded-lg bg-paper">
          <textarea
            ref={createTextareaRef}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value.slice(0, MAX_TEXT_LENGTH))}
            onKeyDown={handleCreateKeyDown}
            placeholder="输入一条新的口头禅..."
            maxLength={MAX_TEXT_LENGTH}
            rows={2}
            data-testid="catchphrase-new-textarea"
            className="w-full text-sm bg-transparent border-0 outline-none resize-none placeholder:text-muted"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-muted">
              {draftText.length}/{MAX_TEXT_LENGTH}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={cancelCreate}
                aria-label="取消"
                title="取消"
                className="size-7 flex items-center justify-center rounded-md border border-border text-muted hover:text-ink hover:bg-[var(--accent)]/5"
              >
                <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => void saveCreate()}
                disabled={!draftText.trim()}
                data-testid="catchphrase-save-new"
                aria-label="保存"
                title="保存"
                className="size-7 flex items-center justify-center rounded-md webapp-gradient-bg text-white disabled:opacity-50"
              >
                <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!hydrated && loading ? (
        <div className="text-center py-6 text-muted text-sm">Loading...</div>
      ) : catchphrases.length === 0 && !isCreating ? (
        <div className="text-center py-6 text-muted text-sm">
          还没有口头禅，新建一条试试
        </div>
      ) : (
        // Cap visible height at ~5 rows (~64px per row including gap). Anything
        // past that scrolls; the rest of the Settings page stays at full height.
        <ul
          className="space-y-2 max-h-[20rem] overflow-y-auto webapp-scrollbar pr-1"
          data-testid="catchphrase-list"
        >
          {catchphrases.map((row, index) => {
            const isEditing = editingId === row.id;
            const isConfirming = confirmingDeleteId === row.id;
            return (
              <li
                key={row.id}
                className="p-3 bg-paper border border-border rounded-lg"
                data-testid={`catchphrase-item-${row.id}`}
              >
                {isEditing ? (
                  <div>
                    <textarea
                      ref={editTextareaRef}
                      value={editingText}
                      onChange={(event) =>
                        setEditingText(event.target.value.slice(0, MAX_TEXT_LENGTH))
                      }
                      onKeyDown={handleEditKeyDown}
                      maxLength={MAX_TEXT_LENGTH}
                      rows={2}
                      data-testid={`catchphrase-edit-textarea-${row.id}`}
                      className="w-full text-sm bg-transparent border-0 outline-none resize-none"
                    />
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-muted">
                        {editingText.length}/{MAX_TEXT_LENGTH}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          aria-label="取消"
                          title="取消"
                          className="size-7 flex items-center justify-center rounded-md border border-border text-muted hover:text-ink hover:bg-[var(--accent)]/5"
                        >
                          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveEdit()}
                          disabled={!editingText.trim()}
                          data-testid={`catchphrase-save-edit-${row.id}`}
                          aria-label="保存"
                          title="保存"
                          className="size-7 flex items-center justify-center rounded-md webapp-gradient-bg text-white disabled:opacity-50"
                        >
                          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col mr-1 mt-0.5">
                      <button
                        type="button"
                        onClick={() => void moveUp(index)}
                        disabled={index === 0}
                        title="上移"
                        aria-label="Move up"
                        className="text-muted hover:text-ink disabled:opacity-30 leading-none"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => void moveDown(index)}
                        disabled={index === catchphrases.length - 1}
                        title="下移"
                        aria-label="Move down"
                        className="text-muted hover:text-ink disabled:opacity-30 leading-none mt-0.5"
                      >
                        ▼
                      </button>
                    </div>
                    <p className="flex-1 text-sm whitespace-pre-wrap break-words">
                      {row.text}
                    </p>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(row)}
                        data-testid={`catchphrase-edit-${row.id}`}
                        aria-label="编辑"
                        title="编辑"
                        className="size-7 flex items-center justify-center rounded-md border border-border text-muted hover:text-ink hover:bg-[var(--accent)]/5"
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a4 4 0 01-1.414.93l-3.121 1.04 1.04-3.121a4 4 0 01.93-1.414z"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => void confirmDelete(row.id)}
                        data-testid={`catchphrase-delete-${row.id}`}
                        aria-label={isConfirming ? '再次点击确认删除' : '删除'}
                        title={isConfirming ? '再次点击确认删除' : '删除'}
                        className={`size-7 flex items-center justify-center rounded-md border ${
                          isConfirming
                            ? 'border-error bg-error/10 text-error animate-pulse'
                            : 'border-border text-muted hover:text-error hover:bg-error/5 hover:border-error/40'
                        }`}
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted text-right">
        {catchphrases.length}/{MAX_TOTAL}
      </p>
    </section>
  );
}
