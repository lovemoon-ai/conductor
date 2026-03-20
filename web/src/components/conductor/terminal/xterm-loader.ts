export async function loadXtermModules() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);

  return {
    Terminal,
    FitAddon,
  };
}
