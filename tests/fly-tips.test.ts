// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlyTips, formatFlySpeed, looksTouchOnly } from '../src/ui/FlyTips';
import { Toolbar } from '../src/ui/Toolbar';
import { ToolManager, type Tool } from '../src/tools/Tool';

describe('formatFlySpeed', () => {
  it('shows tidy speeds tidily, in metres per second', () => {
    expect(formatFlySpeed(5)).toBe('5 m/s');
    expect(formatFlySpeed(50)).toBe('50 m/s');
    expect(formatFlySpeed(0.75)).toBe('0.75 m/s');
    expect(formatFlySpeed(0.5)).toBe('0.5 m/s');
  });
});

describe('FlyTips', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('is hidden until flying starts, and lists every fly key', () => {
    const tips = new FlyTips(parent, 5);
    expect(tips.isShown()).toBe(false);
    tips.show();
    expect(tips.isShown()).toBe(true);
    const text = parent.textContent ?? '';
    for (const k of ['W A S D', 'E / Q', '← →', '↑ ↓', 'Move it to look', 'Selects what is under the ring', 'Menu (leaves flying)', 'X / Z', 'Shift', 'Space', 'Hide or show these keys', 'Leaves flying']) {
      expect(text).toContain(k);
    }
    expect(text).toContain('5 m/s');
  });

  it('shows the speed as it changes', () => {
    const tips = new FlyTips(parent, 5);
    tips.setSpeed(7);
    expect(parent.querySelector('.fly-tips-speed')?.textContent).toBe('7 m/s');
  });

  it('collapses to the speed alone and remembers that', () => {
    const tips = new FlyTips(parent, 5);
    (parent.querySelector('.fly-tips-toggle') as HTMLButtonElement).click();
    expect(tips.isCollapsed()).toBe(true);
    expect((parent.querySelector('.fly-tips-list') as HTMLElement).hidden).toBe(true);
    expect(parent.querySelector('.fly-tips-speed')?.textContent).toBe('5 m/s');
    tips.dispose();
    const again = new FlyTips(parent, 5);
    expect(again.isCollapsed()).toBe(true);
  });

  it('works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const tips = new FlyTips(parent, 5);
    expect(tips.isCollapsed()).toBe(false);
    tips.setCollapsed(true);
    expect(tips.isCollapsed()).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('Toolbar mode buttons', () => {
  const tool = (name: string): Tool => ({ name, activate() {}, deactivate() {}, dispose() {} });

  it('runs the action without aborting the active tool, and keeps its own pressed state', () => {
    document.body.innerHTML = '';
    const tm = new ToolManager();
    tm.register(tool('measurement'));
    const bar = new Toolbar(document.body, tm);
    bar.addButton({ name: 'measurement', icon: 'M', title: 'Measure' });
    const action = vi.fn();
    bar.addButton({ name: 'fly', icon: 'F', title: 'Fly', toggle: true, onClick: action });
    const flyBtn = document.querySelectorAll<HTMLButtonElement>('.toolbar-btn')[1];

    tm.activate('measurement');
    flyBtn.click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(tm.isActive('measurement')).toBe(true);

    bar.setPressed('fly', true);
    expect(flyBtn.classList.contains('active')).toBe(true);
    expect(flyBtn.getAttribute('aria-pressed')).toBe('true');
    // A tool change does not clear the mode's pressed state.
    tm.abort();
    expect(flyBtn.classList.contains('active')).toBe(true);
    bar.setPressed('fly', false);
    expect(flyBtn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('FlyTips — screen readers', () => {
  it('announces only the speed, politely', () => {
    document.body.innerHTML = '';
    new FlyTips(document.body, 5);
    const el = document.querySelector('.fly-tips') as HTMLElement;
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-live')).toBeNull();
    const speed = document.querySelector('.fly-tips-speed') as HTMLElement;
    expect(speed.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelectorAll('[aria-live], [role="status"]').length).toBe(1);
  });
});

describe('looksTouchOnly', () => {
  const media = (fine: boolean, coarse: boolean) => ({
    matchMedia: (q: string) => ({ matches: q.includes('fine') ? fine : q.includes('coarse') ? coarse : false }) as MediaQueryList,
  });

  it('is true only with a coarse pointer and no fine one', () => {
    expect(looksTouchOnly(media(false, true))).toBe(true);
    expect(looksTouchOnly(media(true, true))).toBe(false); // touch laptop with a trackpad
    expect(looksTouchOnly(media(true, false))).toBe(false);
  });

  it('is false where media queries are unavailable', () => {
    expect(looksTouchOnly({} as Pick<Window, 'matchMedia'>)).toBe(false);
    expect(looksTouchOnly(undefined)).toBe(false);
  });
});

describe('Toolbar — hiding a button', () => {
  it('hides and shows a button by name', () => {
    document.body.innerHTML = '';
    const bar = new Toolbar(document.body, new ToolManager());
    bar.addButton({ name: 'fly', icon: 'F', title: 'Fly', toggle: true, onClick: () => {} });
    const btn = document.querySelector('.toolbar-btn') as HTMLButtonElement;
    bar.setHidden('fly', true);
    expect(btn.hidden).toBe(true);
    bar.setHidden('fly', false);
    expect(btn.hidden).toBe(false);
  });

  it('a mode button gives up focus after a click, so Space cannot press it again', () => {
    document.body.innerHTML = '';
    const bar = new Toolbar(document.body, new ToolManager());
    const action = vi.fn();
    bar.addButton({ name: 'fly', icon: 'F', title: 'Fly', toggle: true, onClick: action });
    const btn = document.querySelector('.toolbar-btn') as HTMLButtonElement;
    btn.focus();
    btn.click();
    expect(action).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(btn);
  });
});

describe('FlyTips — captured mouse or drag-to-look', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('says how to look in each case', () => {
    const tips = new FlyTips(document.body, 5);
    tips.setLook('drag');
    expect(document.body.textContent).toContain('Drag to look (click the view to capture the mouse)');
    expect(document.body.textContent).not.toContain('under the ring');
    tips.setLook('mouse');
    expect(document.body.textContent).toContain('Move it to look');
    expect(document.body.textContent).toContain('Selects what is under the ring');
  });

  it('H folds and unfolds without the mouse', () => {
    const tips = new FlyTips(document.body, 5);
    tips.toggleCollapsed();
    expect(tips.isCollapsed()).toBe(true);
    tips.toggleCollapsed();
    expect(tips.isCollapsed()).toBe(false);
  });
});