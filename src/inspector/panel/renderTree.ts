/**
 * Tree-view rendering for the InspectorPanel.
 *
 * Builds the four top-level collapsible sections (Identity, Property Sets,
 * Quantities, Materials), with nested per-group collapsibles for psets/qtos
 * and recursive `IfcComplexProperty` rendering inside each. Leaf rows
 * carry a clickable value pill (copy-to-clipboard) and an optional unit
 * pill; type-inherited rows get a "from type" badge.
 *
 * Pure: takes the target body element, the props, and a context object
 * carrying panel-owned callbacks. No closure over the panel instance.
 *
 * Split out of `InspectorPanel.ts` so the tree renderer has its own
 * file. No behavior change.
 */

import type {
  ElementProperties,
  PropertyGroup,
  PropertyNode,
  PropertyValue,
} from '../types';
import { displayStringForValue } from '../repository/flatRows';

/** Max nesting depth before complex properties flatten with a "…" prefix. */
const MAX_COMPLEX_DEPTH = 6;

/** Truncate `s` to `n` chars with an ellipsis. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/** Tree-view row count for one group: leaves only (complex props recurse). */
function groupLeafCount(group: PropertyGroup): number {
  let n = 0;
  const walk = (nodes: PropertyNode[]): void => {
    for (const node of nodes) {
      if (node.value.kind === 'complex') walk(node.value.children);
      else n++;
    }
  };
  walk(group.properties);
  return n;
}

/**
 * Dependencies the tree renderer pulls from the panel. Passed explicitly
 * rather than closed-over so this module stays a free function.
 */
export interface TreeRenderContext {
  /** Truncate values longer than this in display; tooltip carries full text. */
  valueTruncateAt: number;
  /** Copy `text` to clipboard, then briefly flash `el`. */
  copyWithFlash: (el: HTMLElement, text: string) => void;
  /**
   * Build the multi-line tooltip text for a varies-row at the given
   * flat-path. Returns the literal string "varies" if no distinct map
   * is available. Panel-owned because it reaches into `currentProps`.
   */
  formatVariesTooltip: (path: string) => string;
  /** Whether the panel currently has props rendered (gates varies tooltip lookup). */
  hasCurrentProps: () => boolean;
}

export function renderTree(
  target: HTMLElement,
  props: ElementProperties,
  ctx: TreeRenderContext,
): void {
  // Identity section (only if any identity rows exist).
  if (props.direct.length > 0) {
    target.appendChild(buildSection('Identity', props.direct.length, () => {
      const container = document.createElement('div');
      container.className = 'inspector-rows';
      for (const node of props.direct) {
        // Direct rows live at path "Identity.<key>" in the flat array.
        container.appendChild(buildPropertyRow(node, 0, 'Identity', ctx));
      }
      return container;
    }));
  }

  // Property Sets (each pset is itself a nested collapsible).
  if (props.psets.length > 0) {
    const header = `Property Sets`;
    const total = props.psets.reduce((n, g) => n + groupLeafCount(g), 0);
    target.appendChild(buildSection(header, total, () => {
      const container = document.createElement('div');
      container.className = 'inspector-group-list';
      for (const group of props.psets) {
        container.appendChild(buildGroup(group, ctx));
      }
      return container;
    }));
  }

  // Quantities
  if (props.qtos.length > 0) {
    const total = props.qtos.reduce((n, g) => n + groupLeafCount(g), 0);
    target.appendChild(buildSection('Quantities', total, () => {
      const container = document.createElement('div');
      container.className = 'inspector-group-list';
      for (const group of props.qtos) {
        container.appendChild(buildGroup(group, ctx));
      }
      return container;
    }));
  }

  // Materials
  if (props.materials.length > 0) {
    target.appendChild(buildSection('Materials', props.materials.length, () => {
      const container = document.createElement('div');
      container.className = 'inspector-rows';
      for (const mat of props.materials) {
        const row = document.createElement('div');
        row.className = 'inspector-row';
        const name = document.createElement('span');
        name.className = 'inspector-row-name';
        if (mat.kind === 'material-ref') {
          name.textContent = mat.materialName;
        } else {
          name.textContent = displayStringForValue(mat);
        }
        row.appendChild(name);
        container.appendChild(row);
      }
      return container;
    }));
  }

  if (target.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'inspector-empty';
    empty.textContent = 'No properties available.';
    target.appendChild(empty);
  }
}

/** A top-level collapsible section with row-count badge. */
function buildSection(
  title: string,
  rowCount: number,
  bodyFactory: () => HTMLElement,
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'inspector-section';
  const head = document.createElement('button');
  head.className = 'inspector-section-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  const caret = document.createElement('span');
  caret.className = 'inspector-caret';
  caret.textContent = '▾'; // ▾
  const label = document.createElement('span');
  label.className = 'inspector-section-label';
  label.textContent = title;
  const count = document.createElement('span');
  count.className = 'inspector-section-count';
  count.textContent = String(rowCount);
  head.appendChild(caret);
  head.appendChild(label);
  head.appendChild(count);

  const body = document.createElement('div');
  body.className = 'inspector-section-body';
  body.appendChild(bodyFactory());

  head.addEventListener('click', () => {
    const expanded = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.style.display = expanded ? 'none' : '';
    caret.textContent = expanded ? '▸' : '▾'; // ▸ / ▾
  });

  section.appendChild(head);
  section.appendChild(body);
  return section;
}

/** One pset / qto group with its own collapsible header. */
function buildGroup(group: PropertyGroup, ctx: TreeRenderContext): HTMLElement {
  const node = document.createElement('div');
  node.className = 'inspector-group';

  const head = document.createElement('button');
  head.className = 'inspector-group-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  const caret = document.createElement('span');
  caret.className = 'inspector-caret';
  caret.textContent = '▾';
  const label = document.createElement('span');
  label.className = 'inspector-group-label';
  label.textContent = group.name;
  if (group.inheritedFromType) {
    const badge = document.createElement('span');
    badge.className = 'inspector-badge';
    badge.textContent = 'from type';
    badge.title = 'Inherited from the element type';
    label.appendChild(document.createTextNode(' '));
    label.appendChild(badge);
  }
  const count = document.createElement('span');
  count.className = 'inspector-group-count';
  count.textContent = String(groupLeafCount(group));
  head.appendChild(caret);
  head.appendChild(label);
  head.appendChild(count);

  const body = document.createElement('div');
  body.className = 'inspector-group-body';
  for (const propNode of group.properties) {
    // Group properties live at path "<group.name>.<key>" in the flat array.
    body.appendChild(buildPropertyRow(propNode, 0, group.name, ctx));
  }

  head.addEventListener('click', () => {
    const expanded = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.style.display = expanded ? 'none' : '';
    caret.textContent = expanded ? '▸' : '▾';
  });

  node.appendChild(head);
  node.appendChild(body);
  return node;
}

/**
 * One `Name = Value [unit]` row, recursive for IfcComplexProperty.
 *
 * `pathPrefix` is the dotted path up to (but not including) `node.key`,
 * used to reconstruct the row's flat-path for varies tooltip lookups.
 * Pass undefined to skip the path-based tooltip (e.g. for direct
 * identity rows, which never carry varies values in practice).
 */
function buildPropertyRow(
  node: PropertyNode,
  depth: number,
  pathPrefix: string | undefined,
  ctx: TreeRenderContext,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'inspector-row-wrapper';
  wrapper.style.paddingLeft = `${Math.min(depth, MAX_COMPLEX_DEPTH) * 12}px`;

  const ownPath = pathPrefix ? `${pathPrefix}.${node.key}` : undefined;

  if (node.value.kind === 'complex') {
    const head = document.createElement('button');
    head.className = 'inspector-complex-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false'); // start collapsed
    const caret = document.createElement('span');
    caret.className = 'inspector-caret';
    caret.textContent = '▸';
    const name = document.createElement('span');
    name.className = 'inspector-row-name';
    name.textContent = node.key;
    const childCount = document.createElement('span');
    childCount.className = 'inspector-complex-count';
    childCount.textContent = `(${node.value.children.length})`;
    head.appendChild(caret);
    head.appendChild(name);
    head.appendChild(childCount);

    const body = document.createElement('div');
    body.className = 'inspector-complex-body';
    body.style.display = 'none';

    // Beyond MAX_COMPLEX_DEPTH, flatten children with a "…" prefix marker.
    if (depth >= MAX_COMPLEX_DEPTH) {
      for (const child of node.value.children) {
        const row = buildPropertyRow(child, MAX_COMPLEX_DEPTH, ownPath, ctx);
        // Mark with ellipsis prefix to signal depth-flatten.
        const nameEl = row.querySelector('.inspector-row-name');
        if (nameEl && nameEl.textContent) nameEl.textContent = `… ${nameEl.textContent}`;
        body.appendChild(row);
      }
    } else {
      for (const child of node.value.children) {
        body.appendChild(buildPropertyRow(child, depth + 1, ownPath, ctx));
      }
    }

    head.addEventListener('click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.style.display = expanded ? 'none' : '';
      caret.textContent = expanded ? '▸' : '▾';
    });

    wrapper.appendChild(head);
    wrapper.appendChild(body);
    return wrapper;
  }

  // Leaf row
  const row = document.createElement('div');
  row.className = 'inspector-row';

  const name = document.createElement('span');
  name.className = 'inspector-row-name';
  name.textContent = node.key;
  if (node.description) name.title = node.description;

  const eq = document.createElement('span');
  eq.className = 'inspector-row-eq';
  eq.textContent = ' = ';

  const valEl = buildValueElement(node.value, node.unit, ownPath, ctx);

  if (node.inheritedFromType) {
    const badge = document.createElement('span');
    badge.className = 'inspector-badge';
    badge.textContent = 'from type';
    row.appendChild(badge);
  }
  row.appendChild(name);
  row.appendChild(eq);
  row.appendChild(valEl);
  wrapper.appendChild(row);
  return wrapper;
}

/** Element containing the formatted value + optional unit pill. */
function buildValueElement(
  value: PropertyValue,
  unit: string | undefined,
  path: string | undefined,
  ctx: TreeRenderContext,
): HTMLElement {
  const span = document.createElement('span');
  span.className = 'inspector-row-value';
  if (value.kind === 'varies') {
    span.classList.add('inspector-row-varies');
    span.textContent = 'varies';
    if (path && ctx.hasCurrentProps()) {
      span.title = ctx.formatVariesTooltip(path);
    }
    return span;
  }
  const full = displayStringForValue(value);
  span.title = `${full}${full ? ' ' : ''}(click to copy)`;
  span.textContent = truncate(full || '—', ctx.valueTruncateAt);
  if (full && full.length > ctx.valueTruncateAt) span.classList.add('inspector-truncated');
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.addEventListener('click', () => {
    if (!full) return;
    ctx.copyWithFlash(span, full);
  });

  if (unit) {
    const pill = document.createElement('span');
    pill.className = 'inspector-unit-pill';
    pill.textContent = unit;
    const container = document.createElement('span');
    container.className = 'inspector-value-with-unit';
    container.appendChild(span);
    container.appendChild(pill);
    return container;
  }
  return span;
}
