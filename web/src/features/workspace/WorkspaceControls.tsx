'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { TASK_COLUMNS, useReadingSize, useTaskColumns } from './preferences';

function Disclosure({ label, children, icon }: { label: string; children: ReactNode; icon: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && ref.current?.open) {
        event.preventDefault();
        event.stopPropagation();
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  return <details ref={ref} className="workspace-disclosure relative shrink-0">
    <summary aria-label={label} title={label} className="flex size-11 cursor-pointer list-none items-center justify-center rounded-md text-muted hover:bg-border/40 md:size-8">{icon}</summary>
    {/* Menu items (`data-menu-item`) close the menu once picked. */}
    <div onClick={(event) => { if ((event.target as Element).closest('[data-menu-item]')) ref.current?.removeAttribute('open'); }} className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-border bg-panel p-3 text-sm text-ink shadow-lg">{children}</div>
  </details>;
}
/** The chat's ⋯ menu: session actions passed as children, then text size. */
export function ReadingSettings({ children }: { children?: ReactNode }) {
  const [size, setSize] = useReadingSize();
  const current = () => size ?? (window.matchMedia('(min-width: 768px)').matches ? 14 : 16);
  return <Disclosure label="Chat options" icon="⋯">
    {children ? <div className="mb-3 border-b border-border pb-2">{children}</div> : null}
    <p className="mb-2 text-xs text-muted">Text size</p>
    <div className="flex items-center justify-between gap-2">
      <button type="button" aria-label="Decrease text size" disabled={size === 12} onClick={() => setSize(current() - 1)} className="size-11 rounded border border-border disabled:opacity-40">A−</button>
      <output aria-live="polite">{size === null ? 'Auto' : `${size}px`}</output>
      <button type="button" aria-label="Increase text size" disabled={size === 22} onClick={() => setSize(current() + 1)} className="size-11 rounded border border-border disabled:opacity-40">A+</button>
    </div>
    <button type="button" onClick={() => setSize(null)} className="mt-2 min-h-9 w-full rounded text-xs text-muted hover:bg-paper">Reset to default</button>
  </Disclosure>;
}
const labels = { preview: 'Message preview', type: 'Task type', backend: 'Backend', project: 'Project', host: 'Host', branch: 'Branch', updated: 'Updated' };
export function TaskColumnSettings() {
  const [columns, setColumns] = useTaskColumns();
  return <Disclosure label="Visible task columns" icon="☷">
    <p className="mb-2 text-xs text-muted">Visible columns</p>
    {TASK_COLUMNS.map((column) => <label key={column} className="flex min-h-8 cursor-pointer items-center gap-2">
      <input type="checkbox" checked={columns.includes(column)} onChange={(event) => setColumns(event.target.checked ? [...columns, column] : columns.filter((entry) => entry !== column))} />
      {labels[column]}
    </label>)}
    <p className="mt-2 text-xs text-muted">Title and status stay visible. Narrow panes use compact rows.</p>
  </Disclosure>;
}
