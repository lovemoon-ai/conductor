'use client';

import type { DragEvent, PointerEvent } from 'react';

interface DragHandleProps {
  projectId: string;
  onDragStart?: (event: DragEvent<HTMLDivElement>, projectId: string) => void;
}

export function DragHandle({ projectId, onDragStart }: DragHandleProps) {
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', projectId);
    onDragStart?.(e, projectId);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onPointerDown={handlePointerDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex items-center justify-center w-6 h-6 cursor-grab active:cursor-grabbing text-muted/40 hover:text-muted transition-colors touch-none flex-shrink-0"
      aria-label="Drag to reorder"
    >
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
        <circle cx="2" cy="2" r="1.5" />
        <circle cx="8" cy="2" r="1.5" />
        <circle cx="2" cy="7" r="1.5" />
        <circle cx="8" cy="7" r="1.5" />
        <circle cx="2" cy="12" r="1.5" />
        <circle cx="8" cy="12" r="1.5" />
      </svg>
    </div>
  );
}
