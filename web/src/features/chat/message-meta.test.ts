import { afterEach, describe, expect, it } from 'vitest';
import { chooseMetaSide, formatTurnUsage, placeMessageMeta } from './message-meta';

const free = { top: [], bottom: [] };

describe('chooseMetaSide', () => {
  it('defaults to the top when both slots are on screen and free', () => {
    expect(chooseMetaSide({ top: true, bottom: true }, free)).toEqual({ side: 'top', floating: false, evict: [] });
  });

  it('rule 1: uses the only on-screen slot, e.g. the bottom of a long reply whose top scrolled away', () => {
    expect(chooseMetaSide({ top: false, bottom: true }, free)).toEqual({ side: 'bottom', floating: false, evict: [] });
    expect(chooseMetaSide({ top: true, bottom: false }, free)).toEqual({ side: 'top', floating: false, evict: [] });
  });

  it('rule 2: avoids the gap a neighbour already shows its line in', () => {
    // The message above shows its line at its bottom, i.e. in this message's top slot.
    expect(chooseMetaSide({ top: true, bottom: true }, { top: ['above'], bottom: [] })).toEqual({
      side: 'bottom',
      floating: false,
      evict: [],
    });
  });

  it('rule 2 never moves the line off screen; rule 3 then covers the neighbour instead', () => {
    expect(chooseMetaSide({ top: true, bottom: false }, { top: ['above'], bottom: [] })).toEqual({
      side: 'top',
      floating: false,
      evict: ['above'],
    });
  });

  it('rule 3: with every on-screen slot taken, takes the first and hides the covered line', () => {
    expect(chooseMetaSide({ top: true, bottom: true }, { top: ['above'], bottom: ['below'] })).toEqual({
      side: 'top',
      floating: false,
      evict: ['above'],
    });
  });

  it('keeps both sides for a bubble taller than the view, whose line floats at the edge', () => {
    expect(chooseMetaSide({ top: false, bottom: false }, { top: ['above'], bottom: [] })).toEqual({
      side: 'bottom',
      floating: true,
      evict: [],
    });
  });
});

describe('formatTurnUsage', () => {
  it('shows the turn tokens, the task total and the input cache share', () => {
    expect(
      formatTurnUsage({ turn_usage: { tokens: 43268, task_tokens: 143268, input_tokens: 43174, cached_input_tokens: 21072 } }),
    ).toEqual(['Turn 43.3K', 'Task 143.3K', 'Cache 48%']);
  });

  it('never rounds a partial cache share up to 100%', () => {
    expect(formatTurnUsage({ turn_usage: { tokens: 10, input_tokens: 1000, cached_input_tokens: 999 } })).toEqual([
      'Turn 10',
      'Cache 99%',
    ]);
  });

  it('omits what the reply does not carry', () => {
    expect(formatTurnUsage({ turn_usage: { tokens: 70 } })).toEqual(['Turn 70']);
    expect(formatTurnUsage({ turn_usage: { tokens: 5, input_tokens: 0, cached_input_tokens: 0 } })).toEqual(['Turn 5']);
    expect(formatTurnUsage({ usage: { input_tokens: 5 } })).toEqual([]);
    expect(formatTurnUsage(null)).toEqual([]);
  });
});

describe('placeMessageMeta', () => {
  const shownBottom = { side: 'bottom' as const, floating: false };
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });

  const bubble = (id: string, top: number, bottom: number, line?: [number, number]) => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => rect(top, bottom) as DOMRect;
    if (line) {
      const meta = document.createElement('span');
      meta.dataset.messageMeta = id;
      meta.getBoundingClientRect = () => rect(...line) as DOMRect;
      element.appendChild(meta);
    }
    document.body.appendChild(element);
    return element;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('follows the message above to the bottom when it shows its line in the shared gap', () => {
    bubble('above', 100, 200, [200, 208]);
    const below = bubble('below', 208, 300);
    expect(placeMessageMeta(below, 'below', { above: shownBottom })).toEqual({ side: 'bottom', floating: false, evict: [] });
  });

  it('ignores lines that are only hovered, and a line in a gap it does not touch', () => {
    bubble('above', 100, 200, [200, 208]);
    bubble('far', 0, 50, [50, 58]);
    const below = bubble('below', 208, 300);
    expect(placeMessageMeta(below, 'below', { far: shownBottom })).toEqual({ side: 'top', floating: false, evict: [] });
  });

  it('covers the line above when the bubble bottom is off screen', () => {
    bubble('above', 100, 200, [200, 208]);
    const below = bubble('below', 208, window.innerHeight + 100);
    expect(placeMessageMeta(below, 'below', { above: shownBottom })).toEqual({ side: 'top', floating: false, evict: ['above'] });
  });
});
