import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildSnapGeometry,
  growCoplanarPatch,
  snapGeometryFor,
  DEFAULT_DIHEDRAL_DEG,
  MAX_PATCH_TRIANGLES,
} from '../src/tools/snapGeometry';

/**
 * Expected values come from the geometry itself, not from re-running the
 * implementation's arithmetic: a cube has 8 corners and 12 edges whatever the
 * code does, and its face diagonals are longer than its edges by root two.
 */

function box(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

/** A single flat quad: two triangles sharing a diagonal. */
function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function edgeLengths(geo: ReturnType<typeof buildSnapGeometry>): number[] {
  const out: number[] = [];
  for (let i = 0; i < geo.featureEdges.length; i += 2) {
    const a = geo.featureEdges[i];
    const b = geo.featureEdges[i + 1];
    out.push(
      new THREE.Vector3(geo.positions[a * 3], geo.positions[a * 3 + 1], geo.positions[a * 3 + 2])
        .distanceTo(
          new THREE.Vector3(
            geo.positions[b * 3],
            geo.positions[b * 3 + 1],
            geo.positions[b * 3 + 2],
          ),
        ),
    );
  }
  return out;
}

describe('buildSnapGeometry', () => {
  it('deduplicates the corners a box repeats per face', () => {
    // BoxGeometry carries 24 vertices — four per face, so each face can have
    // its own normal. A person sees 8 corners, and would be baffled to find
    // three snap targets stacked on each one.
    const geo = buildSnapGeometry(box());

    expect(geo.positions.length / 3).toBe(8);
  });

  it('keeps all twelve triangles', () => {
    expect(buildSnapGeometry(box()).triangles.length / 3).toBe(12);
  });

  it('finds a box’s twelve edges', () => {
    expect(buildSnapGeometry(box()).featureEdges.length / 2).toBe(12);
  });

  // The reason edges are filtered while vertices are not. Every quad is two
  // triangles with a diagonal between them, and offering that diagonal as a
  // snap target would put a phantom line across every flat wall.
  it('rejects the diagonal across a face', () => {
    const lengths = edgeLengths(buildSnapGeometry(box()));

    // A unit cube's edges are 1; a face diagonal would be about 1.414.
    expect(Math.max(...lengths)).toBeCloseTo(1, 5);
  });

  it('finds the four edges of a bare quad, not five', () => {
    const geo = buildSnapGeometry(quad());

    expect(geo.positions.length / 3).toBe(4);
    expect(geo.featureEdges.length / 2).toBe(4);
  });

  it('records which triangle lies across each edge', () => {
    const geo = buildSnapGeometry(quad());

    // Two triangles, joined along one edge: each has exactly one neighbour.
    const neighbourCounts = [0, 1].map(
      (t) => [0, 1, 2].filter((e) => geo.neighbours[t * 3 + e] >= 0).length,
    );
    expect(neighbourCounts).toEqual([1, 1]);
  });
});

describe('growCoplanarPatch', () => {
  it('grows across a flat quad and stops there', () => {
    const geo = buildSnapGeometry(quad());

    const patch = growCoplanarPatch(geo, 0, DEFAULT_DIHEDRAL_DEG, MAX_PATCH_TRIANGLES);

    expect(patch.triangles.length).toBe(2);
  });

  it('does not cross a box’s corner into the next face', () => {
    const geo = buildSnapGeometry(box());

    const patch = growCoplanarPatch(geo, 0, DEFAULT_DIHEDRAL_DEG, MAX_PATCH_TRIANGLES);

    // One face of a box is two triangles. Crossing the 90° corner would give
    // more, and the normal would become meaningless.
    expect(patch.triangles.length).toBe(2);
  });

  it('reports the plane of the face it grew over', () => {
    const geo = buildSnapGeometry(quad());

    const patch = growCoplanarPatch(geo, 0, DEFAULT_DIHEDRAL_DEG, MAX_PATCH_TRIANGLES);

    // The quad lies in the xz plane, so its normal is vertical.
    expect(Math.abs(patch.normal.y)).toBeCloseTo(1, 5);
    expect(patch.normal.length()).toBeCloseTo(1, 5);
  });

  it('stops at the triangle bound rather than traversing without limit', () => {
    // A cylinder's side is many nearly-coplanar strips; with a slack angle it
    // would grow around the whole barrel if nothing stopped it.
    const geo = buildSnapGeometry(new THREE.CylinderGeometry(1, 1, 2, 64));

    const patch = growCoplanarPatch(geo, 0, 45, 8);

    expect(patch.triangles.length).toBeLessThanOrEqual(8);
  });

  it('does not swallow a curved surface at the normal threshold', () => {
    const geo = buildSnapGeometry(new THREE.CylinderGeometry(1, 1, 2, 64));

    const patch = growCoplanarPatch(geo, 0, DEFAULT_DIHEDRAL_DEG, MAX_PATCH_TRIANGLES);

    // 64 segments means about 5.6° between adjacent strips — well outside the
    // threshold, so a patch is one strip, not the barrel.
    expect(patch.triangles.length).toBeLessThan(8);
  });
});

describe('snapGeometryFor', () => {
  it('returns the same derived data for the same geometry', () => {
    const g = box();

    expect(snapGeometryFor(g)).toBe(snapGeometryFor(g));
  });

  it('derives separately for different geometries', () => {
    expect(snapGeometryFor(box())).not.toBe(snapGeometryFor(box()));
  });
});
