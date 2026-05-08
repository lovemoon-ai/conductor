import { describe, expect, it } from 'vitest';
import { pickDaemonBadgeClass } from './IssueCard';

describe('IssueCard daemon badge colors', () => {
  it('keeps a stable class for the same daemon host', () => {
    expect(pickDaemonBadgeClass('daemon-a')).toBe(pickDaemonBadgeClass('daemon-a'));
  });

  it('can assign different classes to different daemon hosts', () => {
    expect(pickDaemonBadgeClass('daemon-a')).not.toBe(pickDaemonBadgeClass('daemon-b'));
  });
});
