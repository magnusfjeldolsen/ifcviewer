// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextMenu } from '../src/ui/ContextMenu';
import type { MenuItem } from '../src/ui/ContextMenu';
import {
  buildContextMenuItems,
  shouldSuppressContextMenu,
  TRANSPARENCY_OPACITY,
} from '../src/ui/contextMenuItems';
import type { ContextMenuActions } from '../src/ui/contextMenuItems';
import type { ElementIdentity, SelectionState } from '../src/inspector/types';
import appSrc from '../src/core/App.ts?raw';

// ── ContextMenu component (T21-T25) ───────────────────────────────────

describe('ContextMenu component', () => {
  let parent: HTMLElement;
  let menu: ContextMenu;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
    menu = new ContextMenu(parent);
    // jsdom has no layout; give the menu element a measurable size so the
    // clamp logic has dimensions to work with.
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  });

  afterEach(() => {
    menu.dispose();
    document.body.innerHTML = '';
  });

  function menuEl(): HTMLElement {
    return parent.querySelector('.context-menu') as HTMLElement;
  }

  it('T21: open renders one row per item; separators render dividers; disabled rows get a disabled class + no handler; header (no onClick) is non-interactive', () => {
    const onClick = vi.fn();
    const items: MenuItem[] = [
      { label: '3 elements' }, // header (no onClick)
      { separator: true },
      { label: 'Hide', onClick },
      { label: 'Show all', onClick: () => {}, disabled: true },
    ];
    menu.open(100, 100, items);

    const root = menuEl();
    expect(root).not.toBeNull();
    const rows = root.querySelectorAll('.context-menu-item');
    expect(rows).toHaveLength(3); // header + 2 verbs (separator is not an item row)
    expect(root.querySelectorAll('.context-menu-separator')).toHaveLength(1);

    // Header is non-interactive (own class, clicking does nothing / no close).
    const header = rows[0] as HTMLElement;
    expect(header.classList.contains('context-menu-header')).toBe(true);
    header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menuEl()).not.toBeNull(); // still open

    // Disabled row has the disabled class.
    const showAll = rows[2] as HTMLElement;
    expect(showAll.classList.contains('disabled')).toBe(true);
  });

  it('T22: clicking an enabled item fires onClick once AND closes; a disabled item does nothing', () => {
    const enabled = vi.fn();
    const disabled = vi.fn();
    menu.open(50, 50, [
      { label: 'Hide', onClick: enabled },
      { label: 'Show all', onClick: disabled, disabled: true },
    ]);

    const rows = menuEl().querySelectorAll('.context-menu-item');
    // Disabled first: nothing happens, menu stays open.
    (rows[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(disabled).not.toHaveBeenCalled();
    expect(menuEl()).not.toBeNull();

    // Enabled: fires once and closes.
    (rows[0] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(menuEl()).toBeNull();
  });

  it('T23: Escape / outside-click / scroll / window blur each close; a click inside does not dismiss', () => {
    const open = (): void => menu.open(50, 50, [{ label: 'Hide', onClick: () => {} }]);

    // Escape
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menuEl()).toBeNull();

    // Outside-click (pointerdown on the document, outside the menu)
    open();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menuEl()).toBeNull();

    // Scroll
    open();
    window.dispatchEvent(new Event('scroll'));
    expect(menuEl()).toBeNull();

    // Window blur
    open();
    window.dispatchEvent(new Event('blur'));
    expect(menuEl()).toBeNull();

    // Click INSIDE the menu (but not on an item) does NOT dismiss.
    open();
    menuEl().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menuEl()).not.toBeNull();
  });

  it('T24: clamp — near the right/bottom edge it flips to stay in the viewport; with room it places at (x,y)', () => {
    // Give the menu measurable dimensions via offsetWidth/Height stubs.
    const setSize = (w: number, h: number): void => {
      const root = menuEl();
      Object.defineProperty(root, 'offsetWidth', { value: w, configurable: true });
      Object.defineProperty(root, 'offsetHeight', { value: h, configurable: true });
      menu.reposition(); // re-run clamp now that we have dimensions
    };

    // With room: places at (x, y).
    menu.open(100, 120, [{ label: 'Hide', onClick: () => {} }]);
    setSize(200, 150);
    expect(menuEl().style.left).toBe('100px');
    expect(menuEl().style.top).toBe('120px');

    // Near the right/bottom edge (viewport 1000×800): flips so it stays in.
    menu.open(950, 760, [{ label: 'Hide', onClick: () => {} }]);
    setSize(200, 150);
    const left = parseFloat(menuEl().style.left);
    const top = parseFloat(menuEl().style.top);
    expect(left + 200).toBeLessThanOrEqual(1000);
    expect(top + 150).toBeLessThanOrEqual(800);
  });

  it('T25: dispose removes the element + all global listeners; idempotent when already closed', () => {
    menu.open(10, 10, [{ label: 'Hide', onClick: () => {} }]);
    expect(menuEl()).not.toBeNull();

    menu.dispose();
    expect(menuEl()).toBeNull();

    // A global Escape after dispose must not throw or revive anything.
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();

    // dispose again (already closed) is a safe no-op.
    expect(() => menu.dispose()).not.toThrow();
  });
});

// ── buildContextMenuItems pure helper (T26-T31) ────────────────────────

describe('buildContextMenuItems', () => {
  function identity(modelId: string, expressId: number): ElementIdentity {
    return { modelId, expressId, ifcClass: 'IfcWall', ifcTypeCode: 0 };
  }
  function singleState(): SelectionState {
    return { kind: 'single', identities: [identity('A', 1)] };
  }
  function multiState(n: number): SelectionState {
    return {
      kind: 'multi',
      identities: Array.from({ length: n }, (_, i) => identity('A', i + 1)),
      lockedModelId: 'A',
    };
  }
  function noneState(): SelectionState {
    return { kind: 'none' };
  }
  function makeActions(): ContextMenuActions & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      hide: () => calls.push('hide'),
      isolate: () => calls.push('isolate'),
      showAll: () => calls.push('showAll'),
      transparent: () => calls.push('transparent'),
      opaque: () => calls.push('opaque'),
      clearTransparency: () => calls.push('clearTransparency'),
      addToBasket: () => calls.push('addToBasket'),
      selectSimilarCategory: () => calls.push('selectSimilarCategory'),
      selectSimilarType: () => calls.push('selectSimilarType'),
    };
  }

  /** Labels of the interactive (onClick) verb rows, in order. */
  function verbLabels(items: MenuItem[]): string[] {
    return items
      .filter((i) => i.onClick && !i.separator)
      .map((i) => i.label ?? '');
  }

  it('T26: SINGLE selection → element-line header; verbs Hide, Isolate, Show all, Make transparent, Make opaque, Select all <class>, Add to basket (M+)', () => {
    const items = buildContextMenuItems(singleState(), { hasHidden: true, hasTransparent: true }, makeActions())!;
    expect(items).not.toBeNull();
    // First item is a header (no onClick).
    expect(items[0].onClick).toBeUndefined();
    const verbs = verbLabels(items);
    expect(verbs).toContain('Hide');
    expect(verbs).toContain('Isolate');
    expect(verbs).toContain('Show all');
    expect(verbs).toContain('Make transparent');
    expect(verbs).toContain('Make opaque');
    expect(verbs.some((v) => /add to basket/i.test(v))).toBe(true);
    // Select-similar's category option, named after the element's own
    // category so the row says what it will do.
    expect(verbs.some((v) => /this category · IfcWall/.test(v))).toBe(true);
  });

  it('T26b: the category option dispatches selectSimilarCategory', () => {
    const actions = makeActions();
    const items = buildContextMenuItems(singleState(), { hasHidden: false, hasTransparent: false }, actions)!;
    items.find((i) => /this category/.test(i.label ?? ''))!.onClick!();
    expect(actions.calls).toEqual(['selectSimilarCategory']);
  });

  it('T26c: category and type are separate options at their own grain', () => {
    // "every beam" and "every beam of this section" are different questions;
    // the menu answers both rather than picking one.
    const state: SelectionState = {
      kind: 'single',
      identities: [
        {
          modelId: 'A',
          expressId: 1,
          ifcClass: 'IfcBeam',
          ifcTypeCode: 7,
          objectType: 'SHS (EN 10210-2):SHS100x6.3',
        },
      ],
    };
    const actions = makeActions();
    const items = buildContextMenuItems(state, { hasHidden: false, hasTransparent: false }, actions)!;

    const category = items.find((i) => /this category/.test(i.label ?? ''));
    const type = items.find((i) => /this type/.test(i.label ?? ''));
    expect(category!.label).toBe('Select all of this category · IfcBeam');
    expect(type!.label).toBe('Select all of this type · SHS (EN 10210-2):SHS100x6.3');

    type!.onClick!();
    expect(actions.calls).toEqual(['selectSimilarType']);
  });

  it('T26d: no type option when the element declares no ObjectType', () => {
    // A row that could only ever find nothing is worse than no row.
    const items = buildContextMenuItems(singleState(), { hasHidden: false, hasTransparent: false }, makeActions())!;
    expect(items.some((i) => /this type/.test(i.label ?? ''))).toBe(false);
  });

  it('T26e: a long type name is elided so the menu keeps its width', () => {
    const state: SelectionState = {
      kind: 'single',
      identities: [
        {
          modelId: 'A',
          expressId: 1,
          ifcClass: 'IfcBeam',
          ifcTypeCode: 7,
          objectType: 'Dekkeelement skrå 280 med lang beskrivelse:2345x280',
        },
      ],
    };
    const items = buildContextMenuItems(state, { hasHidden: false, hasTransparent: false }, makeActions())!;
    const type = items.find((i) => /this type/.test(i.label ?? ''))!;
    expect(type.label!.endsWith('…')).toBe(true);
    expect(type.label!.length).toBeLessThan(70);
  });

  it('T27: MULTI selection → header "N elements"; same verbs, but NO class preset', () => {
    // A multi-selection can span classes, so "select all of this class" has
    // no referent — offering it would have to pick one arbitrarily.
    const items = buildContextMenuItems(multiState(3), { hasHidden: true, hasTransparent: true }, makeActions())!;
    expect(items[0].label).toMatch(/3 elements/);
    const verbs = verbLabels(items);
    expect(verbs).toEqual(
      expect.arrayContaining(['Hide', 'Isolate', 'Show all', 'Make transparent', 'Make opaque']),
    );
    expect(verbs.some((v) => /this category|this type/.test(v))).toBe(false);
  });

  it('T28: "Show all" disabled iff nothing hidden; "Make opaque" disabled iff nothing transparent', () => {
    const findItem = (items: MenuItem[], re: RegExp): MenuItem | undefined =>
      items.find((i) => re.test(i.label ?? ''));

    // Nothing hidden, nothing transparent.
    let items = buildContextMenuItems(singleState(), { hasHidden: false, hasTransparent: false }, makeActions())!;
    expect(findItem(items, /show all/i)!.disabled).toBe(true);
    expect(findItem(items, /make opaque/i)!.disabled).toBe(true);

    // Something hidden + something transparent → both enabled.
    items = buildContextMenuItems(singleState(), { hasHidden: true, hasTransparent: true }, makeActions())!;
    expect(findItem(items, /show all/i)!.disabled).toBeFalsy();
    expect(findItem(items, /make opaque/i)!.disabled).toBeFalsy();
  });

  it('T29: NO selection + something hidden/transparent → ONLY recovery actions (Show all / Clear transparency), each enabled per active state', () => {
    // Only hidden active.
    let items = buildContextMenuItems(noneState(), { hasHidden: true, hasTransparent: false }, makeActions())!;
    expect(items).not.toBeNull();
    const verbs = verbLabels(items);
    expect(verbs.some((v) => /show all/i.test(v))).toBe(true);
    // No selection verbs (Hide / Isolate / transparent) at all.
    expect(verbs.some((v) => /^hide$/i.test(v))).toBe(false);
    expect(verbs.some((v) => /isolate/i.test(v))).toBe(false);
    expect(verbs.some((v) => /make transparent/i.test(v))).toBe(false);
    // Clear transparency present only if transparent active — here it isn't.
    expect(verbs.some((v) => /clear transparency/i.test(v))).toBe(false);

    // Only transparent active.
    items = buildContextMenuItems(noneState(), { hasHidden: false, hasTransparent: true }, makeActions())!;
    const verbs2 = verbLabels(items);
    expect(verbs2.some((v) => /clear transparency/i.test(v))).toBe(true);
    expect(verbs2.some((v) => /show all/i.test(v))).toBe(false);
  });

  it('T30: NO selection AND nothing hidden/transparent → returns null/[] sentinel (do NOT open the menu)', () => {
    const items = buildContextMenuItems(noneState(), { hasHidden: false, hasTransparent: false }, makeActions());
    expect(items === null || (Array.isArray(items) && items.length === 0)).toBe(true);
  });

  it('T31: each verb onClick dispatches to the right collaborator (on the CURRENT SELECTION scope)', () => {
    const actions = makeActions();
    const items = buildContextMenuItems(multiState(2), { hasHidden: true, hasTransparent: true }, actions)!;
    const click = (re: RegExp): void => {
      const item = items.find((i) => i.onClick && re.test(i.label ?? ''));
      expect(item, `menu item ${re}`).toBeDefined();
      item!.onClick!();
    };

    click(/^hide$/i);
    click(/isolate/i);
    click(/show all/i);
    click(/make transparent/i);
    click(/make opaque/i);
    click(/add to basket/i);

    expect(actions.calls).toEqual([
      'hide',
      'isolate',
      'showAll',
      'transparent',
      'opaque',
      'addToBasket',
    ]);
  });

  it('exposes the named transparency-opacity constant (A3 = 0.25)', () => {
    expect(TRANSPARENCY_OPACITY).toBeCloseTo(0.25);
  });
});

// ── App contextmenu handler guard (T32) ────────────────────────────────

describe('shouldSuppressContextMenu (T32 guard)', () => {
  it('suppresses the menu while a tool owns the pointer or a marquee drag is in progress', () => {
    expect(shouldSuppressContextMenu({ toolActive: true, marqueeDragging: false })).toBe(true);
    expect(shouldSuppressContextMenu({ toolActive: false, marqueeDragging: true })).toBe(true);
    expect(shouldSuppressContextMenu({ toolActive: true, marqueeDragging: true })).toBe(true);
    expect(shouldSuppressContextMenu({ toolActive: false, marqueeDragging: false })).toBe(false);
  });
});

describe('App contextmenu wiring (T32 — source assertions)', () => {
  it('the contextmenu handler calls preventDefault', () => {
    // The canvas listener is wired, and the handler suppresses the native
    // browser menu on every path.
    expect(appSrc).toMatch(/addEventListener\(\s*['"]contextmenu['"]/);
    const handler = appSrc.match(/private onContextMenu\([\s\S]*?\n {2}\}/);
    expect(handler).not.toBeNull();
    expect(handler![0]).toMatch(/preventDefault\(\)/);
  });

  it('the contextmenu handler does NOT call any selection-mutating method (no raycast, no select-on-right-click)', () => {
    // Per CM2: the menu reads SelectionManager.getState() only; it never
    // applies/clears selection or raycasts on right-click. The handler
    // delegates to openContextMenu (which awaits the enriched identity), so
    // the invariant spans both.
    const handler = appSrc.match(/private onContextMenu\([\s\S]*?\n {2}\}/);
    const opener = appSrc.match(/private async openContextMenu\([\s\S]*?\n {2}\}/);
    expect(handler).not.toBeNull();
    expect(opener).not.toBeNull();
    const body = handler![0] + opener![0];
    expect(body).not.toMatch(/\.apply\(/);
    expect(body).not.toMatch(/\.applyMany\(/);
    expect(body).not.toMatch(/\.selectExactly\(/);
    expect(body).not.toMatch(/raycast/i);
    // It DOES read the current selection state to build the menu.
    expect(body).toMatch(/getState\(\)/);
  });

  it('the menu is built from an ENRICHED identity, not the selection placeholder', () => {
    // SelectionManager stores ifcClass:'' / ifcTypeCode:0 placeholders. Built
    // straight off those, "select all of this category" enumerated type code
    // 0 and matched nothing ("No elements match all elements"), and the type
    // row could never appear.
    const opener = appSrc.match(/private async openContextMenu\([\s\S]*?\n {2}\}/);
    expect(opener![0]).toMatch(/enrichSelection\(/);
    const enrich = appSrc.match(/private async enrichSelection\([\s\S]*?\n {2}\}/);
    expect(enrich).not.toBeNull();
    expect(enrich![0]).toMatch(/propertyRepository\.get\(/);
  });

  it('the contextmenu handler bails via the suppression guard', () => {
    const handler = appSrc.match(/private onContextMenu\([\s\S]*?\n {2}\}/);
    expect(handler![0]).toMatch(/shouldSuppressContextMenu/);
  });
});
