// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildSelectionFrustum,
  classifyMesh,
  bucketResults,
  modeFromModifiers,
  computeDeep,
} from '../src/inspector/MarqueeSelector';
import type { ElementBucket } from '../src/inspector/MarqueeSelector';

/**
 * Unit tests for the pure helpers in MarqueeSelector.
 *
 * No DOM, no Viewer fixture, no event dispatch — just maths. The
 * integration of these helpers with pointer events lives in
 * `marquee-selector.test.ts`.
 */

function makeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

function makeMeshAt(x: number, y: number, z: number, size = 1): THREE.Mesh {
  const geom = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('buildSelectionFrustum', () => {
  it('produces 6 planes for a valid rectangle', () => {
    const cam = makeCamera();
    const frustum = buildSelectionFrustum(
      new THREE.Vector2(-0.5, -0.5),
      new THREE.Vector2(0.5, 0.5),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    expect(frustum.planes.length).toBe(6);
    // None of the planes should have a degenerate (zero) normal.
    for (const p of frustum.planes) {
      expect(p.normal.lengthSq()).toBeGreaterThan(0.1);
    }
  });

  it('contains a point at the centre of the rectangle in front of the camera', () => {
    const cam = makeCamera();
    const frustum = buildSelectionFrustum(
      new THREE.Vector2(-0.5, -0.5),
      new THREE.Vector2(0.5, 0.5),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    // Origin is dead-centre of the camera view and at z=0, well inside.
    expect(frustum.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(true);
  });

  it('excludes a point clearly outside the rectangle', () => {
    const cam = makeCamera();
    const frustum = buildSelectionFrustum(
      new THREE.Vector2(-0.5, -0.5),
      new THREE.Vector2(-0.4, -0.4), // tiny rectangle in the lower-left
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    // A point at the upper-right of view is well outside this small rect.
    expect(frustum.containsPoint(new THREE.Vector3(5, 5, 0))).toBe(false);
  });

  it('input order (right-to-left vs left-to-right) yields the same frustum', () => {
    const cam = makeCamera();
    const a = buildSelectionFrustum(
      new THREE.Vector2(-0.5, -0.5),
      new THREE.Vector2(0.5, 0.5),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    const b = buildSelectionFrustum(
      new THREE.Vector2(0.5, 0.5),
      new THREE.Vector2(-0.5, -0.5),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    const probe = new THREE.Vector3(0, 0, 0);
    expect(a.containsPoint(probe)).toBe(b.containsPoint(probe));
    // Probe a point clearly outside both rectangles.
    const out = new THREE.Vector3(50, 50, 0);
    expect(a.containsPoint(out)).toBe(b.containsPoint(out));
  });

  it('handles a zero-width rectangle without throwing', () => {
    const cam = makeCamera();
    expect(() =>
      buildSelectionFrustum(
        new THREE.Vector2(0.1, -0.5),
        new THREE.Vector2(0.1, 0.5),
        cam,
        computeDeep(cam, new THREE.Box3()),
      ),
    ).not.toThrow();
  });

  it('handles a zero-height rectangle without throwing', () => {
    const cam = makeCamera();
    expect(() =>
      buildSelectionFrustum(
        new THREE.Vector2(-0.5, 0.1),
        new THREE.Vector2(0.5, 0.1),
        cam,
        computeDeep(cam, new THREE.Box3()),
      ),
    ).not.toThrow();
  });
});

describe('computeDeep', () => {
  it('returns at least the camera far plane', () => {
    const cam = makeCamera();
    cam.far = 500;
    const deep = computeDeep(cam, new THREE.Box3());
    expect(deep).toBeGreaterThanOrEqual(500);
  });

  it('returns at least twice the scene diagonal', () => {
    const cam = makeCamera();
    cam.far = 10;
    const sceneBox = new THREE.Box3(
      new THREE.Vector3(-100, -100, -100),
      new THREE.Vector3(100, 100, 100),
    );
    const deep = computeDeep(cam, sceneBox);
    const diag = sceneBox.getSize(new THREE.Vector3()).length();
    expect(deep).toBeGreaterThanOrEqual(diag * 2);
  });
});

describe('classifyMesh', () => {
  function fullFrustum(cam: THREE.PerspectiveCamera): THREE.Frustum {
    return buildSelectionFrustum(
      new THREE.Vector2(-0.99, -0.99),
      new THREE.Vector2(0.99, 0.99),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
  }
  function tinyCornerFrustum(cam: THREE.PerspectiveCamera): THREE.Frustum {
    return buildSelectionFrustum(
      new THREE.Vector2(-0.99, -0.99),
      new THREE.Vector2(-0.95, -0.95),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
  }

  it('returns outside when AABB is wholly outside the frustum', () => {
    const cam = makeCamera();
    const frustum = tinyCornerFrustum(cam);
    const mesh = makeMeshAt(0, 0, 0);
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [], tmpBox)).toBe('outside');
  });

  it('returns window when AABB is wholly inside the frustum', () => {
    const cam = makeCamera();
    const frustum = fullFrustum(cam);
    const mesh = makeMeshAt(0, 0, 0, 0.1);
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [], tmpBox)).toBe('window');
  });

  it('returns crossing when AABB straddles a frustum side plane', () => {
    const cam = makeCamera();
    // Build a frustum that covers the right half of the screen only.
    const frustum = buildSelectionFrustum(
      new THREE.Vector2(0.0, -0.99),
      new THREE.Vector2(0.99, 0.99),
      cam,
      computeDeep(cam, new THREE.Box3()),
    );
    // Mesh centred at x=0 (right at the cut) with size 2 → straddles.
    const mesh = makeMeshAt(0, 0, 0, 2);
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [], tmpBox)).toBe('crossing');
  });

  it('respects mesh.matrixWorld translation (moves AABB out of frustum)', () => {
    const cam = makeCamera();
    const frustum = fullFrustum(cam);
    // Place the mesh far off to the side.
    const mesh = makeMeshAt(100, 0, 0, 1);
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [], tmpBox)).toBe('outside');
  });

  it('returns outside when AABB is fully clipped by a clip plane', () => {
    const cam = makeCamera();
    const frustum = fullFrustum(cam);
    // Clip plane at z=5, visible side is z >= 5 (everything farther from
    // camera than z=5 is visible). Mesh at z=0 is entirely on the cut side.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -5);
    const mesh = makeMeshAt(0, 0, 0, 0.1);
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [plane], tmpBox)).toBe('outside');
  });

  it('keeps original classification when AABB straddles a clip plane', () => {
    const cam = makeCamera();
    const frustum = fullFrustum(cam);
    // Plane at z=0, visible side is z >= 0. Mesh of size 2 centred at z=0
    // has half on each side — not fully clipped.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const mesh = makeMeshAt(0, 0, 0, 2);
    const tmpBox = new THREE.Box3();
    const result = classifyMesh(mesh, frustum, [plane], tmpBox);
    // Mesh is inside the frustum (small enough), so classification is window
    // — not outside, despite the clip plane straddling.
    expect(result).not.toBe('outside');
  });

  it('falls back to computing boundingBox if missing', () => {
    const cam = makeCamera();
    const frustum = fullFrustum(cam);
    const mesh = makeMeshAt(0, 0, 0, 0.1);
    // Manually null out boundingBox to exercise the fallback.
    mesh.geometry.boundingBox = null;
    const tmpBox = new THREE.Box3();
    expect(classifyMesh(mesh, frustum, [], tmpBox)).toBe('window');
    expect(mesh.geometry.boundingBox).not.toBeNull();
  });
});

describe('bucketResults', () => {
  function makeBucket(
    modelId: string,
    expressId: number,
    counts: { all: number; window: number; touches: number },
  ): [string, ElementBucket] {
    return [
      `${modelId}:${expressId}`,
      {
        all: counts.all,
        window: counts.window,
        touches: counts.touches,
        sample: { modelId, expressId, ifcClass: '', ifcTypeCode: 0 },
      },
    ];
  }

  it('crossing mode returns elements with any touching mesh', () => {
    const buckets = new Map<string, ElementBucket>([
      makeBucket('A', 1, { all: 3, window: 0, touches: 1 }), // touches → include
      makeBucket('A', 2, { all: 2, window: 0, touches: 0 }), // no touches → exclude
      makeBucket('A', 3, { all: 1, window: 1, touches: 1 }), // touches → include
    ]);
    const out = bucketResults(buckets, 'crossing');
    expect(out.map((i) => i.expressId).sort()).toEqual([1, 3]);
  });

  it('window mode returns only elements where every mesh is fully inside', () => {
    const buckets = new Map<string, ElementBucket>([
      makeBucket('A', 1, { all: 3, window: 3, touches: 3 }), // all-window → include
      makeBucket('A', 2, { all: 3, window: 2, touches: 3 }), // one outside → exclude
      makeBucket('A', 3, { all: 1, window: 1, touches: 1 }), // all-window → include
    ]);
    const out = bucketResults(buckets, 'window');
    expect(out.map((i) => i.expressId).sort()).toEqual([1, 3]);
  });

  it('window mode excludes elements where some meshes never touched', () => {
    // all=3, touches=0 with a window=0 represents an element whose meshes
    // were all outside. Should not be selected in window mode.
    const buckets = new Map<string, ElementBucket>([
      makeBucket('A', 1, { all: 3, window: 0, touches: 0 }),
    ]);
    expect(bucketResults(buckets, 'window')).toEqual([]);
  });

  it('empty input → empty output (both modes)', () => {
    const buckets = new Map<string, ElementBucket>();
    expect(bucketResults(buckets, 'crossing')).toEqual([]);
    expect(bucketResults(buckets, 'window')).toEqual([]);
  });

  it('dedupes by (modelId, expressId) at the map level', () => {
    // The Map<string, ElementBucket> already gives us dedup — but verify
    // that a single bucket emits exactly one identity.
    const buckets = new Map<string, ElementBucket>([
      makeBucket('A', 1, { all: 5, window: 5, touches: 5 }),
    ]);
    const out = bucketResults(buckets, 'window');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ modelId: 'A', expressId: 1, ifcClass: '', ifcTypeCode: 0 });
  });
});

describe('modeFromModifiers', () => {
  it('no modifiers → replace', () => {
    expect(modeFromModifiers({ ctrl: false, shift: false, meta: false })).toBe('replace');
  });
  it('ctrl → add', () => {
    expect(modeFromModifiers({ ctrl: true, shift: false, meta: false })).toBe('add');
  });
  it('meta (cmd) → add', () => {
    expect(modeFromModifiers({ ctrl: false, shift: false, meta: true })).toBe('add');
  });
  it('shift → remove', () => {
    expect(modeFromModifiers({ ctrl: false, shift: true, meta: false })).toBe('remove');
  });
  it('shift wins over ctrl', () => {
    expect(modeFromModifiers({ ctrl: true, shift: true, meta: false })).toBe('remove');
  });
  it('shift wins over meta', () => {
    expect(modeFromModifiers({ ctrl: false, shift: true, meta: true })).toBe('remove');
  });
});
