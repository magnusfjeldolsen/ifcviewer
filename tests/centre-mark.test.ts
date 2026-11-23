// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CentreMark, TAG_REST_MS } from '../src/ui/CentreMark';
import { elementTagLabel } from '../src/inspector/elementLabel';

let anchor: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  anchor = document.createElement('div');
  anchor.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50, toJSON() {} }) as DOMRect;
  document.body.appendChild(anchor);
});

afterEach(() => {
  vi.useRealTimers();
});

const ringOn = (): boolean => !!document.querySelector('.centre-mark.on-target');

describe('CentreMark', () => {
  it('is hidden until shown, then sits on the centre of its anchor (not the window)', () => {
    const mark = new CentreMark(document.body, { anchor });
    const el = document.querySelector('.centre-mark') as HTMLElement;
    expect(el.hidden).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    mark.show();
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('500px');
    expect(el.style.top).toBe('350px');
  });

  it('is neutral over empty space and reacts on an element', () => {
    const mark = new CentreMark(document.body, { anchor });
    mark.show();
    expect(mark.state()).toEqual({ shown: true, onTarget: false, tag: null });
    mark.setTarget({ key: 'a' });
    expect(ringOn()).toBe(true);
    mark.setTarget(null);
    expect(ringOn()).toBe(false);
  });

  it('shows the name after resting on the same element, asking for it once', async () => {
    const mark = new CentreMark(document.body, { anchor });
    mark.show();
    const name = vi.fn(() => Promise.resolve('IfcSlab · Floor'));
    mark.setTarget({ key: 'a', name });
    vi.advanceTimersByTime(TAG_REST_MS - 10);
    mark.setTarget({ key: 'a', name }); // same element again: the rest is not restarted
    expect(name).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(name).toHaveBeenCalledTimes(1);
    expect(mark.state().tag).toBe('IfcSlab · Floor');
    expect((document.querySelector('.centre-mark-tag') as HTMLElement).hidden).toBe(false);
    mark.setTarget({ key: 'a', name });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS * 2);
    expect(name).toHaveBeenCalledTimes(1);
  });

  it('hides the tag at once on another element or empty space, and cancels a pending name', async () => {
    const mark = new CentreMark(document.body, { anchor });
    mark.show();
    mark.setTarget({ key: 'a', name: () => 'A' });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS + 1);
    expect(mark.state().tag).toBe('A');
    mark.setTarget({ key: 'b', name: () => 'B' });
    expect(mark.state().tag).toBeNull();
    let aborted = false;
    let finish!: (s: string) => void;
    mark.setTarget({
      key: 'c',
      name: (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          finish = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS + 1);
    mark.setTarget(null); // moved on before the name came back
    expect(aborted).toBe(true);
    finish('C');
    await vi.advanceTimersByTimeAsync(1);
    expect(mark.state().tag).toBeNull();
  });

  it('keeps the tag hidden while the view moves fast, and shows it once it slows', async () => {
    const mark = new CentreMark(document.body, { anchor });
    mark.show();
    const name = vi.fn(() => 'A');
    mark.setMoving(true);
    mark.setTarget({ key: 'a', name });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS * 3);
    expect(name).not.toHaveBeenCalled();
    mark.setMoving(false);
    await vi.advanceTimersByTimeAsync(TAG_REST_MS + 1);
    expect(mark.state().tag).toBe('A');
    mark.setMoving(true);
    expect(mark.state().tag).toBeNull();
  });

  it('the name tag can be switched off', async () => {
    const mark = new CentreMark(document.body, { anchor, showNameTag: false });
    mark.show();
    const name = vi.fn(() => 'A');
    mark.setTarget({ key: 'a', name });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS * 3);
    expect(name).not.toHaveBeenCalled();
    expect(ringOn()).toBe(true);
  });

  it('schedules nothing while hidden', async () => {
    const mark = new CentreMark(document.body, { anchor });
    const name = vi.fn(() => 'A');
    mark.setTarget({ key: 'a', name });
    await vi.advanceTimersByTimeAsync(TAG_REST_MS * 3);
    expect(name).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    mark.show();
    mark.hide();
    expect(mark.state()).toEqual({ shown: false, onTarget: false, tag: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('elementTagLabel', () => {
  it('reads class and type name', () => {
    expect(elementTagLabel({ modelId: 'm', expressId: 5, ifcClass: 'IfcSlab', ifcTypeCode: 1, typeName: 'Floor:GPG 120', name: 'x' })).toBe('IfcSlab · Floor:GPG 120');
  });

  it('falls back to the name, then the line number', () => {
    expect(elementTagLabel({ modelId: 'm', expressId: 5, ifcClass: 'IfcWall', ifcTypeCode: 1, name: 'Wall 1' })).toBe('IfcWall · Wall 1');
    expect(elementTagLabel({ modelId: 'm', expressId: 5, ifcClass: '', ifcTypeCode: 1 })).toBe('Element · #5');
  });
});
