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
  it('returns the bare objective with no framing (single source of truth)', () => {
    // The reviewer asked us to eliminate three-way divergence between
    // `metadata.initialContent`, the persisted Message content, and
    // `launch_config.goal.objective`. The objective is now the canonical text;
    // no `Issue: <title>` prefix is added here.
    expect(
      buildIssueGoalInitialContent({ title: 'Implement X', objective: 'do the thing' }),
    ).toBe('do the thing');
  });

  it('ignores the title regardless of whether it is empty or set', () => {
    expect(
      buildIssueGoalInitialContent({ title: '   ', objective: 'do the thing' }),
    ).toBe('do the thing');
  });

  it('does not exceed the global cap', () => {
    const result = buildIssueGoalInitialContent({
      title: 'T',
      objective: 'x'.repeat(MAX_GOAL_OBJECTIVE_LENGTH * 2),
    });
    expect(result.length).toBeLessThanOrEqual(MAX_GOAL_OBJECTIVE_LENGTH);
    expect(result.endsWith('...[truncated]')).toBe(true);
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
