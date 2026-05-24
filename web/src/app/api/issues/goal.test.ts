import { describe, expect, it } from 'vitest';
import {
  buildIssueGoalInitialContent,
  isGoalCapableBackend,
  MAX_GOAL_OBJECTIVE_LENGTH,
  parseGoalDirective,
} from './goal';

describe('parseGoalDirective', () => {
  it('parses inline objective on the first line', () => {
    expect(parseGoalDirective('/goal do X')).toEqual({
      mode: 'goal',
      objective: 'do X',
    });
  });

  it('combines inline objective with remaining body', () => {
    const body = '/goal ship feature\n\nbackground context\nmore detail';
    const result = parseGoalDirective(body);
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective).toBe('ship feature\n\nbackground context\nmore detail');
    }
  });

  it('uses the rest of the body when /goal stands alone on the first line', () => {
    const body = '/goal\nactual objective\n\nmore detail';
    const result = parseGoalDirective(body);
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective).toBe('actual objective\n\nmore detail');
    }
  });

  it('skips leading blank lines when locating the first non-empty line', () => {
    const body = '\n\n   \n/goal kickoff\nrest';
    const result = parseGoalDirective(body);
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective).toBe('kickoff\n\nrest');
    }
  });

  it('returns turn mode for ordinary issue bodies', () => {
    expect(parseGoalDirective('Hello world')).toEqual({ mode: 'turn' });
  });

  it('returns turn mode when /goal is not on the first line', () => {
    expect(parseGoalDirective('intro\n/goal do X')).toEqual({ mode: 'turn' });
  });

  it('returns turn mode for empty bodies', () => {
    expect(parseGoalDirective('')).toEqual({ mode: 'turn' });
    expect(parseGoalDirective(null)).toEqual({ mode: 'turn' });
    expect(parseGoalDirective(undefined)).toEqual({ mode: 'turn' });
  });

  it('falls back to turn mode when the directive has no objective', () => {
    expect(parseGoalDirective('/goal')).toEqual({ mode: 'turn' });
    expect(parseGoalDirective('/goal   ')).toEqual({ mode: 'turn' });
    expect(parseGoalDirective('/goal\n   \n')).toEqual({ mode: 'turn' });
  });

  it('truncates very long objectives from the end with a marker', () => {
    const body = `/goal ${'x'.repeat(5000)}`;
    const result = parseGoalDirective(body);
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective.length).toBeLessThanOrEqual(MAX_GOAL_OBJECTIVE_LENGTH);
      expect(result.objective.endsWith('...[truncated]')).toBe(true);
    }
  });

  it('normalizes CRLF line endings', () => {
    const result = parseGoalDirective('/goal lead\r\n\r\ntail');
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective).toBe('lead\n\ntail');
    }
  });

  it('accepts /Goal (mixed case) as a directive', () => {
    expect(parseGoalDirective('/Goal do X')).toEqual({
      mode: 'goal',
      objective: 'do X',
    });
  });

  it('accepts /GOAL (all caps) as a directive', () => {
    expect(parseGoalDirective('/GOAL do X')).toEqual({
      mode: 'goal',
      objective: 'do X',
    });
  });

  it('accepts leading whitespace before /goal', () => {
    expect(parseGoalDirective('  /goal do X')).toEqual({
      mode: 'goal',
      objective: 'do X',
    });
  });

  it('accepts tabs between /goal and the objective', () => {
    expect(parseGoalDirective('/goal\t\tdo X')).toEqual({
      mode: 'goal',
      objective: 'do X',
    });
  });

  it('does NOT match /goalsomething (no space after /goal)', () => {
    expect(parseGoalDirective('/goalsomething')).toEqual({ mode: 'turn' });
  });

  it('truncates 5000-char body and keeps the marker in the result', () => {
    const body = `/goal ${'x'.repeat(5000)}`;
    const result = parseGoalDirective(body);
    expect(result.mode).toBe('goal');
    if (result.mode === 'goal') {
      expect(result.objective.length).toBeLessThanOrEqual(MAX_GOAL_OBJECTIVE_LENGTH);
      // Marker MUST be present — the bug was that an inner slice() chopped it off.
      expect(result.objective.endsWith('...[truncated]')).toBe(true);
    }
  });
});

describe('buildIssueGoalInitialContent', () => {
  it('prepends the `/goal\\n` directive so fire\'s per-message detector sees it', () => {
    // Per the per-message detection design, the daemon ships initial content
    // verbatim and fire decides goal-vs-turn from the first line of the
    // message. We MUST include the `/goal` prefix here so fire's first-turn
    // detector picks it up — there is no longer a `--goal` spawn flag.
    expect(
      buildIssueGoalInitialContent({ title: 'Implement X', objective: 'do the thing' }),
    ).toBe('/goal\ndo the thing');
  });

  it('ignores the title regardless of whether it is empty or set', () => {
    expect(
      buildIssueGoalInitialContent({ title: '   ', objective: 'do the thing' }),
    ).toBe('/goal\ndo the thing');
  });

  it('keeps the objective body bounded by the global cap (prefix is separate budget)', () => {
    const result = buildIssueGoalInitialContent({
      title: 'T',
      objective: 'x'.repeat(MAX_GOAL_OBJECTIVE_LENGTH * 2),
    });
    // The objective body (after the `/goal\n` prefix) is the bounded part —
    // that's what consumers persist into `launch_config.goal.objective`.
    expect(result.startsWith('/goal\n')).toBe(true);
    const body = result.slice('/goal\n'.length);
    expect(body.length).toBeLessThanOrEqual(MAX_GOAL_OBJECTIVE_LENGTH);
    expect(body.endsWith('...[truncated]')).toBe(true);
  });
});

describe('isGoalCapableBackend', () => {
  it('accepts claude and codex', () => {
    expect(isGoalCapableBackend('claude')).toBe(true);
    expect(isGoalCapableBackend('codex')).toBe(true);
  });

  it('rejects other backends and falsy values', () => {
    expect(isGoalCapableBackend('kimi')).toBe(false);
    expect(isGoalCapableBackend('gemini')).toBe(false);
    expect(isGoalCapableBackend(null)).toBe(false);
    expect(isGoalCapableBackend(undefined)).toBe(false);
    expect(isGoalCapableBackend('')).toBe(false);
  });
});
