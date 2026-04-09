export function formatBindingLabel(daemonHost: string, workspacePath?: string | null): string {
  const trimmedDaemonHost = daemonHost.trim();
  const trimmedWorkspacePath = typeof workspacePath === 'string' ? workspacePath.trim() : '';

  if (!trimmedWorkspacePath) {
    return trimmedDaemonHost;
  }

  return `${trimmedDaemonHost} : ${trimmedWorkspacePath}`;
}
