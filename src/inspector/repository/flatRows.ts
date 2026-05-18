/**
 * Flat-row materialization for the inspector's flat-view + filter.
 *
 * Walks a structured properties tree (identity rows + pset groups + qto
 * groups) and emits one row per leaf. Complex properties are flattened
 * to dotted paths (e.g. `Pset_WallCommon.Layers.Layer1`).
 *
 * `displayStringForValue` is also imported by the panel (`InspectorPanel`
 * uses it for the materials list + value pills), so this module is the
 * single home for value-formatting that needs to round-trip through both
 * the repository and the UI.
 *
 * Split out of `WebIfcPropertyRepository.ts` so the flat materialization
 * has its own file with a single, sharp purpose. No behavior change.
 */

import { formatRawValue } from '../format';
import type {
  PropertyFlatRow,
  PropertyGroup,
  PropertyNode,
  PropertyValue,
} from '../types';

/**
 * Walk the structured property tree and emit flat rows. Complex
 * properties produce one row per leaf, with dotted paths.
 */
export function buildFlatRows(
  direct: PropertyNode[],
  psets: PropertyGroup[],
  qtos: PropertyGroup[],
): PropertyFlatRow[] {
  const rows: PropertyFlatRow[] = [];
  const pushNode = (groupName: string, node: PropertyNode, prefix?: string): void => {
    const path = prefix
      ? `${prefix}.${node.key}`
      : `${groupName}.${node.key}`;
    if (node.value.kind === 'complex') {
      for (const child of node.value.children) {
        pushNode(groupName, child, path);
      }
      return;
    }
    rows.push({
      path,
      name: node.key,
      rawValue: node.value,
      displayValue: displayStringForValue(node.value),
      unit: node.unit,
      source: node.source,
      inheritedFromType: node.inheritedFromType,
      description: node.description,
    });
  };

  for (const node of direct) {
    rows.push({
      path: `Identity.${node.key}`,
      name: node.key,
      rawValue: node.value,
      displayValue: displayStringForValue(node.value),
      unit: node.unit,
      source: 'direct',
      description: node.description,
    });
  }
  for (const g of psets) {
    for (const n of g.properties) pushNode(g.name, n);
  }
  for (const g of qtos) {
    for (const n of g.properties) pushNode(g.name, n);
  }
  // Sort by code point, not localeCompare. These paths are machine-generated
  // dotted identifier keys (e.g. `Pset_X.Aaa`); locale collation is both
  // unnecessary and unreliable here — it de-prioritizes the `_`/`.`
  // punctuation and, on some ICU builds, orders `Pset_X.Aaa` *after*
  // `Pset_X.Bbb`. A plain code-point compare is deterministic.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

export function displayStringForValue(v: PropertyValue): string {
  switch (v.kind) {
    case 'single':
      return formatRawValue(v.raw.typeCode, v.raw.value ?? v.value);
    case 'quantity':
      return formatRawValue(0, v.value);
    case 'enumerated':
      return v.values.join(', ');
    case 'list':
      return `(${v.values.length} items)`;
    case 'bounded':
      return `[${v.lower ?? '-∞'}, ${v.upper ?? '+∞'}]`;
    case 'table':
      return `(table, ${v.defining.length} rows)`;
    case 'complex':
      return `(${v.children.length} children)`;
    case 'material-ref':
      return v.materialName;
    case 'varies':
      return 'varies';
    default:
      return '';
  }
}
