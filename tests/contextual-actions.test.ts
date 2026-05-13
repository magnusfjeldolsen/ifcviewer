// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextualActions } from '../src/ui/ContextualActions';

describe('ContextualActions', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('renders the container but keeps it hidden when no actions are registered', () => {
    new ContextualActions(parent);
    const tray = parent.querySelector('.contextual-actions') as HTMLElement;
    expect(tray).not.toBeNull();
    expect(tray.hidden).toBe(true);
  });

  it('shows a button when a static action with isVisible: true is registered', () => {
    const tray = new ContextualActions(parent);
    tray.register({
      id: 'foo',
      label: 'Foo',
      icon: 'F',
      isVisible: () => true,
      onClick: () => {},
    });
    const trayEl = parent.querySelector('.contextual-actions') as HTMLElement;
    expect(trayEl.hidden).toBe(false);
    const btn = parent.querySelector('.contextual-action') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.dataset.actionId).toBe('foo');
    expect(btn.querySelector('.contextual-action-label')?.textContent).toBe('Foo');
    expect(btn.querySelector('.contextual-action-icon')?.textContent).toBe('F');
    expect(btn.hidden).toBe(false);
  });

  it('hides the button (and tray) when isVisible returns false', () => {
    const tray = new ContextualActions(parent);
    tray.register({
      id: 'foo',
      label: 'Foo',
      icon: 'F',
      isVisible: () => false,
      onClick: () => {},
    });
    const trayEl = parent.querySelector('.contextual-actions') as HTMLElement;
    const btn = parent.querySelector('.contextual-action') as HTMLButtonElement;
    expect(btn.hidden).toBe(true);
    expect(trayEl.hidden).toBe(true);
  });

  it('refreshes visibility when the subscribed source fires', () => {
    const tray = new ContextualActions(parent);
    let visible = false;
    let refreshHook: (() => void) | null = null;
    tray.register({
      id: 'foo',
      label: 'Foo',
      icon: 'F',
      isVisible: () => visible,
      onClick: () => {},
      subscribe: (refresh) => {
        refreshHook = refresh;
        return () => {
          refreshHook = null;
        };
      },
    });

    const btn = parent.querySelector('.contextual-action') as HTMLButtonElement;
    expect(btn.hidden).toBe(true);

    visible = true;
    refreshHook!();
    expect(btn.hidden).toBe(false);

    visible = false;
    refreshHook!();
    expect(btn.hidden).toBe(true);
  });

  it('invokes onClick when the button is clicked', () => {
    const tray = new ContextualActions(parent);
    const onClick = vi.fn();
    tray.register({
      id: 'foo',
      label: 'Foo',
      icon: 'F',
      isVisible: () => true,
      onClick,
    });
    const btn = parent.querySelector('.contextual-action') as HTMLButtonElement;
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('register() returns an unsubscribe that removes the button and unhooks the subscription', () => {
    const tray = new ContextualActions(parent);
    const unsubscribeSpy = vi.fn();
    const off = tray.register({
      id: 'foo',
      label: 'Foo',
      icon: 'F',
      isVisible: () => true,
      onClick: () => {},
      subscribe: () => unsubscribeSpy,
    });

    expect(parent.querySelector('.contextual-action')).not.toBeNull();

    off();

    expect(parent.querySelector('.contextual-action')).toBeNull();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    const trayEl = parent.querySelector('.contextual-actions') as HTMLElement;
    expect(trayEl.hidden).toBe(true);
  });

  it('dispose() removes the tray container and unhooks all subscriptions', () => {
    const tray = new ContextualActions(parent);
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    tray.register({
      id: 'a',
      label: 'A',
      icon: 'A',
      isVisible: () => true,
      onClick: () => {},
      subscribe: () => unsubA,
    });
    tray.register({
      id: 'b',
      label: 'B',
      icon: 'B',
      isVisible: () => true,
      onClick: () => {},
      subscribe: () => unsubB,
    });

    expect(parent.querySelector('.contextual-actions')).not.toBeNull();

    tray.dispose();

    expect(parent.querySelector('.contextual-actions')).toBeNull();
    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).toHaveBeenCalledTimes(1);
  });

  it('with two actions, renders only the visible one and updates correctly on refresh', () => {
    const tray = new ContextualActions(parent);
    let aVisible = true;
    let bVisible = false;
    let refreshA: (() => void) | null = null;
    let refreshB: (() => void) | null = null;

    tray.register({
      id: 'a',
      label: 'A',
      icon: 'A',
      isVisible: () => aVisible,
      onClick: () => {},
      subscribe: (r) => {
        refreshA = r;
        return () => {};
      },
    });
    tray.register({
      id: 'b',
      label: 'B',
      icon: 'B',
      isVisible: () => bVisible,
      onClick: () => {},
      subscribe: (r) => {
        refreshB = r;
        return () => {};
      },
    });

    const btnA = parent.querySelector('[data-action-id="a"]') as HTMLButtonElement;
    const btnB = parent.querySelector('[data-action-id="b"]') as HTMLButtonElement;
    expect(btnA.hidden).toBe(false);
    expect(btnB.hidden).toBe(true);

    aVisible = false;
    bVisible = true;
    refreshA!(); // either refresh recomputes both
    expect(btnA.hidden).toBe(true);
    expect(btnB.hidden).toBe(false);

    // Trigger via B's source — same result.
    aVisible = true;
    refreshB!();
    expect(btnA.hidden).toBe(false);
    expect(btnB.hidden).toBe(false);
  });

  it('renders buttons in registration order (stable layout)', () => {
    const tray = new ContextualActions(parent);
    tray.register({
      id: 'first',
      label: 'First',
      icon: '1',
      isVisible: () => true,
      onClick: () => {},
    });
    tray.register({
      id: 'second',
      label: 'Second',
      icon: '2',
      isVisible: () => true,
      onClick: () => {},
    });
    tray.register({
      id: 'third',
      label: 'Third',
      icon: '3',
      isVisible: () => true,
      onClick: () => {},
    });

    const btns = Array.from(
      parent.querySelectorAll('.contextual-action'),
    ) as HTMLButtonElement[];
    expect(btns.map((b) => b.dataset.actionId)).toEqual(['first', 'second', 'third']);
  });
});
