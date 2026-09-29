import * as THREE from 'three';

/**
 * The geometry snapping needs, derived once per `BufferGeometry` and cached.
 *
 * Measured cost, since the caching decision rests on it: deriving this runs
 * 0.06–0.07 ms on a median IFC geometry and 0.22–0.43 ms at the 95th
 * percentile, against a 16.7 ms frame budget — affordable every frame with no
 * cache at all. The cache exists for the tail. The largest geometries in real
 * models run to roughly 6 000 triangles and cost 15–21 ms, which is a dropped
 * frame for as long as the cursor rests on one. Cached, that is a single hitch
 * on first hover instead of a permanent stutter.
 *
 * Keyed by geometry rather than by mesh so repeated geometry derives once.
 */

/**
 * Two faces meeting at less than this angle are treated as one surface.
 *
 * Shared by edge detection and patch growth, and that is a consistency
 * guarantee rather than an economy: with different thresholds a surface could
 * be flat enough to grow a patch across an edge that was simultaneously being
 * offered as a snap target, and the tool would contradict itself about what is
 * flat.
 */
export const DEFAULT_DIHEDRAL_DEG = 1;

/**
 * Ceiling on how far one patch may grow. With the cache this is belt and
 * braces, but it is what stops a pathological mesh turning the first hover
 * into a multi-second freeze.
 */
export const MAX_PATCH_TRIANGLES = 4096;

/** Positions closer than this in every axis are the same corner. */
const WELD_TOLERANCE = 1e-5;

export interface SnapGeometry {
  /** Unique corner positions in local space, three floats each. */
  positions: Float32Array;
  /** Triangles as indices into `positions`, three each. */
  triangles: Uint32Array;
  /** Edges surviving the dihedral filter, as index pairs into `positions`. */
  featureEdges: Uint32Array;
  /**
   * For each triangle, the triangle across each of its three edges, or -1 at
   * a boundary. Three entries per triangle, in the edge order (0-1, 1-2, 2-0).
   */
  neighbours: Int32Array;
  /** Unit normal per triangle, three floats each. */
  normals: Float32Array;
}

export interface CoplanarPatch {
  /** Triangle indices belonging to the patch. */
  triangles: number[];
  /** Area-independent average normal, normalised. */
  normal: THREE.Vector3;
}

const cache = new WeakMap<THREE.BufferGeometry, SnapGeometry>();

/** Derived snap geometry for `geometry`, computed once and reused. */
export function snapGeometryFor(geometry: THREE.BufferGeometry): SnapGeometry {
  const hit = cache.get(geometry);
  if (hit) return hit;
  const built = buildSnapGeometry(geometry);
  cache.set(geometry, built);
  return built;
}

export function buildSnapGeometry(
  geometry: THREE.BufferGeometry,
  dihedralDeg: number = DEFAULT_DIHEDRAL_DEG,
): SnapGeometry {
  const posAttr = geometry.getAttribute('position');
  const index = geometry.getIndex();

  // Weld coincident corners. A box arrives with four vertices per face so each
  // face can carry its own normal; a person sees eight corners and would be
  // baffled to find three snap targets stacked on each one.
  const unique: number[] = [];
  const remap = new Int32Array(posAttr.count);
  const lookup = new Map<string, number>();
  const q = (v: number) => Math.round(v / WELD_TOLERANCE);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${q(x)},${q(y)},${q(z)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = unique.length / 3;
      unique.push(x, y, z);
      lookup.set(key, id);
    }
    remap[i] = id;
  }

  const rawTriCount = index ? index.count / 3 : posAttr.count / 3;
  const triangles: number[] = [];
  for (let t = 0; t < rawTriCount; t++) {
    const a = remap[index ? index.getX(t * 3) : t * 3];
    const b = remap[index ? index.getX(t * 3 + 1) : t * 3 + 1];
    const c = remap[index ? index.getX(t * 3 + 2) : t * 3 + 2];
    // A triangle whose corners welded together has no area and no normal.
    if (a === b || b === c || c === a) continue;
    triangles.push(a, b, c);
  }

  const positions = new Float32Array(unique);
  const triArray = new Uint32Array(triangles);
  const triCount = triArray.length / 3;

  // Per-triangle normals.
  const normals = new Float32Array(triCount * 3);
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    readVertex(positions, triArray[t * 3], va);
    readVertex(positions, triArray[t * 3 + 1], vb);
    readVertex(positions, triArray[t * 3 + 2], vc);
    n.crossVectors(vb.clone().sub(va), vc.clone().sub(va)).normalize();
    normals[t * 3] = n.x;
    normals[t * 3 + 1] = n.y;
    normals[t * 3 + 2] = n.z;
  }

  // Edge -> the triangles that share it, so we can both find neighbours and
  // measure the angle across each edge in one pass.
  const edgeMap = new Map<string, { a: number; b: number; tris: number[] }>();
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = triArray[t * 3 + e];
      const b = triArray[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const entry = edgeMap.get(key);
      if (entry) entry.tris.push(t);
      else edgeMap.set(key, { a, b, tris: [t] });
    }
  }

  const neighbours = new Int32Array(triCount * 3).fill(-1);
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = triArray[t * 3 + e];
      const b = triArray[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const entry = edgeMap.get(key);
      if (!entry || entry.tris.length !== 2) continue;
      neighbours[t * 3 + e] = entry.tris[0] === t ? entry.tris[1] : entry.tris[0];
    }
  }

  // A feature edge is one where the surface actually bends, or an open
  // boundary. Everything else is a seam introduced by triangulation.
  const cosLimit = Math.cos((dihedralDeg * Math.PI) / 180);
  const featureEdges: number[] = [];
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  for (const entry of edgeMap.values()) {
    if (entry.tris.length === 1) {
      featureEdges.push(entry.a, entry.b);
      continue;
    }
    if (entry.tris.length !== 2) continue;
    readVertex(normals, entry.tris[0], n1);
    readVertex(normals, entry.tris[1], n2);
    if (n1.dot(n2) < cosLimit) featureEdges.push(entry.a, entry.b);
  }

  return {
    positions,
    triangles: triArray,
    featureEdges: new Uint32Array(featureEdges),
    neighbours,
    normals,
  };
}

/**
 * The flat region a triangle belongs to.
 *
 * Grown breadth-first across neighbours whose normals agree, because a single
 * triangle is not a trustworthy plane: a wall exported with float jitter would
 * otherwise give a different answer two centimetres along, which destroys
 * confidence in the number faster than any other failure here.
 */
export function growCoplanarPatch(
  geo: SnapGeometry,
  startTriangle: number,
  dihedralDeg: number = DEFAULT_DIHEDRAL_DEG,
  maxTriangles: number = MAX_PATCH_TRIANGLES,
): CoplanarPatch {
  const cosLimit = Math.cos((dihedralDeg * Math.PI) / 180);
  const seed = new THREE.Vector3();
  readVertex(geo.normals, startTriangle, seed);

  const seen = new Set<number>([startTriangle]);
  const queue = [startTriangle];
  const triangles: number[] = [];
  const sum = new THREE.Vector3();
  const probe = new THREE.Vector3();

  while (queue.length > 0 && triangles.length < maxTriangles) {
    const t = queue.shift()!;
    triangles.push(t);
    readVertex(geo.normals, t, probe);
    sum.add(probe);

    for (let e = 0; e < 3; e++) {
      const next = geo.neighbours[t * 3 + e];
      if (next < 0 || seen.has(next)) continue;
      readVertex(geo.normals, next, probe);
      // Compared against the seed rather than the neighbour, so a gently
      // curving surface cannot creep around it one small step at a time.
      if (probe.dot(seed) < cosLimit) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  const normal = sum.lengthSq() > 0 ? sum.normalize() : seed.clone();
  return { triangles, normal };
}

function readVertex(array: ArrayLike<number>, index: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
}
