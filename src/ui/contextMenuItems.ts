/**
 * Pure builder for the right-click menu's item list + the suppression guard.
 *
 * App is hard to test wholesale, so the menu's decision logic lives here as a
 * pure function of (selection state, appearance flags, action callbacks). The
 * menu acts ONLY on the current selection (CM2): no raycast, no hit-testing —
 * the verbs dispatch to collaborators (AppearanceManager / SelectionBasket)
 * scoped to whatever is selected.
 *
 * See dev/plans/handoff-context-menu.md.
 */

import type { MenuItem } from './ContextMenu';
import type { ElementIdentity, SelectionState } from '../inspector/types';

// Re-export so callers have a single import site for the menu's opacity
// constant alongside the builder. The source of truth is AppearanceManager.
export { TRANSPARENCY_OPACITY } from '../viewer/AppearanceManager';

/**
 * Callbacks the menu verbs dispatch to. Each acts on the CURRENT SELECTION
 * scope (the caller closes over the live selection); the menu never targets a
 * hit-tested element. `addToBasket` is M+ (add the selection to the basket).
 *
 * NOTE: "Select similar" is intentionally OMITTED this slice — it depends on
 * the unbuilt bulk-property feature (A). Seam only; do not add it here yet.
 */
export interface ContextMenuActions {
  hide: () => void;
  isolate: () => void;
  showAll: () => void;
  transparent: () => void;
  opaque: () => void;
  clearTransparency: () => void;
  addToBasket: () => void;
}

export interface AppearanceFlags {
  hasHidden: boolean;
  hasTransparent: boolean;
}

/**
 * Build the menu items for the current state, or `null` when no menu should
 * open (no selection AND no active recovery action — "menus only work for a
 * selection").
 *
 * - **Selection present** → header (single element line, or "N elements") +
 *   Hide / Isolate / Show all (disabled iff nothing hidden) | Make transparent
 *   / Make opaque (disabled iff nothing transparent) | Add to basket (M+).
 * - **No selection but something hidden/transparent** → recovery only: Show all
 *   (iff hidden) / Clear transparency (iff transparent).
 * - **No selection and nothing active** → `null`.
 */
export function buildContextMenuItems(
  state: SelectionState,
  flags: AppearanceFlags,
  actions: ContextMenuActions,
): MenuItem[] | null {
  if (state.kind === 'none') {
    return buildRecoveryOnly(flags, actions);
  }

  const items: MenuItem[] = [];

  // Header — the current selection (non-interactive; no onClick).
  items.push({ label: headerLabel(state) });
  items.push({ separator: true });

  // Visibility verbs.
  items.push({ label: 'Hide', onClick: actions.hide });
  items.push({ label: 'Isolate', onClick: actions.isolate });
  items.push({ label: 'Show all', onClick: actions.showAll, disabled: !flags.hasHidden });
  items.push({ separator: true });

  // Transparency verbs.
  items.push({ label: 'Make transparent', onClick: actions.transparent });
  items.push({ label: 'Make opaque', onClick: actions.opaque, disabled: !flags.hasTransparent });
  items.push({ separator: true });

  // Basket. ("Select similar ▸" goes here in a future slice — see header note.)
  items.push({ label: 'Add to basket (M+)', onClick: actions.addToBasket });

  return items;
}

/** Recovery-only menu for the no-selection case; null when nothing is active. */
function buildRecoveryOnly(flags: AppearanceFlags, actions: ContextMenuActions): MenuItem[] | null {
  if (!flags.hasHidden && !flags.hasTransparent) return null;
  const items: MenuItem[] = [];
  if (flags.hasHidden) {
    items.push({ label: 'Show all', onClick: actions.showAll });
  }
  if (flags.hasTransparent) {
    items.push({ label: 'Clear transparency', onClick: actions.clearTransparency });
  }
  return items;
}

/**
 * Header text: single element's class (· tag/name), or "N elements". Only
 * called from the selection-present branch, so `state` is single | multi.
 */
function headerLabel(state: Exclude<SelectionState, { kind: 'none' }>): string {
  if (state.kind === 'single') {
    return describeElement(state.identities[0]);
  }
  return `${state.identities.length} elements`;
}

function describeElement(id: ElementIdentity): string {
  const cls = id.ifcClass || 'Element';
  const detail = id.tag ?? id.name;
  return detail ? `${cls} · ${detail}` : cls;
}

/**
 * Whether the context menu should be SUPPRESSED for this right-click. We don't
 * fight a tool that owns the pointer (clipping / measurement — MeasurementTool
 * already binds contextmenu), nor open mid marquee-drag. App still calls
 * `preventDefault()` regardless; this only decides whether to OPEN the menu.
 */
export function shouldSuppressContextMenu(ctx: {
  toolActive: boolean;
  marqueeDragging: boolean;
}): boolean {
  return ctx.toolActive || ctx.marqueeDragging;
}
