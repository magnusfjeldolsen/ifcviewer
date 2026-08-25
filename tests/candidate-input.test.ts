// @vitest-environment jsdom
/**
 * `CandidateInput` — pointer and `Tab` wiring for the candidate system.
 *
 * The guards are the point. `Tab` is how keyboard users move through the
 * inspector, the model tree and the toolbar, which are all real DOM: taking it
 * unconditionally would trap them. And the hover raycast is not free on a
 * 100k-mesh model, so it has to be throttled to one per frame and stay dormant
 * when there is nothing to arbitrate. Each test below pins one of those.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CandidateInput } from '../src/inspector/CandidateInput';
import { CandidateResolver } from '../src/inspector/CandidateResolver';
import type { Candidate } from '../src/inspector/candidateMath';

function element(id = 'e1'): Candidate {
  return { kind: 'element', priority: 1, distance: 0, depth: 5, id: `element:${id}` };
}

function measurement(id = 'm1'): Candidate {
  return { kind: 'measurement', priority: 2, distance: 3, depth: 5, id: `measurement:${id}` };
}

interface Harness {
  canvas: HTMLCanvasElement;
  resolver: CandidateResolver;
  input: CandidateInput;
  frames: Array<() => void>;
  runFrame: () => void;
  measurementHighlight: ReturnType<typeof vi.fn>;
  setCanPick: (value: boolean) => void;
  setShowHover: (value: boolean) => void;
  setActive: (value: boolean) => void;
}

/**
 * Every `CandidateInput` puts a keydown listener on `document`, so a harness
 * left alive would answer `Tab` in the next test and make a "leaves Tab alone"
 * assertion pass or fail for the wrong reason. Track them and tear them down.
 */
const built: CandidateInput[] = [];

afterEach(() => {
  for (const input of built.splice(0, built.length)) input.dispose();
});

function setup(options: { candidates?: () => Candidate[] } = {}): Harness {
  document.body.innerHTML = '';
  const canvas = document.createElement('canvas');
  // jsdom reports a zero-sized rect; the input only subtracts it, so 0 is fine.
  document.body.appendChild(canvas);

  const resolver = new CandidateResolver();
  const measurementHighlight = vi.fn();
  const listed = options.candidates ?? ((): Candidate[] => [element(), measurement()]);

  resolver.register({
    kind: 'element',
    candidatesAt: () => listed().filter((c) => c.kind === 'element'),
  });
  resolver.register({
    kind: 'measurement',
    candidatesAt: () => listed().filter((c) => c.kind === 'measurement'),
    highlight: measurementHighlight,
  });

  let canPick = true;
  let showHover = true;
  let active = true;
  const frames: Array<() => void> = [];

  const input = new CandidateInput({
    canvas,
    resolver,
    canPick: () => canPick,
    showHover: () => showHover,
    isActive: () => active,
    scheduleFrame: (cb) => frames.push(cb),
  });
  built.push(input);

  return {
    canvas,
    resolver,
    input,
    frames,
    runFrame: () => {
      const queued = frames.splice(0, frames.length);
      for (const cb of queued) cb();
    },
    measurementHighlight,
    setCanPick: (v) => {
      canPick = v;
    },
    setShowHover: (v) => {
      showHover = v;
    },
    setActive: (v) => {
      active = v;
    },
  };
}

function move(canvas: HTMLCanvasElement, x = 100, y = 100): void {
  canvas.dispatchEvent(
    new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }),
  );
}

function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe('CandidateInput — hover', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it('resolves and highlights on the frame after a pointer move', () => {
    move(h.canvas);
    expect(h.measurementHighlight).not.toHaveBeenCalled();

    h.runFrame();
    expect(h.resolver.count()).toBe(2);
    // The element wins by default, so the measurement is explicitly unlit.
    expect(h.measurementHighlight).toHaveBeenLastCalledWith(null);
  });

  it('resolves at most once per frame however many moves arrive', () => {
    move(h.canvas, 100, 100);
    move(h.canvas, 101, 100);
    move(h.canvas, 102, 100);
    expect(h.frames).toHaveLength(1);
  });

  it('does nothing while the hover setting is off (D10)', () => {
    h.setShowHover(false);
    move(h.canvas);
    expect(h.frames).toHaveLength(0);
  });

  it('stays dormant when there is nothing to arbitrate', () => {
    // No measurements placed → one candidate kind → the raycast never runs.
    h.setActive(false);
    move(h.canvas);
    expect(h.frames).toHaveLength(0);
  });

  it('stays dormant while a tool or pivot pick owns the pointer', () => {
    h.setCanPick(false);
    move(h.canvas);
    expect(h.frames).toHaveLength(0);
  });

  it('clears the highlight when the pointer leaves the canvas', () => {
    move(h.canvas);
    h.runFrame();
    h.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    expect(h.resolver.count()).toBe(0);
    expect(h.measurementHighlight).toHaveBeenLastCalledWith(null);
  });

  it('refresh() re-runs the hover without a pointer move', () => {
    move(h.canvas);
    h.runFrame();
    h.measurementHighlight.mockClear();

    h.input.refresh();
    expect(h.measurementHighlight).toHaveBeenCalled();
  });

  it('refresh() clears everything once the hover setting goes off', () => {
    move(h.canvas);
    h.runFrame();

    h.setShowHover(false);
    h.input.refresh();
    expect(h.resolver.count()).toBe(0);
    expect(h.measurementHighlight).toHaveBeenLastCalledWith(null);
  });
});

describe('CandidateInput — Tab cycling', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it('cycles to the next candidate when the pointer is over the canvas', () => {
    move(h.canvas);
    h.runFrame();
    expect(h.resolver.getActive()?.kind).toBe('element');

    const event = pressTab();
    expect(event.defaultPrevented).toBe(true);
    expect(h.resolver.getActive()?.kind).toBe('measurement');
  });

  it('cycles backwards with Shift+Tab', () => {
    move(h.canvas);
    h.runFrame();
    pressTab(true);
    expect(h.resolver.getActive()?.kind).toBe('measurement');
  });

  it('lights the newly active candidate', () => {
    move(h.canvas);
    h.runFrame();
    pressTab();
    expect(h.measurementHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'measurement' }),
    );
  });

  it('leaves Tab alone when focus is inside a real DOM control', () => {
    // Someone tabbing through the inspector or the model tree must not be
    // trapped just because the cursor happens to sit over the viewport.
    move(h.canvas);
    h.runFrame();

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    const event = pressTab();
    expect(event.defaultPrevented).toBe(false);
    expect(h.resolver.getActive()?.kind).toBe('element');
  });

  it('leaves Tab alone when the pointer is not over the canvas', () => {
    const event = pressTab();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves Tab alone after the pointer leaves the canvas', () => {
    move(h.canvas);
    h.runFrame();
    h.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    expect(pressTab().defaultPrevented).toBe(false);
  });

  it('leaves Tab alone when there is only one candidate to cycle', () => {
    const single = setup({ candidates: () => [element()] });
    move(single.canvas);
    single.runFrame();
    expect(pressTab().defaultPrevented).toBe(false);
  });

  it('leaves Tab alone while a tool or pivot pick owns the pointer', () => {
    move(h.canvas);
    h.runFrame();
    h.setCanPick(false);
    expect(pressTab().defaultPrevented).toBe(false);
  });

  it('leaves Ctrl/Alt/Meta+Tab to the browser', () => {
    move(h.canvas);
    h.runFrame();
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('cycles even with the hover pre-highlight switched off', () => {
    // The setting governs the display, not the picking: Tab and clicking must
    // keep working for anyone who finds the glow busy.
    h.setShowHover(false);
    move(h.canvas);
    expect(pressTab().defaultPrevented).toBe(true);
  });
});

describe('CandidateInput — click arbitration', () => {
  it('activeAt resolves at the click position and reports the winner', () => {
    const h = setup();
    expect(h.input.activeAt(100, 100)?.kind).toBe('element');
  });

  it('activeAt reports nothing while a tool owns the pointer', () => {
    const h = setup();
    h.setCanPick(false);
    expect(h.input.activeAt(100, 100)).toBeNull();
  });

  it('dispose detaches every listener', () => {
    const h = setup();
    h.input.dispose();
    move(h.canvas);
    expect(h.frames).toHaveLength(0);
    expect(pressTab().defaultPrevented).toBe(false);
  });
});
