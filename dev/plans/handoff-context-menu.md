# Plan — Right-click Context Menu

Implementation-ready plan. Branch `feature/context-menu` off `main`. Effort
**M**. The unifying interaction surface of `phase-scope-ops-and-undo.md`: a
real right-click menu over the viewport that hosts hide / isolate / show-all,
transparent / opaque, select-similar, and add-to-basket. Ships alongside
element-appearance (`handoff-element-appearance.md`), which provides most of
the verbs.

## Goal

Right-click an element (or a multi-selection) → a native-feeling menu at the
cursor with the actions that apply to that target. **Selection-aware**
(confirmed): right-clicking an element that's part of the current selection
acts on the whole selection; otherwise it acts on just that element.

## Behaviour

1. `contextmenu` event on the viewer canvas → `preventDefault()` (suppress the
   browser menu) → `raycastVisible(...)` (already in `src/utils/raycast.ts`)
   to resolve the element under the cursor.
2. **Target resolution (selection-aware, confirmed):**
   - Hit element **is in** the current selection → target = the whole selection
     (header: "N elements"); the selection is left as-is.
   - Hit element **is not** in the selection → **select it first** (replace the
     selection with this one element, CM2), then target = that element. This
     matches Explorer/Revit: right-clicking something not selected selects it,
     so you always act on what's highlighted and there's no "I right-clicked
     here but it acted there" surprise.
   - **Empty space** (no hit) → a reduced menu offering only the active global
     recovery actions (Show all, Clear transparency) if any state is active;
     otherwise no menu. (Does not clear the selection.)
3. Items (context-adaptive; greyed when N/A):

```
┌─────────────────────────────┐
│  3 elements                 │   ← header (target count / identity)
│ ─────────────────────────── │
│  Hide                       │
│  Isolate (hide others)      │
│  Show all            (N)    │   ← enabled only when something is hidden
│ ─────────────────────────── │
│  Make transparent           │
│  Make opaque                │   ← enabled only when something is transparent
│ ─────────────────────────── │
│  Select similar           ▸ │   ← single-element target only; needs A (bulk)
│  Add to basket        (M+)  │
└─────────────────────────────┘
```

4. Dismissal: outside-click, `Escape`, scroll/zoom, window blur, or after an
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

App builds the `MenuItem[]` from current state on each open (target + whether
anything is hidden/transparent + whether bulk-access is available), and wires
each `onClick` to the AppearanceManager / SelectionManager / SelectionBasket.

## Files

| File | Change |
|------|--------|
| `src/ui/ContextMenu.ts` | NEW — the generic positioned menu (items, submenu, clamp, dismissal). |
| `src/core/App.ts` | `contextmenu` listener on the canvas; raycast + selection-aware target; build items; dispatch to the relevant managers. |
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
- **Menu outlives target** — if the model is removed while the menu is open,
  close it.

## Test plan

**Automated** (jsdom):
- `tests/context-menu.test.ts` (NEW): builds the correct item set for a
  single-element target vs a multi-selection target vs empty-space; selection-
  aware target resolution (mock raycast: hit-in-selection → whole selection;
  hit-not-in-selection → single element, selection unchanged); item `onClick`
  dispatches the right callback; disabled items when the corresponding state is
  absent (Show all greyed when nothing hidden); `Escape` and outside-click
  close; menu clamps near a viewport edge.

**Manual smoke**:
1. Right-click an unselected element → menu shows that element; Hide works;
   the rest of the scene is untouched and the selection didn't change.
2. Marquee-select several → right-click one of them → header "N elements";
   Hide hides all of them.
3. Right-click empty space with something hidden → "Show all (N)" appears;
   clicking it restores.
4. Esc / click-away / scroll all dismiss the menu.
5. Menu near the right/bottom edge flips to stay on-screen.

## Open decisions

- **CM1 — empty-space right-click**: show a recovery-only menu (Show all /
  Clear transparency) when state is active vs. nothing. Recommend the
  recovery-only menu.
- **CM3 — extra items** (Properties / focus inspector, Zoom to selection):
  defer to v2.
- **CM4 — suppress during active tool** — recommend yes.

## Confirmed (build to these)

- **Selection-aware target** (user): right-click on a selected element acts on
  the whole selection; otherwise on the single clicked element.
- **CM2 — right-click selects the target first.** Right-clicking an element
  that isn't in the current selection replaces the selection with it before the
  menu acts (Explorer/Revit convention). An element already in a multi-selection
  keeps the whole selection.
