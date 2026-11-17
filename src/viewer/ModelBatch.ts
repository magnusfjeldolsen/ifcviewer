import * as THREE from 'three';
import type { ParsedMesh } from '../parser/types';

/**
 * One loaded model, drawn in a few dozen draw calls instead of one per piece.
 *
 * A **piece** is one geometry part as web-ifc delivers it (a `ParsedMesh`);
 * an **element** is an IFC product, identified by its expressID, and owns one
 * or more pieces. Everything outside this module talks about elements; pieces
 * are an internal detail except where snapping needs a piece's triangles.
 *
 * ## How it is drawn
 *
 * Pieces are baked into model space (their placement applied once, at load)
 * and appended to a small number of large **chunks**: one `BufferGeometry`,
 * one draw call each. Chunks are the leaves of a k-d tree that splits a chunk
 * in two along its longest axis once it holds more than `chunkVertexCap`
 * vertices, so each chunk covers a compact region of the building and frustum
 * culling still drops what is off screen. A piece of half the cap or more
 * gets an exactly sized chunk of its own instead, outside the tree, so the
 * biggest pieces are written once and never copied by a split. Pieces whose own colour is
 * see-through (glass) go to a separate tree drawn in the transparent pass.
 *
 * Per-piece appearance lives in a float texture, two texels per piece:
 * colour and opacity, then hidden / highlighted flags. The vertex shader looks
 * its piece up through a per-vertex `pieceIndex` attribute, so hiding,
 * highlighting or recolouring ten thousand elements is ten thousand texel
 * writes and one texture upload — no geometry is touched.
 *
 * A piece made see-through after load stays in its opaque chunk; the opaque
 * pass skips it and a per-chunk overlay mesh, sharing the chunk's vertex
 * buffers with its own short index list, draws it in the transparent pass.
 *
 * ## Precision far from the origin
 *
 * Each chunk has an **anchor**, a world point near its pieces; the chunk's
 * mesh is placed at the anchor and its Float32 positions are relative to it.
 * A piece only joins a chunk whose anchor is within `ANCHOR_REACH` of the
 * piece's centre (otherwise it gets a new leaf of its own), and a chunk made
 * by a split keeps its parent's anchor, so positions are never re-based. A
 * vertex is therefore stored as its offset from a point at most about a
 * kilometre away, wherever the model sits: georeferenced coordinates in the
 * millions keep sub-millimetre precision, whatever piece happened to arrive
 * first. Piece bounds are kept in world space, in double precision.
 */

/** Split a chunk once it holds more vertices than this. */
export const DEFAULT_CHUNK_VERTEX_CAP = 1 << 18;

/**
 * How far (per axis, metres) a piece's centre may be from a chunk's anchor
 * and still join it. Float32 spacing at 1 km is 0.12 mm.
 */
export const ANCHOR_REACH = 1024;

/** Opacity below this counts as see-through. */
const OPAQUE_ALPHA = 0.999;

/** State texture layout. */
const TEXELS_PER_PIECE = 2;
const FLOATS_PER_PIECE = TEXELS_PER_PIECE * 4;
const STATE_TEXTURE_WIDTH = 1024;

/** Highlight: the brand blue at 0.3, added as emissive light. */
export const HIGHLIGHT_COLOR = 0x3b82f6;
export const HIGHLIGHT_INTENSITY = 0.3;

const FLAG_HIDDEN = 1;
const FLAG_HIGHLIGHT = 2;
const FLAG_COLOR = 4;
const FLAG_OPACITY = 8;

export interface ModelBatchOptions {
  /** Vertices per chunk before it is split (tests use a small number). */
  chunkVertexCap?: number;
}

/** How one element is drawn: what `ModelBatch.elementState` reports. */
export interface ElementDrawState {
  hidden: boolean;
  highlighted: boolean;
  /** Effective opacity: the override if set, else the element's own. */
  opacity: number;
  /** Effective colour (linear RGB): the override if set, else the element's own. */
  color: { r: number; g: number; b: number };
  colorOverridden: boolean;
  opacityOverridden: boolean;
}

export interface PieceGeometry {
  /** The piece's triangles relative to its chunk's anchor (indexed, positions only). */
  geometry: THREE.BufferGeometry;
  /** Chunk space → world: a translation to the anchor. */
  matrixWorld: THREE.Matrix4;
}

interface Chunk {
  transparent: boolean;
  /** World point the chunk's mesh sits at; `positions` are relative to it. */
  anchor: THREE.Vector3;
  positions: Float32Array;
  normals: Int8Array;
  pieceIndex: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  indexCount: number;
  /** Counts already handed to the GPU attributes (for incremental upload). */
  uploadedVertexCount: number;
  uploadedIndexCount: number;
  pieces: number[];
  box: THREE.Box3;
  geometry: THREE.BufferGeometry | null;
  mesh: ChunkMesh;
  overlay: THREE.Mesh | null;
  overlayDirty: boolean;
  /** Set when a split found no axis to cut along; the chunk just grows. */
  unsplittable: boolean;
  /** One big piece, sized exactly, outside the k-d tree: never grown or split. */
  solo: boolean;
}

interface KdNode {
  chunk: Chunk | null;
  axis: number;
  split: number;
  left: KdNode | null;
  right: KdNode | null;
}

/**
 * A chunk's mesh. Its `raycast` tests piece by piece (bounding box first) and
 * reports the piece as `batchId`, the way three's `BatchedMesh` does, so a hit
 * resolves to an element with `elementOfHit`.
 */
export class ChunkMesh extends THREE.Mesh {
  readonly isChunkMesh = true;
  constructor(
    readonly owner: ModelBatch,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) {
    super(geometry, material);
    this.matrixAutoUpdate = false;
  }

  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    this.owner.raycastChunk(this, raycaster, intersects);
  }
}

/** Overlay meshes draw a chunk's see-through pieces; never picked themselves. */
function noRaycast(): void {}

/** The element a raycast hit landed on, or null for anything that is not a model piece. */
export function elementOfHit(
  hit: Pick<THREE.Intersection, 'object' | 'batchId'> | null | undefined,
): { modelId: string; expressId: number } | null {
  if (!hit || !(hit.object instanceof ChunkMesh) || hit.batchId === undefined) return null;
  const owner = hit.object.owner;
  const expressId = owner.expressIdOfPiece(hit.batchId);
  if (expressId === undefined) return null;
  return { modelId: owner.modelId, expressId };
}

/** The model a hit object belongs to, or null. */
export function modelIdOfObject(object: THREE.Object3D | null | undefined): string | null {
  return object instanceof ChunkMesh ? object.owner.modelId : null;
}

/**
 * The triangles of the piece a hit landed on, for snapping. `faceIndex` on the
 * hit is the triangle's index within this geometry.
 */
export function pieceGeometryOfHit(
  hit: Pick<THREE.Intersection, 'object' | 'batchId'> | null | undefined,
): PieceGeometry | null {
  if (!hit || !(hit.object instanceof ChunkMesh) || hit.batchId === undefined) return null;
  return hit.object.owner.pieceGeometry(hit.batchId);
}

// ── Scratch ────────────────────────────────────────────────────

const _matrix = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _inverse = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _worldHit = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();

function growFloat32(a: Float32Array, min: number): Float32Array {
  if (a.length >= min) return a;
  const out = new Float32Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growFloat64(a: Float64Array, min: number): Float64Array {
  if (a.length >= min) return a;
  const out = new Float64Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growInt32(a: Int32Array, min: number): Int32Array {
  if (a.length >= min) return a;
  const out = new Int32Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growUint32(a: Uint32Array, min: number): Uint32Array {
  if (a.length >= min) return a;
  const out = new Uint32Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growUint8(a: Uint8Array, min: number): Uint8Array {
  if (a.length >= min) return a;
  const out = new Uint8Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}

// ── Materials ──────────────────────────────────────────────────

interface SharedUniforms {
  pieceState: { value: THREE.DataTexture };
  highlightEmissive: { value: THREE.Color };
}

const VERTEX_DECLARATIONS = /* glsl */ `
attribute float pieceIndex;
uniform highp sampler2D pieceState;
varying vec4 vPieceColor;
varying float vPieceHighlight;
`;

const VERTEX_MAIN = /* glsl */ `
{
  int pieceTexel = int( pieceIndex + 0.5 ) * ${TEXELS_PER_PIECE};
  int stateWidth = textureSize( pieceState, 0 ).x;
  vec4 pieceColor = texelFetch( pieceState, ivec2( pieceTexel % stateWidth, pieceTexel / stateWidth ), 0 );
  vec4 pieceFlags = texelFetch( pieceState, ivec2( ( pieceTexel + 1 ) % stateWidth, ( pieceTexel + 1 ) / stateWidth ), 0 );
  vPieceColor = pieceColor;
  vPieceHighlight = pieceFlags.g;
  bool pieceSkipped = pieceFlags.r > 0.5;
  #if PIECE_PASS == 0
    // The opaque pass leaves see-through pieces to the overlay.
    pieceSkipped = pieceSkipped || pieceColor.a < ${OPAQUE_ALPHA};
  #endif
  // Every vertex of a skipped piece lands outside the clip volume, so its
  // triangles are discarded before rasterisation.
  if ( pieceSkipped ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec4 vPieceColor;
varying float vPieceHighlight;
uniform vec3 highlightEmissive;
`;

function makePieceMaterial(pass: 'opaque' | 'transparent', uniforms: SharedUniforms): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: pass === 'transparent',
    // See-through pieces are not sorted among themselves inside a chunk, so
    // they must not hide each other.
    depthWrite: pass === 'opaque',
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.pieceState = uniforms.pieceState;
    shader.uniforms.highlightEmissive = uniforms.highlightEmissive;
    shader.defines = { ...(shader.defines ?? {}), PIECE_PASS: pass === 'opaque' ? 0 : 1 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor *= vPieceColor;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vPieceHighlight * highlightEmissive;',
      );
  };
  material.customProgramCacheKey = () => `ifc-piece-${pass}`;
  return material;
}

// ── ModelBatch ─────────────────────────────────────────────────

export class ModelBatch {
  readonly modelId: string;
  /** Add this to the scene; hide it to hide the model. Its own transform is identity. */
  readonly group: THREE.Group;

  private readonly cap: number;

  // Per-piece storage (struct of arrays, grown by doubling).
  private count = 0;
  private pieceExpressId: Int32Array = new Int32Array(64);
  private pieceChunk: (Chunk | null)[] = [];
  private pieceVertexStart: Uint32Array = new Uint32Array(64);
  private pieceVertexCount: Uint32Array = new Uint32Array(64);
  private pieceIndexStart: Uint32Array = new Uint32Array(64);
  private pieceIndexCount: Uint32Array = new Uint32Array(64);
  /** World-space AABB, six doubles per piece (min xyz, max xyz). */
  private pieceBox: Float64Array = new Float64Array(64 * 6);
  /** Load-time colour, four floats per piece. */
  private baseColor: Float32Array = new Float32Array(64 * 4);
  private overrideColor: Float32Array = new Float32Array(64 * 3);
  private overrideOpacity: Float32Array = new Float32Array(64);
  private flags: Uint8Array = new Uint8Array(64);

  private elements = new Map<number, number[]>();

  private opaqueRoot: KdNode | null = null;
  private transparentRoot: KdNode | null = null;
  private chunks = new Set<Chunk>();

  private uniforms: SharedUniforms;
  private stateData: Float32Array;
  private opaqueMaterial: THREE.MeshPhongMaterial;
  private transparentMaterial: THREE.MeshPhongMaterial;

  /** Piece geometries handed to snapping, by piece id. Small and bounded. */
  private pieceGeometries = new Map<number, THREE.BufferGeometry>();

  constructor(modelId: string, options: ModelBatchOptions = {}) {
    this.modelId = modelId;
    this.cap = options.chunkVertexCap ?? DEFAULT_CHUNK_VERTEX_CAP;
    this.group = new THREE.Group();
    this.group.name = modelId;
    this.group.matrixAutoUpdate = false;

    this.stateData = new Float32Array(STATE_TEXTURE_WIDTH * 4);
    const highlight = new THREE.Color(HIGHLIGHT_COLOR).multiplyScalar(HIGHLIGHT_INTENSITY);
    this.uniforms = {
      pieceState: { value: makeStateTexture(this.stateData) },
      highlightEmissive: { value: highlight },
    };
    this.trackStateUploads(this.uniforms.pieceState.value);
    this.opaqueMaterial = makePieceMaterial('opaque', this.uniforms);
    this.transparentMaterial = makePieceMaterial('transparent', this.uniforms);
  }

  // ── Loading ──────────────────────────────────────────────────

  /** Add a batch of pieces. Safe to call repeatedly until `finish`. */
  append(meshes: readonly ParsedMesh[]): void {
    if (this.finished) throw new Error(`ModelBatch ${this.modelId}: append after finish`);
    const touched = new Set<Chunk>();
    for (const mesh of meshes) this.addPiece(mesh, touched);
    // A split replaces chunks; only sync the ones still alive.
    for (const chunk of touched) if (this.chunks.has(chunk)) this.syncChunk(chunk);
    this.uploadState();
  }

  /**
   * The stream is complete. Chunks keep room to grow while it is open; now
   * the CPU copies of positions and index are cut to what each chunk holds,
   * and the copies only the GPU reads — normals and piece indices — are let
   * go. Both wait until the GPU has the current data, and neither re-uploads
   * anything: the GPU buffers keep their room, which costs less than sending
   * every chunk again at the end of a load. Positions and the index stay on
   * the CPU because picking and snapping read them. Nothing can be appended
   * afterwards.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const chunk of this.chunks) {
      const g = chunk.geometry;
      if (!g) continue;
      if (chunk.positions.length > chunk.vertexCount * 3) {
        chunk.positions = chunk.positions.slice(0, chunk.vertexCount * 3);
        replaceOnceUploaded(g.getAttribute('position') as THREE.BufferAttribute, chunk.positions);
      }
      if (chunk.index.length > chunk.indexCount) {
        chunk.index = chunk.index.slice(0, chunk.indexCount);
        replaceOnceUploaded(g.getIndex()!, chunk.index);
      }
      replaceOnceUploaded(g.getAttribute('normal') as THREE.BufferAttribute, new Int8Array(0));
      replaceOnceUploaded(g.getAttribute('pieceIndex') as THREE.BufferAttribute, new Float32Array(0));
      chunk.normals = new Int8Array(0);
      chunk.pieceIndex = new Float32Array(0);
    }
  }

  private finished = false;

  /** Free every GPU and CPU resource this model holds. */
  dispose(): void {
    for (const chunk of this.chunks) this.disposeChunk(chunk);
    this.chunks.clear();
    this.opaqueRoot = null;
    this.transparentRoot = null;
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
    this.uniforms.pieceState.value.dispose();
    for (const g of this.pieceGeometries.values()) g.dispose();
    this.pieceGeometries.clear();
    this.elements.clear();
    this.count = 0;
  }

  // ── Queries ──────────────────────────────────────────────────

  /** Number of geometry pieces loaded. */
  get pieceCount(): number {
    return this.count;
  }

  elementIds(): IterableIterator<number> {
    return this.elements.keys();
  }

  hasElement(expressId: number): boolean {
    return this.elements.has(expressId);
  }

  expressIdOfPiece(pieceId: number): number | undefined {
    return pieceId >= 0 && pieceId < this.count ? this.pieceExpressId[pieceId] : undefined;
  }

  isHidden(expressId: number): boolean {
    const pieces = this.elements.get(expressId);
    return !!pieces && pieces.every((p) => (this.flags[p] & FLAG_HIDDEN) !== 0);
  }

  /**
   * How an element is drawn right now (read from its first piece; every
   * piece of an element is always set together), or null if it has none.
   */
  elementState(expressId: number): ElementDrawState | null {
    const p = this.elements.get(expressId)?.[0];
    if (p === undefined) return null;
    const o = p * FLOATS_PER_PIECE;
    const d = this.stateData;
    return {
      hidden: (this.flags[p] & FLAG_HIDDEN) !== 0,
      highlighted: (this.flags[p] & FLAG_HIGHLIGHT) !== 0,
      opacity: d[o + 3],
      color: { r: d[o], g: d[o + 1], b: d[o + 2] },
      colorOverridden: (this.flags[p] & FLAG_COLOR) !== 0,
      opacityOverridden: (this.flags[p] & FLAG_OPACITY) !== 0,
    };
  }

  /** Sizes, for the `?stats` surface and the benchmark. */
  stats(): {
    pieces: number;
    chunks: number;
    transparentChunks: number;
    overlays: number;
    vertices: number;
    triangles: number;
  } {
    let vertices = 0;
    let indices = 0;
    let transparentChunks = 0;
    let overlays = 0;
    for (const c of this.chunks) {
      vertices += c.vertexCount;
      indices += c.indexCount;
      if (c.transparent) transparentChunks++;
      if (c.overlay) overlays++;
    }
    return {
      pieces: this.count,
      chunks: this.chunks.size,
      transparentChunks,
      overlays,
      vertices,
      triangles: indices / 3,
    };
  }

  /** The chunk meshes, for tests and diagnostics. */
  chunkMeshes(): ChunkMesh[] {
    return Array.from(this.chunks, (c) => c.mesh);
  }

  // ── Element appearance ───────────────────────────────────────

  /** Hide or show elements. Hidden elements are not drawn, picked or framed. */
  setHidden(expressIds: Iterable<number>, hidden: boolean): void {
    this.updateFlags(expressIds, FLAG_HIDDEN, hidden);
  }

  /** Turn the selection highlight on or off. */
  setHighlighted(expressIds: Iterable<number>, highlighted: boolean): void {
    this.updateFlags(expressIds, FLAG_HIGHLIGHT, highlighted);
  }

  /** Override elements' colour (linear RGB, 0..1), or `null` for their own. */
  setColor(expressIds: Iterable<number>, color: { r: number; g: number; b: number } | null): void {
    let changed = false;
    for (const id of expressIds) {
      const pieces = this.elements.get(id);
      if (!pieces) continue;
      for (const p of pieces) {
        if (color) {
          this.flags[p] |= FLAG_COLOR;
          this.overrideColor[p * 3] = color.r;
          this.overrideColor[p * 3 + 1] = color.g;
          this.overrideColor[p * 3 + 2] = color.b;
        } else {
          this.flags[p] &= ~FLAG_COLOR;
        }
        this.writeState(p);
        changed = true;
      }
    }
    if (changed) this.uploadState();
  }

  /** Override elements' opacity (0..1), or `null` for their own. */
  setOpacity(expressIds: Iterable<number>, opacity: number | null): void {
    let changed = false;
    for (const id of expressIds) {
      const pieces = this.elements.get(id);
      if (!pieces) continue;
      for (const p of pieces) {
        const before = this.effectiveAlpha(p) < OPAQUE_ALPHA;
        if (opacity === null) {
          this.flags[p] &= ~FLAG_OPACITY;
        } else {
          this.flags[p] |= FLAG_OPACITY;
          this.overrideOpacity[p] = opacity;
        }
        this.writeState(p);
        const chunk = this.pieceChunk[p];
        if (chunk && !chunk.transparent && before !== this.effectiveAlpha(p) < OPAQUE_ALPHA) {
          chunk.overlayDirty = true;
        }
        changed = true;
      }
    }
    if (!changed) return;
    for (const chunk of this.chunks) if (chunk.overlayDirty) this.rebuildOverlay(chunk);
    this.uploadState();
  }

  // ── Bounds ───────────────────────────────────────────────────

  /** Expand `box` (world space) by every piece that is not hidden. */
  expandByVisible(box: THREE.Box3): THREE.Box3 {
    for (let p = 0; p < this.count; p++) {
      if (this.flags[p] & FLAG_HIDDEN || this.pieceIndexCount[p] === 0) continue;
      this.expandByPiece(box, p);
    }
    return box;
  }

  /** Expand `box` (world space) by every piece of the given elements, hidden or not. */
  expandByElements(expressIds: Iterable<number>, box: THREE.Box3): THREE.Box3 {
    for (const id of expressIds) {
      const pieces = this.elements.get(id);
      if (!pieces) continue;
      for (const p of pieces) if (this.pieceIndexCount[p] > 0) this.expandByPiece(box, p);
    }
    return box;
  }

  /** Visit every piece that is not hidden, with its world-space box. */
  forEachVisiblePiece(visit: (expressId: number, worldBox: THREE.Box3) => void): void {
    const box = new THREE.Box3();
    for (let p = 0; p < this.count; p++) {
      if (this.flags[p] & FLAG_HIDDEN || this.pieceIndexCount[p] === 0) continue;
      box.makeEmpty();
      this.expandByPiece(box, p);
      visit(this.pieceExpressId[p], box);
    }
  }

  // ── Picking ──────────────────────────────────────────────────

  /** Raycast one chunk, piece by piece. Called by `ChunkMesh.raycast`. */
  raycastChunk(mesh: ChunkMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const chunk = this.chunkOfMesh(mesh);
    if (!chunk || chunk.indexCount === 0) return;
    const sphere = mesh.geometry.boundingSphere;
    if (sphere) {
      _sphere.copy(sphere).applyMatrix4(mesh.matrixWorld);
      if (!raycaster.ray.intersectsSphere(_sphere)) return;
    }
    _inverse.copy(mesh.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);

    const pos = chunk.positions;
    const idx = chunk.index;
    const { x: ax, y: ay, z: az } = chunk.anchor;
    const b = this.pieceBox;
    for (const p of chunk.pieces) {
      if (this.flags[p] & FLAG_HIDDEN) continue;
      const o = p * 6;
      // The piece's world box, moved into chunk space like the ray.
      _box.min.set(b[o] - ax, b[o + 1] - ay, b[o + 2] - az);
      _box.max.set(b[o + 3] - ax, b[o + 4] - ay, b[o + 5] - az);
      if (!_ray.intersectsBox(_box)) continue;

      const vStart = this.pieceVertexStart[p];
      const iStart = this.pieceIndexStart[p];
      const iEnd = iStart + this.pieceIndexCount[p];
      for (let i = iStart; i < iEnd; i += 3) {
        const ia = idx[i];
        const ib = idx[i + 1];
        const ic = idx[i + 2];
        _a.fromArray(pos, ia * 3);
        _b.fromArray(pos, ib * 3);
        _c.fromArray(pos, ic * 3);
        if (_ray.intersectTriangle(_a, _b, _c, false, _hit) === null) continue;
        _worldHit.copy(_hit).applyMatrix4(mesh.matrixWorld);
        const distance = raycaster.ray.origin.distanceTo(_worldHit);
        if (distance < raycaster.near || distance > raycaster.far) continue;
        const normal = _ab.subVectors(_b, _a).cross(_ac.subVectors(_c, _a)).normalize().clone();
        intersects.push({
          distance,
          point: _worldHit.clone(),
          object: mesh,
          face: { a: ia - vStart, b: ib - vStart, c: ic - vStart, normal, materialIndex: 0 },
          faceIndex: (i - iStart) / 3,
          batchId: p,
        });
      }
    }
  }

  /** A piece's triangles in model space, for snapping. Cached per piece. */
  pieceGeometry(pieceId: number): PieceGeometry | null {
    const chunk = this.pieceChunk[pieceId];
    if (!chunk) return null;
    let geometry = this.pieceGeometries.get(pieceId);
    if (!geometry) {
      const vStart = this.pieceVertexStart[pieceId];
      const vCount = this.pieceVertexCount[pieceId];
      const iStart = this.pieceIndexStart[pieceId];
      const iCount = this.pieceIndexCount[pieceId];
      // Copies, not views: a chunk split or trim replaces the chunk's arrays,
      // and a view would keep the old ones alive.
      const positions = chunk.positions.slice(vStart * 3, (vStart + vCount) * 3);
      const index = new Uint32Array(iCount);
      for (let i = 0; i < iCount; i++) index[i] = chunk.index[iStart + i] - vStart;
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      this.pieceGeometries.set(pieceId, geometry);
      // Snapping only ever looks at the pieces under the cursor; keep the
      // most recent few dozen.
      if (this.pieceGeometries.size > 64) {
        const oldest = this.pieceGeometries.keys().next().value as number;
        this.pieceGeometries.get(oldest)?.dispose();
        this.pieceGeometries.delete(oldest);
      }
    }
    return { geometry, matrixWorld: chunk.mesh.matrixWorld };
  }

  // ── Internals: pieces ────────────────────────────────────────

  private addPiece(mesh: ParsedMesh, touched: Set<Chunk>): void {
    const p = this.count++;
    this.ensurePieceCapacity(this.count);

    const m = mesh.transform;
    this.pieceExpressId[p] = mesh.expressID;
    let list = this.elements.get(mesh.expressID);
    if (!list) {
      list = [];
      this.elements.set(mesh.expressID, list);
    }

    const c = mesh.color;
    this.baseColor.set([c.r, c.g, c.b, c.a], p * 4);
    // A piece arriving for an element that is already hidden, highlighted or
    // recoloured joins it in that state: the API is per element.
    const sibling = list[0];
    if (sibling === undefined) {
      this.flags[p] = 0;
    } else {
      this.flags[p] = this.flags[sibling];
      this.overrideColor.copyWithin(p * 3, sibling * 3, sibling * 3 + 3);
      this.overrideOpacity[p] = this.overrideOpacity[sibling];
    }
    list.push(p);
    this.writeState(p);

    const vertexCount = mesh.vertices.length / 3;
    const indexCount = mesh.indices.length - (mesh.indices.length % 3);
    this.pieceVertexCount[p] = vertexCount;
    this.pieceIndexCount[p] = indexCount;
    this.pieceChunk[p] = null;
    if (vertexCount === 0 || indexCount === 0) {
      this.pieceIndexCount[p] = 0;
      this.pieceBox.fill(0, p * 6, p * 6 + 6);
      return;
    }

    // Place the piece in the world, in double precision, and record its
    // bounds; which chunk it joins depends on where it landed.
    const world = this.transformPositions(mesh.vertices, m, p);
    const transparent = c.a < OPAQUE_ALPHA;
    // A piece of half a chunk or more is a chunk on its own: merged, it
    // would only be copied again by every split that followed.
    const chunk = vertexCount * 2 >= this.cap ? this.soloChunk(p, transparent) : this.leafFor(p, transparent);
    this.ensureChunkCapacity(chunk, chunk.vertexCount + vertexCount, chunk.indexCount + indexCount);
    this.writePiece(chunk, p, world, mesh.normals, mesh.indices, indexCount, m);
    touched.add(chunk);

    if (chunk.vertexCount > this.cap && chunk.pieces.length > 1 && !chunk.unsplittable && !chunk.solo) {
      for (const c2 of this.splitLeaf(transparent ? this.transparentRoot! : this.opaqueRoot!, chunk)) {
        touched.add(c2);
      }
    }
  }

  private scratch = new Float64Array(3 * 4096);

  /** World positions of a piece, in double precision, into a scratch buffer. */
  private transformPositions(src: Float32Array, m: number[], p: number): Float64Array {
    if (this.scratch.length < src.length) this.scratch = new Float64Array(src.length * 2);
    const out = this.scratch;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[i] = wx;
      out[i + 1] = wy;
      out[i + 2] = wz;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
    this.pieceBox.set([minX, minY, minZ, maxX, maxY, maxZ], p * 6);
    return out;
  }

  /** Append a piece, given its world positions, to `chunk`. */
  private writePiece(
    chunk: Chunk,
    p: number,
    world: Float64Array,
    normals: Float32Array,
    indices: Uint32Array,
    indexCount: number,
    m: number[],
  ): void {
    const vStart = chunk.vertexCount;
    const iStart = chunk.indexCount;
    const vCount = this.pieceVertexCount[p];
    // Offsets from the anchor, subtracted in double before rounding to Float32.
    const { x: ax, y: ay, z: az } = chunk.anchor;
    const outP = chunk.positions;
    for (let i = 0, o = vStart * 3; i < vCount * 3; i += 3, o += 3) {
      outP[o] = world[i] - ax;
      outP[o + 1] = world[i + 1] - ay;
      outP[o + 2] = world[i + 2] - az;
    }

    _matrix.fromArray(m);
    _normalMatrix.getNormalMatrix(_matrix);
    const e = _normalMatrix.elements;
    const outN = chunk.normals;
    for (let i = 0, j = 0; i < vCount * 3; i += 3, j += 4) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2];
      let nx = e[0] * x + e[3] * y + e[6] * z;
      let ny = e[1] * x + e[4] * y + e[7] * z;
      let nz = e[2] * x + e[5] * y + e[8] * z;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      outN[vStart * 4 + j] = Math.round(nx * 127);
      outN[vStart * 4 + j + 1] = Math.round(ny * 127);
      outN[vStart * 4 + j + 2] = Math.round(nz * 127);
    }
    chunk.pieceIndex.fill(p, vStart, vStart + vCount);

    // A mirroring placement turns the triangles inside out; swap two corners
    // so the winding (and with it the lit side) stays right.
    const flip = _matrix.determinant() < 0;
    const outI = chunk.index;
    for (let i = 0; i < indexCount; i += 3) {
      outI[iStart + i] = indices[i] + vStart;
      outI[iStart + i + 1] = indices[flip ? i + 2 : i + 1] + vStart;
      outI[iStart + i + 2] = indices[flip ? i + 1 : i + 2] + vStart;
    }

    chunk.vertexCount += vCount;
    chunk.indexCount += indexCount;
    chunk.pieces.push(p);
    this.pieceChunk[p] = chunk;
    this.pieceVertexStart[p] = vStart;
    this.pieceIndexStart[p] = iStart;
    this.expandByPiece(chunk.box, p);
    if (this.effectiveAlpha(p) < OPAQUE_ALPHA && !chunk.transparent) chunk.overlayDirty = true;
  }

  private ensurePieceCapacity(n: number): void {
    if (this.flags.length >= n) return;
    const cap = Math.max(n, this.flags.length * 2);
    this.pieceExpressId = growInt32(this.pieceExpressId, cap);
    this.pieceVertexStart = growUint32(this.pieceVertexStart, cap);
    this.pieceVertexCount = growUint32(this.pieceVertexCount, cap);
    this.pieceIndexStart = growUint32(this.pieceIndexStart, cap);
    this.pieceIndexCount = growUint32(this.pieceIndexCount, cap);
    this.pieceBox = growFloat64(this.pieceBox, cap * 6);
    this.baseColor = growFloat32(this.baseColor, cap * 4);
    this.overrideColor = growFloat32(this.overrideColor, cap * 3);
    this.overrideOpacity = growFloat32(this.overrideOpacity, cap);
    this.flags = growUint8(this.flags, cap);
  }

  private expandByPiece(box: THREE.Box3, p: number): THREE.Box3 {
    const o = p * 6;
    const b = this.pieceBox;
    box.min.set(Math.min(box.min.x, b[o]), Math.min(box.min.y, b[o + 1]), Math.min(box.min.z, b[o + 2]));
    box.max.set(Math.max(box.max.x, b[o + 3]), Math.max(box.max.y, b[o + 4]), Math.max(box.max.z, b[o + 5]));
    return box;
  }

  private effectiveAlpha(p: number): number {
    return this.flags[p] & FLAG_OPACITY ? this.overrideOpacity[p] : this.baseColor[p * 4 + 3];
  }

  // ── Internals: state texture ─────────────────────────────────

  private writeState(p: number): void {
    const need = (p + 1) * FLOATS_PER_PIECE;
    if (this.stateData.length < need) this.growState(need);
    const d = this.stateData;
    const o = p * FLOATS_PER_PIECE;
    const f = this.flags[p];
    if (f & FLAG_COLOR) {
      d[o] = this.overrideColor[p * 3];
      d[o + 1] = this.overrideColor[p * 3 + 1];
      d[o + 2] = this.overrideColor[p * 3 + 2];
    } else {
      d[o] = this.baseColor[p * 4];
      d[o + 1] = this.baseColor[p * 4 + 1];
      d[o + 2] = this.baseColor[p * 4 + 2];
    }
    d[o + 3] = this.effectiveAlpha(p);
    d[o + 4] = f & FLAG_HIDDEN ? 1 : 0;
    d[o + 5] = f & FLAG_HIGHLIGHT ? 1 : 0;
    this.dirtyRows.add(Math.floor((p * TEXELS_PER_PIECE) / STATE_TEXTURE_WIDTH));
  }

  /** Rows of the state texture written since the last upload request. */
  private dirtyRows = new Set<number>();
  /** The state texture's next upload must be whole (new, or already asked for whole). */
  private stateWholePending = true;

  private growState(minFloats: number): void {
    const rowFloats = STATE_TEXTURE_WIDTH * 4;
    let rows = Math.max(1, this.stateData.length / rowFloats);
    while (rows * rowFloats < minFloats) rows *= 2;
    const data = new Float32Array(rows * rowFloats);
    data.set(this.stateData);
    this.stateData = data;
    const old = this.uniforms.pieceState.value;
    this.uniforms.pieceState.value = this.trackStateUploads(makeStateTexture(data));
    this.stateWholePending = true;
    old.dispose();
  }

  private trackStateUploads(texture: THREE.DataTexture): THREE.DataTexture {
    texture.onUpdate = () => {
      if (texture === this.uniforms.pieceState.value) this.stateWholePending = false;
    };
    return texture;
  }

  /**
   * Send what changed in the state texture: only the dirty rows (16 KB
   * each) when they are few, so selecting one element in a model of a
   * million pieces does not resend 32 MB. The first upload of a texture, or
   * one following a whole-texture request that has not happened yet, stays
   * whole — three uploads only the listed rows when any are listed, which
   * would leave the rest of a fresh texture undefined.
   */
  private uploadState(): void {
    if (this.dirtyRows.size === 0) return;
    const texture = this.uniforms.pieceState.value;
    const rows = texture.image.height;
    const rowFloats = STATE_TEXTURE_WIDTH * 4;
    if (this.stateWholePending || this.dirtyRows.size * 4 > rows) {
      texture.clearUpdateRanges();
      this.stateWholePending = true;
    } else {
      for (const row of this.dirtyRows) texture.addUpdateRange(row * rowFloats, rowFloats);
    }
    this.dirtyRows.clear();
    texture.needsUpdate = true;
  }

  private updateFlags(expressIds: Iterable<number>, flag: number, on: boolean): void {
    let changed = false;
    for (const id of expressIds) {
      const pieces = this.elements.get(id);
      if (!pieces) continue;
      for (const p of pieces) {
        const next = on ? this.flags[p] | flag : this.flags[p] & ~flag;
        if (next === this.flags[p]) continue;
        this.flags[p] = next;
        this.writeState(p);
        changed = true;
      }
    }
    if (changed) this.uploadState();
  }

  // ── Internals: chunks ────────────────────────────────────────

  private chunkOfMesh(mesh: ChunkMesh): Chunk | null {
    return (mesh.userData.chunk as Chunk | undefined) ?? null;
  }

  private newChunk(transparent: boolean, anchor: THREE.Vector3, vertexCapacity: number, indexCapacity: number): Chunk {
    const geometry = new THREE.BufferGeometry();
    const mesh = new ChunkMesh(this, geometry, transparent ? this.transparentMaterial : this.opaqueMaterial);
    mesh.position.copy(anchor);
    mesh.updateMatrix();
    const chunk: Chunk = {
      transparent,
      anchor: anchor.clone(),
      positions: new Float32Array(vertexCapacity * 3),
      normals: new Int8Array(vertexCapacity * 4),
      pieceIndex: new Float32Array(vertexCapacity),
      index: new Uint32Array(indexCapacity),
      vertexCount: 0,
      indexCount: 0,
      uploadedVertexCount: 0,
      uploadedIndexCount: 0,
      pieces: [],
      box: new THREE.Box3(),
      geometry: null,
      mesh,
      overlay: null,
      overlayDirty: false,
      unsplittable: false,
      solo: false,
    };
    mesh.userData.chunk = chunk;
    this.chunks.add(chunk);
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    return chunk;
  }

  /** The chunk piece `p` joins: its k-d leaf, or a new leaf beside it if that is out of reach. */
  private leafFor(p: number, transparent: boolean): Chunk {
    let node = transparent ? this.transparentRoot : this.opaqueRoot;
    if (!node) {
      node = this.newLeaf(p, transparent);
      if (transparent) this.transparentRoot = node;
      else this.opaqueRoot = node;
      return node.chunk!;
    }
    const centre = this.pieceCentre(p, _a);
    while (!node.chunk) node = centre.getComponent(node.axis) < node.split ? node.left! : node.right!;

    // Too far from the leaf's anchor to keep its precision: cut the leaf
    // between what it holds and this piece. No data moves — the old chunk
    // hangs on one side, a new one for this piece on the other.
    const anchor = node.chunk.anchor;
    let axis = 0;
    let far = -1;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(centre.getComponent(k) - anchor.getComponent(k));
      if (d > far) {
        far = d;
        axis = k;
      }
    }
    if (far <= ANCHOR_REACH) return node.chunk;
    // Every centre in the old chunk is within reach of its anchor, so the cut
    // lies strictly between them and this piece's centre.
    const c = centre.getComponent(axis);
    const a = anchor.getComponent(axis);
    const above = c > a;
    const old: KdNode = { chunk: node.chunk, axis: 0, split: 0, left: null, right: null };
    const fresh = this.newLeaf(p, transparent);
    node.chunk = null;
    node.axis = axis;
    node.split = above ? (a + ANCHOR_REACH + c) / 2 : (c + a - ANCHOR_REACH) / 2;
    node.left = above ? old : fresh;
    node.right = above ? fresh : old;
    return fresh.chunk!;
  }

  /** A leaf with an empty chunk anchored at piece `p`. */
  private newLeaf(p: number, transparent: boolean): KdNode {
    const c = this.pieceCentre(p, new THREE.Vector3());
    const anchor = new THREE.Vector3(Math.round(c.x), Math.round(c.y), Math.round(c.z));
    const vc = this.pieceVertexCount[p];
    const ic = this.pieceIndexCount[p];
    return {
      chunk: this.newChunk(transparent, anchor, Math.max(vc, 16384), Math.max(ic, 32768)),
      axis: 0,
      split: 0,
      left: null,
      right: null,
    };
  }

  /** An exactly sized chunk of its own for big piece `p`. */
  private soloChunk(p: number, transparent: boolean): Chunk {
    const c = this.pieceCentre(p, new THREE.Vector3());
    const anchor = new THREE.Vector3(Math.round(c.x), Math.round(c.y), Math.round(c.z));
    const chunk = this.newChunk(transparent, anchor, this.pieceVertexCount[p], this.pieceIndexCount[p]);
    chunk.solo = true;
    return chunk;
  }

  private pieceCentre(p: number, out: THREE.Vector3): THREE.Vector3 {
    const b = this.pieceBox;
    const o = p * 6;
    return out.set((b[o] + b[o + 3]) / 2, (b[o + 1] + b[o + 4]) / 2, (b[o + 2] + b[o + 5]) / 2);
  }

  private ensureChunkCapacity(chunk: Chunk, vertices: number, indices: number): void {
    const vCap = chunk.positions.length / 3;
    const iCap = chunk.index.length;
    if (vertices <= vCap && indices <= iCap) return;
    if (vertices > vCap) {
      const n = Math.max(vertices, vCap * 2);
      const positions = new Float32Array(n * 3);
      positions.set(chunk.positions.subarray(0, chunk.vertexCount * 3));
      const normals = new Int8Array(n * 4);
      normals.set(chunk.normals.subarray(0, chunk.vertexCount * 4));
      const pieceIndex = new Float32Array(n);
      pieceIndex.set(chunk.pieceIndex.subarray(0, chunk.vertexCount));
      chunk.positions = positions;
      chunk.normals = normals;
      chunk.pieceIndex = pieceIndex;
    }
    if (indices > iCap) {
      const index = new Uint32Array(Math.max(indices, iCap * 2));
      index.set(chunk.index.subarray(0, chunk.indexCount));
      chunk.index = index;
    }
    // New arrays: the GPU copy must be rebuilt from scratch.
    chunk.uploadedVertexCount = -1;
  }

  /**
   * Split the leaf holding `chunk` in two along the longest axis of the
   * chunk's bounds, at the median piece centre. Returns the chunks created.
   */
  private splitLeaf(root: KdNode, chunk: Chunk): Chunk[] {
    const leaf = findLeaf(root, chunk);
    if (!leaf) return [];
    const size = chunk.box.getSize(_a);
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    const centres = chunk.pieces.map((p) => (this.pieceBox[p * 6 + axis] + this.pieceBox[p * 6 + 3 + axis]) / 2);
    const sorted = Float64Array.from(centres).sort();
    let split = sorted[Math.floor(sorted.length / 2)];
    // All centres at or above the median would leave the left side empty.
    if (split <= sorted[0]) {
      const above = sorted.find((v) => v > split);
      if (above === undefined) {
        chunk.unsplittable = true;
        return [];
      }
      split = above;
    }

    const leftPieces: number[] = [];
    const rightPieces: number[] = [];
    chunk.pieces.forEach((p, i) => (centres[i] < split ? leftPieces : rightPieces).push(p));

    const left = this.chunkFromPieces(chunk, leftPieces);
    const right = this.chunkFromPieces(chunk, rightPieces);
    leaf.chunk = null;
    leaf.axis = axis;
    leaf.split = split;
    leaf.left = { chunk: left, axis: 0, split: 0, left: null, right: null };
    leaf.right = { chunk: right, axis: 0, split: 0, left: null, right: null };
    this.disposeChunk(chunk);
    this.chunks.delete(chunk);

    const made = [left, right];
    for (const child of [left, right]) {
      if (child.vertexCount > this.cap && child.pieces.length > 1) made.push(...this.splitLeaf(root, child));
    }
    return made.filter((c) => this.chunks.has(c));
  }

  /** A new chunk holding copies of `pieces` taken from `from`. */
  private chunkFromPieces(from: Chunk, pieces: number[]): Chunk {
    let vertices = 0;
    let indices = 0;
    for (const p of pieces) {
      vertices += this.pieceVertexCount[p];
      indices += this.pieceIndexCount[p];
    }
    // Room for a full chunk: the stream usually keeps feeding this region,
    // and a chunk that never regrows never needs a whole new GPU buffer
    // before its own split. The parent's anchor is kept, so positions copy
    // across unchanged.
    const room = Math.max(this.cap, vertices);
    const indexRoom = Math.max(indices * 2, Math.ceil((indices * room) / Math.max(vertices, 1)));
    const chunk = this.newChunk(from.transparent, from.anchor, room, indexRoom);
    for (const p of pieces) {
      const vStart = chunk.vertexCount;
      const iStart = chunk.indexCount;
      const oldV = this.pieceVertexStart[p];
      const oldI = this.pieceIndexStart[p];
      const vCount = this.pieceVertexCount[p];
      const iCount = this.pieceIndexCount[p];
      chunk.positions.set(from.positions.subarray(oldV * 3, (oldV + vCount) * 3), vStart * 3);
      chunk.normals.set(from.normals.subarray(oldV * 4, (oldV + vCount) * 4), vStart * 4);
      chunk.pieceIndex.fill(p, vStart, vStart + vCount);
      const delta = vStart - oldV;
      for (let i = 0; i < iCount; i++) chunk.index[iStart + i] = from.index[oldI + i] + delta;
      chunk.vertexCount += vCount;
      chunk.indexCount += iCount;
      chunk.pieces.push(p);
      this.pieceChunk[p] = chunk;
      this.pieceVertexStart[p] = vStart;
      this.pieceIndexStart[p] = iStart;
      this.expandByPiece(chunk.box, p);
      if (!chunk.transparent && this.effectiveAlpha(p) < OPAQUE_ALPHA) chunk.overlayDirty = true;
    }
    return chunk;
  }

  /** Hand a chunk's new data to the GPU: whole buffers if replaced, else just the tail. */
  private syncChunk(chunk: Chunk): void {
    if (!chunk.geometry || chunk.uploadedVertexCount < 0) {
      this.rebuildChunkGeometry(chunk);
      return;
    }
    const g = chunk.geometry;
    const v0 = chunk.uploadedVertexCount;
    const v1 = chunk.vertexCount;
    if (v1 > v0) {
      for (const name of VERTEX_ATTRIBUTES) uploadTail(g.getAttribute(name) as THREE.BufferAttribute, v0, v1);
    }
    const i0 = chunk.uploadedIndexCount;
    const i1 = chunk.indexCount;
    if (i1 > i0) uploadTail(g.getIndex()!, i0, i1);
    chunk.uploadedVertexCount = v1;
    chunk.uploadedIndexCount = i1;
    this.finishChunkSync(chunk);
  }

  private rebuildChunkGeometry(chunk: Chunk): void {
    const old = chunk.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 4, true));
    g.setAttribute('pieceIndex', new THREE.BufferAttribute(chunk.pieceIndex, 1));
    g.setIndex(new THREE.BufferAttribute(chunk.index, 1));
    // The first upload sends the whole array but leaves any ranges queued
    // before it in place, to be sent again with the next tail.
    for (const name of VERTEX_ATTRIBUTES) clearRangesOnUpload(g.getAttribute(name) as THREE.BufferAttribute);
    clearRangesOnUpload(g.getIndex()!);
    chunk.geometry = g;
    chunk.mesh.geometry = g;
    chunk.uploadedVertexCount = chunk.vertexCount;
    chunk.uploadedIndexCount = chunk.indexCount;
    old?.dispose();
    // The overlay shares the chunk's vertex buffers, so it follows.
    if (chunk.overlay) chunk.overlayDirty = true;
    this.finishChunkSync(chunk);
  }

  private finishChunkSync(chunk: Chunk): void {
    const g = chunk.geometry!;
    g.setDrawRange(0, chunk.indexCount);
    // The geometry's bounds are in chunk space; `chunk.box` is in the world.
    g.boundingBox = chunk.box.clone().translate(_b.copy(chunk.anchor).negate());
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (chunk.overlayDirty) this.rebuildOverlay(chunk);
  }

  /** Rebuild the index list of an opaque chunk's see-through pieces. */
  private rebuildOverlay(chunk: Chunk): void {
    chunk.overlayDirty = false;
    if (chunk.transparent || !chunk.geometry) return;
    let total = 0;
    for (const p of chunk.pieces) {
      if (this.effectiveAlpha(p) < OPAQUE_ALPHA) total += this.pieceIndexCount[p];
    }
    if (total === 0) {
      if (chunk.overlay) {
        this.group.remove(chunk.overlay);
        chunk.overlay.geometry.dispose();
        chunk.overlay = null;
      }
      return;
    }
    const index = new Uint32Array(total);
    let n = 0;
    for (const p of chunk.pieces) {
      if (this.effectiveAlpha(p) >= OPAQUE_ALPHA) continue;
      const s = this.pieceIndexStart[p];
      index.set(chunk.index.subarray(s, s + this.pieceIndexCount[p]), n);
      n += this.pieceIndexCount[p];
    }
    const g = new THREE.BufferGeometry();
    const src = chunk.geometry;
    g.setAttribute('position', src.getAttribute('position'));
    g.setAttribute('normal', src.getAttribute('normal'));
    g.setAttribute('pieceIndex', src.getAttribute('pieceIndex'));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingBox = src.boundingBox!.clone();
    g.boundingSphere = src.boundingSphere!.clone();
    if (chunk.overlay) {
      // Only the index is the overlay's own; the attributes belong to the chunk.
      disposeIndexOnly(chunk.overlay.geometry);
      chunk.overlay.geometry = g;
    } else {
      const overlay = new THREE.Mesh(g, this.transparentMaterial);
      overlay.matrixAutoUpdate = false;
      overlay.position.copy(chunk.anchor);
      overlay.updateMatrix();
      overlay.raycast = noRaycast;
      overlay.userData.isPieceOverlay = true;
      chunk.overlay = overlay;
      this.group.add(overlay);
      overlay.updateMatrixWorld(true);
    }
  }

  private disposeChunk(chunk: Chunk): void {
    this.group.remove(chunk.mesh);
    chunk.geometry?.dispose();
    chunk.geometry = null;
    if (chunk.overlay) {
      this.group.remove(chunk.overlay);
      disposeIndexOnly(chunk.overlay.geometry);
      chunk.overlay = null;
    }
  }
}

/** A chunk's per-vertex attributes; the index is handled on its own. */
const VERTEX_ATTRIBUTES = ['position', 'normal', 'pieceIndex'] as const;

/**
 * Queue elements `[from, to)` — counted in vertices, or in indices for an
 * index — for upload. Update ranges are in array elements, so the item size
 * comes from the attribute itself: normals are four bytes per vertex, not
 * three like positions.
 */
function uploadTail(attribute: THREE.BufferAttribute, from: number, to: number): void {
  const n = attribute.itemSize;
  attribute.addUpdateRange(from * n, (to - from) * n);
  attribute.needsUpdate = true;
}

/** The version of each buffer the GPU last received. */
const uploadedVersion = new WeakMap<THREE.BufferAttribute, number>();
/** CPU arrays to swap in as soon as the GPU has a buffer's current version. */
const afterUpload = new WeakMap<THREE.BufferAttribute, THREE.TypedArray>();

function clearRangesOnUpload(attribute: THREE.BufferAttribute): void {
  attribute.onUpload(() => {
    attribute.clearUpdateRanges();
    uploadedVersion.set(attribute, attribute.version);
    const next = afterUpload.get(attribute);
    if (next) swapArray(attribute, next);
  });
}

/**
 * Give `attribute` a smaller CPU array (a trimmed copy, or an empty one to
 * free it) once the GPU holds its current contents: now if it already does,
 * else right after the next upload, which must still send the full array.
 * The renderer never reads the array of an uploaded buffer that is not
 * marked for update, so the GPU buffer and `count` stay as they are.
 */
function replaceOnceUploaded(attribute: THREE.BufferAttribute, array: THREE.TypedArray): void {
  if (uploadedVersion.get(attribute) === attribute.version) swapArray(attribute, array);
  else afterUpload.set(attribute, array);
}

function swapArray(attribute: THREE.BufferAttribute, array: THREE.TypedArray): void {
  (attribute as { array: THREE.TypedArray }).array = array;
  afterUpload.delete(attribute);
}

function findLeaf(node: KdNode | null, chunk: Chunk): KdNode | null {
  if (!node) return null;
  if (node.chunk) return node.chunk === chunk ? node : null;
  return findLeaf(node.left, chunk) ?? findLeaf(node.right, chunk);
}

function makeStateTexture(data: Float32Array): THREE.DataTexture {
  const height = data.length / (STATE_TEXTURE_WIDTH * 4);
  const texture = new THREE.DataTexture(data, STATE_TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Dispose an overlay geometry without releasing the vertex buffers it borrows
 * from its chunk. `BufferGeometry.dispose` only fires an event; the renderer
 * frees the buffers of every attribute the geometry lists, so the borrowed
 * attributes are detached first.
 */
function disposeIndexOnly(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
  geometry.dispose();
}
