import { beforeEach, describe, expect, it } from 'vitest';
import {
  AI_MANAGER_PATH_PREFIX,
  SETTINGS_ROOT_PATH,
  isSettingsAreaPath,
  resolveSettingsHref,
  useSettingsNavStore,
} from './nav-store';

describe('isSettingsAreaPath', () => {
  it('matches the settings root', () => {
    expect(isSettingsAreaPath(SETTINGS_ROOT_PATH)).toBe(true);
  });

  it('matches nested settings routes', () => {
    expect(isSettingsAreaPath(`${SETTINGS_ROOT_PATH}/profile`)).toBe(true);
  });

  it('matches the ai-manager bare pathname (no query)', () => {
    // usePathname() strips query, so the bare pathname needs to match.
    expect(isSettingsAreaPath(AI_MANAGER_PATH_PREFIX)).toBe(true);
  });

  it('matches ai-manager with a query string (lastPath-style storage)', () => {
    expect(
      isSettingsAreaPath(`${AI_MANAGER_PATH_PREFIX}?agentHost=host-1`),
    ).toBe(true);
  });

  it('matches nested ai-manager paths', () => {
    expect(isSettingsAreaPath(`${AI_MANAGER_PATH_PREFIX}/anything`)).toBe(true);
  });

  it('rejects unrelated routes', () => {
    expect(isSettingsAreaPath('/app/tasks')).toBe(false);
    expect(isSettingsAreaPath('/app/issues')).toBe(false);
    expect(isSettingsAreaPath('/app/projects')).toBe(false);
    expect(isSettingsAreaPath('/')).toBe(false);
  });

  it('does not match prefix-collision routes', () => {
    // /app/settings-foo must NOT be treated as settings.
    expect(isSettingsAreaPath('/app/settings-foo')).toBe(false);
    expect(isSettingsAreaPath('/app/ai-manager-other')).toBe(false);
  });
});

describe('resolveSettingsHref', () => {
  it('returns the settings root when outside the settings area and no lastPath', () => {
    expect(resolveSettingsHref('/app/tasks', null)).toBe(SETTINGS_ROOT_PATH);
  });

  it('returns the remembered path when outside the settings area', () => {
    const remembered = `${AI_MANAGER_PATH_PREFIX}?agentHost=host-1`;
    expect(resolveSettingsHref('/app/tasks', remembered)).toBe(remembered);
  });

  it('resets to root when the user is already inside the settings area (root)', () => {
    // Clicking "Settings" while on /app/settings should NOT bounce us to
    // a remembered daemon — it should stay/reset to root.
    expect(
      resolveSettingsHref(SETTINGS_ROOT_PATH, `${AI_MANAGER_PATH_PREFIX}?agentHost=host-1`),
    ).toBe(SETTINGS_ROOT_PATH);
  });

  it('resets to root when the user is already inside the settings area (ai-manager)', () => {
    expect(
      resolveSettingsHref(AI_MANAGER_PATH_PREFIX, `${AI_MANAGER_PATH_PREFIX}?agentHost=host-1`),
    ).toBe(SETTINGS_ROOT_PATH);
  });

  it('falls back to root when lastPath is not a valid settings-area path', () => {
    // Guard against stale or corrupted localStorage values pointing at, say, /app/tasks.
    expect(resolveSettingsHref('/app/tasks', '/app/tasks')).toBe(SETTINGS_ROOT_PATH);
    expect(resolveSettingsHref('/app/tasks', '/evil')).toBe(SETTINGS_ROOT_PATH);
  });
});

describe('useSettingsNavStore', () => {
  beforeEach(() => {
    useSettingsNavStore.getState().reset();
  });

  it('starts with no remembered path', () => {
    expect(useSettingsNavStore.getState().lastPath).toBeNull();
  });

  it('remembers a valid absolute path', () => {
    const path = `${AI_MANAGER_PATH_PREFIX}?agentHost=host-1`;
    useSettingsNavStore.getState().setLastPath(path);
    expect(useSettingsNavStore.getState().lastPath).toBe(path);
  });

  it('rejects non-absolute paths (guards against garbage/malicious values)', () => {
    useSettingsNavStore.getState().setLastPath('http://evil.example.com/pwn');
    expect(useSettingsNavStore.getState().lastPath).toBeNull();

    useSettingsNavStore.getState().setLastPath('app/settings');
    expect(useSettingsNavStore.getState().lastPath).toBeNull();

    useSettingsNavStore.getState().setLastPath('');
    expect(useSettingsNavStore.getState().lastPath).toBeNull();
  });

  it('reset() clears the remembered path', () => {
    useSettingsNavStore.getState().setLastPath(SETTINGS_ROOT_PATH);
    expect(useSettingsNavStore.getState().lastPath).toBe(SETTINGS_ROOT_PATH);

    useSettingsNavStore.getState().reset();
    expect(useSettingsNavStore.getState().lastPath).toBeNull();
  });
});
