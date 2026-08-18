'use client';

import type { InstallStatus, NetworkStatus, Tool } from '../types';

interface ToolStatusRowProps {
  tool: Tool;
  install?: InstallStatus;
  network?: NetworkStatus;
}

const TOOL_LABEL: Record<Tool, string> = {
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  copilot: 'Copilot',
  dsh: 'DeepSeek Harness',
};

function badge(ok: boolean, text: string) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-[var(--error)]/10 text-[var(--error)]'
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-[var(--error)]'}`}
      />
      {text}
    </span>
  );
}

export function ToolStatusRow({ tool, install, network }: ToolStatusRowProps) {
  const installed = install?.installed ?? false;
  const reachable = network?.reachable ?? false;
  const installLabel = installed
    ? install?.version
      ? `${install.version}`
      : 'installed'
    : install?.error || 'not installed';
  const netLabel = reachable
    ? network?.latencyMs !== undefined
      ? `${network.latencyMs}ms${network.httpStatus ? ` · HTTP ${network.httpStatus}` : ''}`
      : 'reachable'
    : network?.error || 'unreachable';

  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <span className="min-w-[64px] text-sm font-semibold text-ink">{TOOL_LABEL[tool]}</span>
      {badge(installed, installLabel)}
      {/* When the CLI is missing the install badge already covers it; a second
          'not installed' network pill is just noise. */}
      {installed ? badge(reachable, netLabel) : null}
    </div>
  );
}
