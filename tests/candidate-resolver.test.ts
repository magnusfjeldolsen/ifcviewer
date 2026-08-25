/**
 * `CandidateResolver` — the one candidate system.
 *
 * The interesting behaviour is the cycle offset. Hovering re-resolves on every
 * frame, so an offset that resets on each resolve would make `Tab` do nothing
 * at all, and one that never resets would leave `Tab` pointing at whatever
 * happened to occupy that index after the cursor moved on. The hold rule — keep
 * the offset while the cursor barely moved AND the same candidates came back —
 * is what makes `Tab` usable, so it is what these tests pin down.
 */
import { describe, it, expect, vi } from 'vitest';
import { CandidateResolver } from '../src/inspector/CandidateResolver';
import type { Candidate } from '../src/inspector/candidateMath';

function element(id: string, depth = 5): Candidate {
  return { kind: 'element', priority: 1, distance: 0, depth, id: `element:${id}` };
}

function measurement(id: string, distance = 3): Candidate {
  return { kind: 'measurement', priority: 2, distance, depth: 5, id: `measurement:${id}` };
}

const CURSOR = { x: 100, y: 100 };

describe('CandidateResolver', () => {
  it('merges every provider and returns them ranked', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });

    const ranked = resolver.resolve(CURSOR);
    expect(ranked.map((c) => c.kind)).toEqual(['element', 'measurement']);
  });

  it('makes the top-ranked candidate active before any cycling', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });

    resolver.resolve(CURSOR);
    expect(resolver.getActive()?.kind).toBe('element');
  });

  it('reports nothing active when no provider has anything', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'element', candidatesAt: () => [] });
    resolver.resolve(CURSOR);
    expect(resolver.getActive()).toBeNull();
    expect(resolver.count()).toBe(0);
  });

  it('cycles to the next candidate and wraps', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });
    resolver.resolve(CURSOR);

    expect(resolver.cycle()?.kind).toBe('measurement');
    expect(resolver.cycle()?.kind).toBe('element');
  });

  it('cycles backwards for Shift+Tab', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });
    resolver.resolve(CURSOR);

    expect(resolver.cycle(-1)?.kind).toBe('measurement');
  });

  it('does not cycle when there is only one candidate', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });
    resolver.resolve(CURSOR);

    expect(resolver.cycle()?.kind).toBe('element');
  });

  it('keeps the cycle offset when the cursor barely moves and the set is unchanged', () => {
    // The hover path re-resolves every frame. Losing the offset here would
    // make Tab appear to do nothing at all.
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });

    resolver.resolve(CURSOR);
    resolver.cycle();
    expect(resolver.getActive()?.kind).toBe('measurement');

    resolver.resolve({ x: CURSOR.x + 2, y: CURSOR.y + 1 });
    expect(resolver.getActive()?.kind).toBe('measurement');
  });

  it('resets the offset once the cursor moves beyond the hold radius', () => {
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')] });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });

    resolver.resolve(CURSOR);
    resolver.cycle();
    resolver.resolve({ x: CURSOR.x + 60, y: CURSOR.y });
    expect(resolver.getActive()?.kind).toBe('element');
  });

  it('resets the offset when the candidate set changes under a still cursor', () => {
    // Index 1 of the old list is not index 1 of the new one.
    let measurements = [measurement('m1')];
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => measurements });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')] });

    resolver.resolve(CURSOR);
    resolver.cycle();
    expect(resolver.getActive()?.kind).toBe('measurement');

    measurements = [measurement('m2')];
    resolver.resolve(CURSOR);
    expect(resolver.getActive()?.kind).toBe('element');
  });

  it('routes a pick to the provider that produced the candidate', () => {
    const measurementPick = vi.fn();
    const elementPick = vi.fn();
    const resolver = new CandidateResolver();
    resolver.register({
      kind: 'measurement',
      candidatesAt: () => [measurement('m1')],
      pick: measurementPick,
    });
    resolver.register({ kind: 'element', candidatesAt: () => [element('e1')], pick: elementPick });

    resolver.resolve(CURSOR);
    resolver.cycle();
    resolver.pick(resolver.getActive()!);

    expect(measurementPick).toHaveBeenCalledTimes(1);
    expect(elementPick).not.toHaveBeenCalled();
  });

  it('lights the active candidate and clears every other provider', () => {
    const measurementHighlight = vi.fn();
    const elementHighlight = vi.fn();
    const resolver = new CandidateResolver();
    resolver.register({
      kind: 'measurement',
      candidatesAt: () => [measurement('m1')],
      highlight: measurementHighlight,
    });
    resolver.register({
      kind: 'element',
      candidatesAt: () => [element('e1')],
      highlight: elementHighlight,
    });

    resolver.resolve(CURSOR);
    resolver.refreshHighlight();
    expect(elementHighlight).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'element' }));
    expect(measurementHighlight).toHaveBeenLastCalledWith(null);

    resolver.cycle();
    resolver.refreshHighlight();
    expect(measurementHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'measurement' }),
    );
    expect(elementHighlight).toHaveBeenLastCalledWith(null);
  });

  it('clear() drops the candidates and every highlight', () => {
    const highlight = vi.fn();
    const resolver = new CandidateResolver();
    resolver.register({ kind: 'measurement', candidatesAt: () => [measurement('m1')], highlight });

    resolver.resolve(CURSOR);
    resolver.clear();

    expect(resolver.count()).toBe(0);
    expect(resolver.getActive()).toBeNull();
    expect(highlight).toHaveBeenLastCalledWith(null);
  });

  it('stops consulting a deregistered provider', () => {
    const resolver = new CandidateResolver();
    const unregister = resolver.register({
      kind: 'measurement',
      candidatesAt: () => [measurement('m1')],
    });
    resolver.resolve(CURSOR);
    expect(resolver.count()).toBe(1);

    unregister();
    resolver.resolve(CURSOR);
    expect(resolver.count()).toBe(0);
  });
});
