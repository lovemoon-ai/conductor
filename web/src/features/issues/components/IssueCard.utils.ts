import type { Issue } from '@/shared/types';

const stopEventPropagation = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

/**
 * Hash a daemon host into one of a small palette so a given daemon stays the
 * same color across cards in a session. Pure function, no React state.
 */
const DAEMON_BADGE_PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
];
export const pickDaemonBadgeClass = (daemonHost: string): string => {
  let hash = 0;
  for (let i = 0; i < daemonHost.length; i += 1) {
    hash = (hash * 31 + daemonHost.charCodeAt(i)) | 0;
  }
  return DAEMON_BADGE_PALETTE[Math.abs(hash) % DAEMON_BADGE_PALETTE.length];
};

export type IssueOwnerOption = {
  userId: string;
  label: string;
  projectId?: string;
  projectName?: string;
};

const getOwnerInitials = (label: string): string => {
  const normalized = label.trim();
  if (!normalized) {
    return '?';
  }
  if (!normalized.includes('@')) {
    const digits = normalized.replace(/\D/g, '');
    if (digits.length >= 2) {
      return digits.slice(-2);
    }
    if (digits.length === 1) {
      return digits;
    }
  }
  const compact = normalized.includes('@') ? normalized.split('@')[0] : normalized;
  return compact.slice(0, 2).toUpperCase();
};

export { stopEventPropagation, getOwnerInitials };
