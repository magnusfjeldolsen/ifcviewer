import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
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
});
