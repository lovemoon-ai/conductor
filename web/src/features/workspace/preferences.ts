'use client';

import { useSyncExternalStore } from 'react';

const EVENT = 'conductor-workspace-preference';
function subscribe(callback: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key); else memory.clear();
    callback();
  };
  window.addEventListener('storage', storage);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(EVENT, callback);
  };
}
const memory = new Map<string, string>();
function read(key: string) {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key); }
  catch { return memory.get(key) ?? null; }
}
export function useWorkspacePreference(key: string) {
  const value = useSyncExternalStore(subscribe, () => read(key), () => null);
  return [value, (next: string) => {
    try {
      localStorage.setItem(key, next);
      memory.delete(key);
    } catch { memory.set(key, next); }
    window.dispatchEvent(new Event(EVENT));
  }] as const;
}
export function useReadingSize() {
  const [raw, set] = useWorkspacePreference('conductor-reading-size');
  const parsed = raw === null ? null : Number(raw);
  const size = parsed !== null && Number.isInteger(parsed) && parsed >= 12 && parsed <= 22 ? parsed : null;
  return [size, (next: number | null) => set(next === null ? 'auto' : String(Math.min(22, Math.max(12, next))))] as const;
}
export const TASK_COLUMNS = ['preview', 'type', 'backend', 'project', 'host', 'branch', 'updated'] as const;
export type TaskColumn = typeof TASK_COLUMNS[number];
export function useTaskColumns() {
  const [raw, set] = useWorkspacePreference('conductor-task-columns');
  let columns: readonly TaskColumn[] = ['preview', 'backend', 'host'];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) columns = TASK_COLUMNS.filter((column) => parsed.includes(column));
    } catch { /* Use the compact default for invalid stored values. */ }
  }
  return [columns, (next: readonly TaskColumn[]) => set(JSON.stringify(next))] as const;
}
