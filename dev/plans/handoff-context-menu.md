# Plan — Right-click Context Menu

Implementation-ready plan. Branch `feature/context-menu` off `main`. Effort
**M**. The unifying interaction surface of `phase-scope-ops-and-undo.md`: a
real right-click menu over the viewport that hosts hide / isolate / show-all,
transparent / opaque, select-similar, and add-to-basket. Ships alongside
element-appearance (`handoff-element-appearance.md`), which provides most of
the verbs.

## Goal

Right-click opens a menu of actions on the **current selection**. The menu
**never reads or changes the element under the cursor** — there is no
per-element targeting and no raycast. To act on something you select it first
(left-click / ctrl-click / marquee / MR), then right-click. One rule: *the menu
acts on what's selected.*

## Behaviour (CM2 — confirmed)

1. `contextmenu` event on the viewer canvas → `preventDefault()` (suppress the
   browser menu) → open the menu at the cursor. **No raycast**, no hit-testing.
2. **Target is always the current `SelectionManager` selection.** Right-clicking
   does not select, deselect, or otherwise touch the element under the cursor —
   right-clicking an unselected element opens the same menu, still scoped to the
   current selection. (To act directly on an element, left-click to select it
   first, then right-click.)
3. **The basket is reached via MR, not the menu.** The menu never targets the
   basket directly. To act on basket contents, **MR** (recall) first so they
   become the selection, then right-click. If a basket exists *and* the user
   has a separate live selection, the menu acts on the **live selection**.
4. Contents depend on the selection state:
   - **Selection present** → verbs acting on it (below). Header shows "N
     elements" (or the single element's class · tag).
   - **No selection** → only the active global recovery actions (Show all /
     Clear transparency) if any appearance state is active. If nothing is
     selected and no recovery action applies, **the menu does not open** —
     "menus only work for a selection".

```
┌─────────────────────────────┐
│  3 elements                 │   ← header = the current selection
│ ─────────────────────────── │
│  Hide                       │   ← acts on the selection
│  Isolate (hide others)      │
│  Show all            (N)    │   ← enabled only when something is hidden
│ ─────────────────────────── │
│  Make transparent           │
│  Make opaque                │   ← enabled only when something is transparent
│ ─────────────────────────── │
│  Select similar           ▸ │   ← only when exactly ONE element is selected; needs A (bulk)
│  Add to basket        (M+)  │   ← M+ : add the selection to the basket
└─────────────────────────────┘
```

5. Dismissal: outside-click, `Escape`, scroll/zoom, window blur, or after an
   item fires. Positioned at the cursor and **clamped to the viewport** (flip
   up/left near edges).

## The menu component

New generic `src/ui/ContextMenu.ts` — framework-free DOM, reused idiom from
`ContextualActions` styling (semi-transparent white, 8px radius, soft shadow):

```ts
interface MenuItem {
  label: string;
  onClick?: () => void;        // omit for a disabled/header item
  disabled?: boolean;
  submenu?: MenuItem[];        // e.g. Select similar ▸
  separator?: boolean;         // render a divider
}
class ContextMenu {
  open(x: number, y: number, items: MenuItem[]): void;
  close(): void;
  dispose(): void;
}
```

App builds the `MenuItem[]` from current state on each open — the current
selection (count / single vs multi) + whether anything is hidden/transparent +
whether bulk-access is available — and wires each `onClick` to the
AppearanceManager / SelectionManager / SelectionBasket. **No raycast** is
involved; the menu reads `SelectionManager.getState()`.

## Files

| File | Change |
|------|--------|
| `src/ui/ContextMenu.ts` | NEW — the generic positioned menu (items, submenu, clamp, dismissal). |
| `src/core/App.ts` | `contextmenu` listener on the canvas; build items from the current selection + appearance state; dispatch to the relevant managers. No raycast / no selection change. |
| `src/styles.css` | Menu styling (matches the panel/tray idiom); submenu flyout. |

## Edge cases

- **Active tool** (clipping / measurement): suppress the context menu while a
  tool owns the pointer, so right-click doesn't fight tool gestures. (Confirm
  whether any tool already uses right-drag.) Decision **CM4**.
- **Right-click during a marquee drag** → ignore (no menu).
- **Touch / long-press** → out of scope v1.
- **No `contextmenu` leak** — every code path that opens it calls
  `preventDefault()`; never trigger native dialogs (per the harness's dialog
  caveat — this is our own DOM, so fine).
- **Selection cleared while the menu is open** (e.g. model removed) → close it.

## Test plan

**Automated** (jsdom):
- `tests/context-menu.test.ts` (NEW): builds the correct item set for a
  single-element selection vs a multi-selection vs no selection (mock
  `SelectionManager.getState()`); right-click does **not** mutate the selection
  (no select/deselect on open); no menu opens when nothing is selected and no
  recovery action applies; "Select similar" present only for a single-element
  selection; item `onClick` dispatches the right callback; disabled items when
  the corresponding state is absent (Show all greyed when nothing hidden);
  `Escape` and outside-click close; menu clamps near a viewport edge.

**Manual smoke**:
1. Nothing selected → right-click → no menu (unless something is hidden/
   transparent → only the recovery action shows).
2. Select an element (left-click) → right-click → menu acts on it; Hide works.
3. Marquee-select several → right-click → header "N elements"; Hide hides all.
4. Build a basket, then start a different live selection → right-click acts on
   the live selection, not the basket. MR the basket → right-click now acts on
   the basket contents (they're the selection).
5. Right-click an *unselected* element while a selection exists elsewhere →
   menu still acts on the existing selection; the clicked element is untouched.
6. Esc / click-away / scroll dismiss; menu near an edge flips on-screen.

## Open decisions

- **CM1 — no-selection right-click**: show a recovery-only menu (Show all /
  Clear transparency) when appearance state is active vs. nothing. Recommend the
  recovery-only menu (and no menu at all when there's nothing to recover).
- **CM3 — extra items** (Properties / focus inspector, Zoom to selection):
  defer to v2.
- **CM4 — suppress during active tool** — recommend yes.

## Confirmed (build to these)

- **CM2 — the menu acts only on the current selection.** Right-click opens a
  menu scoped to whatever is selected and **does not read or change the element
  under the cursor** (no raycast, no select-on-right-click). To act on an
  element, select it first; to act on the basket, MR it into the selection
  first. With a basket *and* a separate live selection, the menu acts on the
  live selection. No selection (and no active recovery action) → no menu.
