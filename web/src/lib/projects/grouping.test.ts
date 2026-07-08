import { describe, expect, it } from 'vitest';
import { canMergeProjectsByFields } from './grouping';

const base = () => ({
  name: 'app',
  daemonHost: 'daemon-a',
  gitRemoteUrl: 'github.com/foo/app',
  mergeOptOut: false,
});

describe('canMergeProjectsByFields', () => {
  it('returns true for two same-named projects on different daemons with matching remotes', () => {
    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base(), daemonHost: 'daemon-b' },
      ),
    ).toBe(true);
  });

  it('returns false when the names differ', () => {
    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base(), name: 'other', daemonHost: 'daemon-b' },
      ),
    ).toBe(false);
  });

  it('returns false when either side opted out of merging', () => {
    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base(), daemonHost: 'daemon-b', mergeOptOut: true },
      ),
    ).toBe(false);

    expect(
      canMergeProjectsByFields(
        { ...base(), mergeOptOut: true },
        { ...base(), daemonHost: 'daemon-b' },
      ),
    ).toBe(false);
  });

  it('returns false when both sides advertise the same daemonHost', () => {
    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base() },
      ),
    ).toBe(false);
  });

  it('returns false when either daemonHost is empty', () => {
    expect(
      canMergeProjectsByFields(
        { ...base(), daemonHost: '' },
        { ...base(), daemonHost: 'daemon-b' },
      ),
    ).toBe(false);

    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base(), daemonHost: null },
      ),
    ).toBe(false);
  });

  it('returns false when gitRemoteUrl conflicts (both present)', () => {
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'github.com/foo/app' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/bar/other' },
      ),
    ).toBe(false);
  });

  it('compares gitRemoteUrl case-insensitively and trims whitespace', () => {
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: '  GitHub.com/Foo/App  ' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/foo/app' },
      ),
    ).toBe(true);
  });

  it('treats any GitHub SSH host alias as github.com so only owner/repo decides the merge', () => {
    // Different aliases for the same account/repo (the real-world m1/m2/windows case).
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'github-duinodu/lovemoon-ai/robotcloud' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/lovemoon-ai/robotcloud' },
      ),
    ).toBe(true);

    // A brand-new alias we have never hardcoded must still merge (the M2 bug).
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'github-dang217/lovemoon-ai/robotcloud' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github-duinodu/lovemoon-ai/robotcloud' },
      ),
    ).toBe(true);

    // `github.com-work` style aliases too.
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'github.com-work/lovemoon-ai/operator' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/lovemoon-ai/operator' },
      ),
    ).toBe(true);

    // owner/repo path stays strict: same repo name under a different owner must NOT merge.
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'github-dang217/duinodu/robotcloud' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/lovemoon-ai/robotcloud' },
      ),
    ).toBe(false);

    // Non-GitHub host is left untouched: a GitHub repo never merges with a GitLab repo of the same path.
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: 'gitlab.com/lovemoon-ai/robotcloud' },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: 'github.com/lovemoon-ai/robotcloud' },
      ),
    ).toBe(false);
  });

  it('allows merging when either gitRemoteUrl is missing (relaxed rule for non-git workspaces / pre-backfill)', () => {
    expect(
      canMergeProjectsByFields(
        { ...base(), gitRemoteUrl: null },
        { ...base(), daemonHost: 'daemon-b' },
      ),
    ).toBe(true);

    expect(
      canMergeProjectsByFields(
        { ...base() },
        { ...base(), daemonHost: 'daemon-b', gitRemoteUrl: undefined },
      ),
    ).toBe(true);
  });
});
