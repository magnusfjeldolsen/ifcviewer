import type { ElementIdentity } from './types';

/**
 * A one-line label for an element: its class and its type name, e.g.
 * "IfcSlab · Floor:GPG 120". Falls back to the element's own name, then its
 * line number, when there is no type. Used by the flying name tag.
 */
export function elementTagLabel(identity: ElementIdentity): string {
  const cls = identity.ifcClass && identity.ifcClass !== '' ? identity.ifcClass : 'Element';
  const second = [identity.typeName, identity.name, identity.objectType].find((s) => s && s.trim() !== '');
  return `${cls} · ${second ? second.trim() : `#${identity.expressId}`}`;
}
