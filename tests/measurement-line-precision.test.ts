// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as THREE from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { MeasurementRenderer } from '../src/tools/MeasurementRenderer';
import type { MeasurementView } from '../src/tools/measurementViews';

/**
 * Issue #105: a placed measurement line jumped about whenever the camera
 * moved, while its end markers and the model stayed put.
 *
 * The GPU transforms a line's vertices in 32-bit floats. A georeferenced
 * model sits hundreds of kilometres from the origin (Norwegian northings are
 * near 6 650 000 m), where a 32-bit float can only say where a point is to
 * within half a metre. The model and the end markers avoid that by keeping
 * their large offset in the object's position, which three combines with the
 * camera in double precision before the GPU sees it. The line stored its two
 * points as raw world coordinates, so every camera move rounded it somewhere
 * new.
 *
 * WebGL is not available here, so this does what the vertex shader does: take
 * the model-view matrix three would upload, round it and the vertex to 32-bit
 * floats, multiply in 32-bit arithmetic, and compare with the exact answer.
 */

const f = Math.fround;

/** `modelViewMatrix * position` the way a 32-bit vertex shader computes it. */
function viewPositionOnGpu(modelView: THREE.Matrix4, local: [number, number, number]): THREE.Vector3 {
  const m = modelView.elements.map(f);
  const p = [f(local[0]), f(local[1]), f(local[2]), 1];
  const out = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    let sum = 0;
    for (let col = 0; col < 4; col++) sum = f(sum + f(m[col * 4 + row] * p[col]));
    out[row] = sum;
  }
  return new THREE.Vector3(out[0], out[1], out[2]);
}

/** The two ends of a fat line, as stored in its geometry (local space). */
function localEnds(line: Line2): [number, number, number][] {
  const s = line.geometry.attributes.instanceStart;
  const e = line.geometry.attributes.instanceEnd;
  return [
    [s.getX(0), s.getY(0), s.getZ(0)],
    [e.getX(0), e.getY(0), e.getZ(0)],
  ];
}

/** Worst distance, in metres, between where the GPU draws an end and where it is. */
function worstGpuError(line: Line2, camera: THREE.Camera, ends: THREE.Vector3[]): number {
  line.updateWorldMatrix(true, false);
  camera.updateMatrixWorld();
  const modelView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, line.matrixWorld);
  return Math.max(
    ...localEnds(line).map((local, i) => {
      const exact = ends[i].clone().applyMatrix4(camera.matrixWorldInverse);
      return viewPositionOnGpu(modelView, local).distanceTo(exact);
    }),
  );
}

function linesIn(scene: THREE.Scene): Line2[] {
  const lines: Line2[] = [];
  scene.traverse((o) => {
    if ((o as Line2).isLine2) lines.push(o as Line2);
  });
  return lines;
}

/** Survey coordinates of the size a Norwegian model has, a few metres apart. */
const START = new THREE.Vector3(512345.678, 41.25, -6654321.987);
const END = new THREE.Vector3(512349.321, 44.75, -6654318.432);

function setup(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: MeasurementRenderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 1000);
  // A couple of metres away, looking at the line: close enough that half a
  // metre of rounding is most of the screen.
  camera.position.copy(START).add(new THREE.Vector3(1.3, 1.1, 1.7));
  camera.lookAt(START.clone().lerp(END, 0.5));
  const canvas = document.createElement('canvas');
  const renderer = new MeasurementRenderer({ scene, camera, canvas });
  return { scene, camera, renderer };
}

function view(overrides: Partial<MeasurementView> = {}): MeasurementView {
  return {
    id: 'm1',
    start: START.clone(),
    end: END.clone(),
    visible: true,
    selected: false,
    hovered: false,
    startSnap: { target: 'point' },
    endSnap: { target: 'point' },
    ...overrides,
  };
}

// jsdom has no 2D canvas; the label only needs something that answers.
const fakeContext = {
  font: '',
  fillStyle: '',
  textAlign: '',
  textBaseline: '',
  measureText: () => ({ width: 100 }),
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  quadraticCurveTo: () => {},
  closePath: () => {},
  fill: () => {},
  fillText: () => {},
};

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext) as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

const ONE_MM = 0.001;

describe('measurement lines far from the origin (#105)', () => {
  it('a placed line is drawn where its points are, to the millimetre', () => {
    const { scene, camera, renderer } = setup();
    renderer.sync([view()]);

    const [line] = linesIn(scene);
    expect(line).toBeDefined();
    expect(worstGpuError(line, camera, [START, END])).toBeLessThan(ONE_MM);
  });

  it('stays put as the camera moves, rather than rounding somewhere new each frame', () => {
    const { scene, camera, renderer } = setup();
    renderer.sync([view()]);
    const [line] = linesIn(scene);

    const base = camera.position.clone();
    for (let i = 0; i < 20; i++) {
      camera.position.copy(base).add(new THREE.Vector3(i * 0.0137, -i * 0.0091, i * 0.0049));
      camera.lookAt(START.clone().lerp(END, 0.5));
      expect(worstGpuError(line, camera, [START, END])).toBeLessThan(ONE_MM);
    }
  });

  it('the extension line to a surface plate is held to the same precision', () => {
    const { scene, camera, renderer } = setup();
    const anchor = START.clone().add(new THREE.Vector3(0.8, 0, -0.6));
    renderer.sync([view({ anchor, anchorAt: 'start', startSnap: { target: 'face' } })]);

    const extension = linesIn(scene).find((l) => l.material.dashed);
    expect(extension).toBeDefined();
    expect(worstGpuError(extension!, camera, [anchor, START])).toBeLessThan(ONE_MM);
  });

  it('the live preview line is held to the same precision as it follows the cursor', () => {
    const { scene, camera, renderer } = setup();
    renderer.showPreview(START, END);
    const nextEnd = END.clone().add(new THREE.Vector3(0.25, 0.1, -0.3));
    renderer.showPreview(START, nextEnd);

    const [preview] = linesIn(scene);
    expect(worstGpuError(preview, camera, [START, nextEnd])).toBeLessThan(ONE_MM);
  });

  it('keeps the drawn length and the dash pattern of the line it replaces', () => {
    const { scene, renderer } = setup();
    renderer.showPreview(START, END);
    const [preview] = linesIn(scene);

    // The dashes are laid out along this distance, so it has to be the real length.
    expect(preview.geometry.attributes.instanceDistanceEnd.getX(0)).toBeCloseTo(START.distanceTo(END), 3);
  });
});
