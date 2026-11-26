import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  alongAxisUnderCursor,
  orderSnapCandidates,
  snapCandidatesAt,
  snapPayload,
  SNAP_KIND,
  SNAP_PRIORITY,
  type SnapPayload,
  type SnapTarget,
} from '../src/tools/snapCandidates';
import { rankCandidates } from '../src/inspector/candidateMath';

/**
 * A unit quad in the z=0 plane with its first corner at the origin, viewed
 * head-on from +z. The camera is set up so world (0,0,0) lands exactly at the
 * centre of an 800x600 canvas, which makes every expected screen position
 * something that can be worked out by hand rather than by running the code.
 */
const CANVAS = { width: 800, height: 600 };
const CENTRE = { x: 400, y: 300 };

function scene() {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(50, CANVAS.width / CANVAS.height, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return { mesh, camera };
}

function query(cursor: { x: number; y: number }, hitPoint: THREE.Vector3, radiusPx = 12) {
  const { mesh, camera } = scene();
  return snapCandidatesAt({
    mesh,
    faceIndex: 0,
    hitPoint,
    cursor,
    camera,
    canvas: CANVAS,
    radiusPx,
  });
}

function targets(candidates: ReturnType<typeof snapCandidatesAt>): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (const c of rankCandidates(candidates)) {
    const target = snapPayload(c)?.target;
    if (target) out.push(target);
  }
  return out;
}

describe('snapCandidatesAt', () => {
  it('offers the corner under the cursor', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    const vertex = found.find((c) => snapPayload(c)?.target === 'vertex');
    expect(vertex).toBeDefined();
    const payload = snapPayload(vertex!) as SnapPayload;
    expect(payload.position.x).toBeCloseTo(0, 5);
    expect(payload.position.y).toBeCloseTo(0, 5);
  });

  it('prefers a corner to the edge it sits on, and both to the face', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    expect(targets(found)[0]).toBe('vertex');
    expect(targets(found)).toEqual(['vertex', 'edge', 'edge', 'face', 'point']);
  });

  it('drops corners outside the radius', () => {
    // Far from any corner of the quad, but still on it.
    const found = query({ x: CENTRE.x + 200, y: CENTRE.y - 200 }, new THREE.Vector3(0.5, 0.5, 0));

    expect(found.some((c) => snapPayload(c)?.target === 'vertex')).toBe(false);
  });

  it('always offers the face and the raw point, wherever the cursor is', () => {
    const found = query({ x: 10, y: 10 }, new THREE.Vector3(0.5, 0.5, 0));

    expect(targets(found)).toEqual(['face', 'point']);
  });

  // The escape hatch that removes the need for a suppression modifier.
  it('ranks the raw point last, so it is always the final alternative', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    const ranked = targets(found);
    expect(ranked[ranked.length - 1]).toBe('point');
    expect(SNAP_PRIORITY.point).toBeGreaterThan(SNAP_PRIORITY.face);
  });

  it('gives an edge its direction, for the glyph that shows what was caught', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    const edge = found.find((c) => snapPayload(c)?.target === 'edge');
    const dir = (snapPayload(edge!) as SnapPayload).edgeDirection!;
    expect(dir.length()).toBeCloseTo(1, 5);
  });

  it('gives the face its world normal, which is what makes a measurement orthogonal', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    const face = found.find((c) => snapPayload(c)?.target === 'face');
    const normal = (snapPayload(face!) as SnapPayload).planeNormal!;
    // The quad lies in z=0, so its normal points along z.
    expect(Math.abs(normal.z)).toBeCloseTo(1, 5);
    expect(normal.length()).toBeCloseTo(1, 5);
  });

  it('reports the face normal in world space, not the mesh’s own', () => {
    const { mesh, camera } = scene();
    // Lay the quad flat: its normal should now point along y, not z.
    mesh.rotation.x = Math.PI / 2;
    mesh.updateMatrixWorld(true);

    const found = snapCandidatesAt({
      mesh,
      faceIndex: 0,
      hitPoint: new THREE.Vector3(0.5, 0, 0.5),
      cursor: CENTRE,
      camera,
      canvas: CANVAS,
    });

    const face = found.find((c) => snapPayload(c)?.target === 'face');
    expect(Math.abs((snapPayload(face!) as SnapPayload).planeNormal!.y)).toBeCloseTo(1, 5);
  });

  // Issue #93. Snapping welds corners and drops the slivers that collapse, so
  // its triangles are numbered differently from the mesh's. The hit's
  // `faceIndex` counts the mesh's triangles; reading it as a snap triangle
  // took the normal from whichever surface came next, and a measurement off
  // a floor ran along a wall's normal instead.
  it('takes the normal of the triangle that was hit, even after a sliver is dropped', () => {
    const { camera } = scene();
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          // 0: a sliver whose corners weld together — no area once welded.
          5, 5, 5, 5.000001, 5, 5, 6, 5, 5,
          // 1: a wall in the x=2 plane, normal along x.
          2, 0, 0, 2, 1, 0, 2, 0, 1,
          // 2: a floor in the y=-1 plane, normal along y.
          0, -1, 0, 0, -1, 1, 1, -1, 0,
        ],
        3,
      ),
    );
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const normalAt = (faceIndex: number) => {
      const found = snapCandidatesAt({
        mesh,
        faceIndex,
        hitPoint: new THREE.Vector3(0.2, -1, 0.2),
        cursor: { x: 5, y: 5 },
        camera,
        canvas: CANVAS,
      });
      const face = found.find((c) => snapPayload(c)?.target === 'face');
      return (snapPayload(face!) as SnapPayload).planeNormal!;
    };

    expect(Math.abs(normalAt(1).x)).toBeCloseTo(1, 5);
    expect(Math.abs(normalAt(2).y)).toBeCloseTo(1, 5);
  });

  // A hit can only land on a triangle with area, but if it ever lands on one
  // that welding collapsed there is no plane to offer — the raw point remains.
  it('offers no surface when the hit triangle collapsed under welding', () => {
    const { camera } = scene();
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([5, 5, 5, 5.000001, 5, 5, 6, 5, 5, 0, -1, 0, 0, -1, 1, 1, -1, 0], 3),
    );
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const found = snapCandidatesAt({
      mesh,
      faceIndex: 0,
      hitPoint: new THREE.Vector3(5.5, 5, 5),
      cursor: { x: 5, y: 5 },
      camera,
      canvas: CANVAS,
    });

    expect(found.some((c) => snapPayload(c)?.target === 'face')).toBe(false);
    expect(found.some((c) => snapPayload(c)?.target === 'point')).toBe(true);
  });

  it('puts an edge snap on the edge, not at the cursor', () => {
    // Cursor near the middle of the bottom edge, which runs (0,0,0)→(1,0,0).
    const { mesh, camera } = scene();
    const midEdge = new THREE.Vector3(0.5, 0, 0);
    const ndc = midEdge.clone().project(camera);
    const cursor = {
      x: ((ndc.x + 1) / 2) * CANVAS.width,
      y: ((1 - ndc.y) / 2) * CANVAS.height,
    };

    const found = snapCandidatesAt({
      mesh,
      faceIndex: 0,
      // A hit slightly off the edge, as a real raycast would give.
      hitPoint: new THREE.Vector3(0.5, 0.02, 0),
      cursor,
      camera,
      canvas: CANVAS,
    });

    const edge = found.find((c) => snapPayload(c)?.target === 'edge');
    const position = (snapPayload(edge!) as SnapPayload).position;
    expect(position.y).toBeCloseTo(0, 5);
    expect(position.x).toBeCloseTo(0.5, 5);
  });

  it('tags every candidate as a snap so the resolver can route it', () => {
    const found = query(CENTRE, new THREE.Vector3(0, 0, 0));

    expect(found.every((c) => c.kind === SNAP_KIND)).toBe(true);
    expect(found.every((c) => c.id.startsWith('snap:'))).toBe(true);
  });

  it('returns nothing when the canvas has no size', () => {
    const { mesh, camera } = scene();

    const found = snapCandidatesAt({
      mesh,
      faceIndex: 0,
      hitPoint: new THREE.Vector3(),
      cursor: CENTRE,
      camera,
      canvas: { width: 0, height: 0 },
    });

    expect(found).toEqual([]);
  });

  // The `S` toggle. Snapping off does not mean no candidate — it means the
  // only candidate is the raw point under the cursor.
  it('offers only the raw point when features are switched off', () => {
    const { mesh, camera } = scene();

    const found = snapCandidatesAt({
      mesh,
      faceIndex: 0,
      hitPoint: new THREE.Vector3(0, 0, 0),
      cursor: CENTRE,
      camera,
      canvas: CANVAS,
      featuresEnabled: false,
    });

    expect(targets(found)).toEqual(['point']);
  });
});

/**
 * Issue #63 — the centre of something round. A 12-segment column, 0.4 m
 * across, standing on the origin along +y, seen from +z.
 */
describe('snapCandidatesAt — round centres', () => {
  function column() {
    // Extruded rather than `CylinderGeometry`, whose caps are fans round a hub
    // vertex: web-ifc's caps have no hub, so the centre is not also a corner.
    const shape = new THREE.Shape().absarc(0, 0, 0.2, 0, Math.PI * 2, false);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false, curveSegments: 12 });
    g.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50, CANVAS.width / CANVAS.height, 0.1, 100);
    camera.position.set(0, 1, 6);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    return { mesh, camera };
  }

  function screenOf(p: THREE.Vector3, camera: THREE.PerspectiveCamera) {
    const ndc = p.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * CANVAS.width, y: ((1 - ndc.y) / 2) * CANVAS.height };
  }

  /** Where a ray from the camera through `p`'s screen position meets the column. */
  function hitOn(mesh: THREE.Mesh, camera: THREE.PerspectiveCamera, cursor: { x: number; y: number }) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2((cursor.x / CANVAS.width) * 2 - 1, -(cursor.y / CANVAS.height) * 2 + 1),
      camera,
    );
    const [hit] = raycaster.intersectObject(mesh);
    return hit;
  }

  function at(cursor: { x: number; y: number }, extra: Partial<Parameters<typeof snapCandidatesAt>[0]> = {}) {
    const { mesh, camera } = column();
    const hit = hitOn(mesh, camera, cursor);
    expect(hit).toBeDefined();
    return snapCandidatesAt({
      mesh,
      faceIndex: hit.faceIndex!,
      hitPoint: hit.point,
      cursor,
      camera,
      canvas: CANVAS,
      ...extra,
    });
  }

  it('snaps to the axis, at the cursor’s height, when the cursor is over the middle of the column', () => {
    const { camera } = column();
    // Slightly off the centreline, as a hand would be.
    const cursor = screenOf(new THREE.Vector3(0.03, 1.2, 0.2), camera);
    const ordered = orderSnapCandidates(at(cursor));
    const best = snapPayload(ordered[0])!;
    expect(best.target).toBe('centre');
    expect(best.position.x).toBeCloseTo(0, 4);
    expect(best.position.z).toBeCloseTo(0, 4);
    // Same height as the hit, give or take the perspective of a ray hitting a
    // curved surface slightly off-centre.
    expect(best.position.y).toBeGreaterThan(1.1);
    expect(best.position.y).toBeLessThan(1.3);
    expect(Math.abs(best.axis!.y)).toBeCloseTo(1, 5);
  });

  it('still finds the axis when the column is seen from above at an angle', () => {
    const { mesh } = column();
    const camera = new THREE.PerspectiveCamera(50, CANVAS.width / CANVAS.height, 0.1, 100);
    camera.position.set(-1.5, 3.5, 4);
    camera.lookAt(0, 1.5, 0);
    camera.updateMatrixWorld(true);
    // On the column's middle as seen from here.
    const cursor = screenOf(new THREE.Vector3(0, 1.5, 0), camera);
    const hit = hitOn(mesh, camera, cursor);
    const best = snapPayload(
      orderSnapCandidates(
        snapCandidatesAt({ mesh, faceIndex: hit.faceIndex!, hitPoint: hit.point, cursor, camera, canvas: CANVAS }),
      )[0],
    )!;
    expect(best.target).toBe('centre');
    // On the axis, and under the cursor: where the line of sight passes it.
    expect(Math.hypot(best.position.x, best.position.z)).toBeLessThan(1e-4);
    expect(best.position.y).toBeCloseTo(1.5, 3);
  });

  it('does not offer the centre when the cursor is near the column’s edge', () => {
    const { camera } = column();
    // Near the silhouette: tens of pixels from the axis at this distance.
    const cursor = screenOf(new THREE.Vector3(0.19, 1.2, 0.06), camera);
    expect(at(cursor).some((c) => snapPayload(c)?.target === 'centre')).toBe(false);
  });

  it('snaps to the centre of the top when the column is seen from above', () => {
    const { mesh } = column();
    const camera = new THREE.PerspectiveCamera(50, CANVAS.width / CANVAS.height, 0.1, 100);
    camera.position.set(0.0, 8, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const cursor = screenOf(new THREE.Vector3(0.04, 3, 0.02), camera);
    const hit = hitOn(mesh, camera, cursor);
    const ordered = orderSnapCandidates(
      snapCandidatesAt({ mesh, faceIndex: hit.faceIndex!, hitPoint: hit.point, cursor, camera, canvas: CANVAS }),
    );
    const best = snapPayload(ordered[0])!;
    expect(best.target).toBe('centre');
    expect(best.position.distanceTo(new THREE.Vector3(0, 3, 0))).toBeLessThan(1e-4);
  });

  it('is left out when centres are switched off', () => {
    const { camera } = column();
    const cursor = screenOf(new THREE.Vector3(0.0, 1.2, 0.2), camera);
    const allowed = new Set<SnapTarget>(['vertex', 'edge', 'face', 'point']);
    expect(at(cursor, { allowed }).some((c) => snapPayload(c)?.target === 'centre')).toBe(false);
  });

  it('follows the snapping switch: off means only the raw point', () => {
    const { camera } = column();
    const cursor = screenOf(new THREE.Vector3(0.0, 1.2, 0.2), camera);
    expect(targets(at(cursor, { featuresEnabled: false }))).toEqual(['point']);
  });
});

describe('alongAxisUnderCursor', () => {
  const centre = new THREE.Vector3(0, 0, 0);
  const axis = new THREE.Vector3(0, 1, 0);

  it('is the height where the line of sight passes the axis', () => {
    // Eye up and in front, looking down through a hit on the near surface.
    const eye = new THREE.Vector3(0, 4, 4);
    const hit = new THREE.Vector3(0, 1, 1);
    expect(alongAxisUnderCursor(centre, axis, 10, eye, hit)).toBeCloseTo(0, 6);
  });

  it('stays within the shape', () => {
    const eye = new THREE.Vector3(0, 4, 4);
    // A level line of sight at y = 4 passes the axis above a shape 4 long.
    const hit = new THREE.Vector3(0, 4, 1);
    expect(alongAxisUnderCursor(centre, axis, 2, eye, hit)).toBe(2);
  });

  it('falls back to the hit’s height when looking straight down the axis', () => {
    const eye = new THREE.Vector3(0.1, 10, 0);
    const hit = new THREE.Vector3(0.1, 1.5, 0);
    expect(alongAxisUnderCursor(centre, axis, 2, eye, hit)).toBeCloseTo(1.5, 6);
  });
});
