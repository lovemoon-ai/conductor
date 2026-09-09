'use client';

import { useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';

const KEY = 'conductor-task-pane-width';
const subscribe = () => () => { };
const clamp = (width: number) => Math.max(250, Math.min(520, width));
const readWidth = () => {
  try {
    const value = Number(localStorage.getItem(KEY));
    return value >= 250 && Number.isFinite(value) ? clamp(value) : 340;
  } catch { return 340; }
};

export function ResizableTaskPane({ children }: { children: ReactNode }) {
  const stored = useSyncExternalStore(subscribe, readWidth, () => 340);
  const [override, setOverride] = useState<number | null>(null);
  const width = override ?? stored;
  const paneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const currentWidth = useRef(width);
  const update = (next: number, persist: boolean) => {
    const value = clamp(next);
    currentWidth.current = value;
    setOverride(value);
    if (persist) {
      try { localStorage.setItem(KEY, String(value)); } catch { /* Memory preference still works. */ }
    }
  };

  return (
    <div ref={paneRef} className="task-pane relative flex min-h-0 shrink-0 flex-col border-r border-border" style={{ '--task-pane-width': `${width}px` } as CSSProperties}>
      {children}
      <div
        role="separator"
        aria-label="Task list width"
        aria-orientation="vertical"
        aria-valuemin={250}
        aria-valuemax={520}
        aria-valuenow={width}
        tabIndex={0}
        className="task-pane-resizer absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none transition-colors"
        onKeyDown={(event) => {
          const next = event.key === 'ArrowLeft' ? width - 20 : event.key === 'ArrowRight' ? width + 20 : event.key === 'Home' ? 250 : event.key === 'End' ? 520 : null;
          if (next === null) return;
          event.preventDefault();
          update(next, true);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { x: event.clientX, width: paneRef.current?.getBoundingClientRect().width ?? width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          update(drag.current.width + event.clientX - drag.current.x, false);
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          update(currentWidth.current, true);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
      />
    </div>
  );
}
