import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { formatDistance } from './measureMath';
import type { MeasurementView } from './measurementViews';
import type { MeasurementEnd } from './MeasurementStore';
import { labelWorldHeight } from './labelScale';

/**
 * Everything a measurement looks like, and nothing about what it means.
 *
 * Split out of `MeasurementTool`, which had grown to six jobs — pointer
 * handling, placement state, preview geometry, label sprites, marker scaling
 * and store synchronisation — in one class that cannot be constructed under
 * test. Snapping adds three glyph kinds and orthogonal drawing on top of that,
 * so the two halves were separated first.
 *
 * The boundary is deliberately narrow: this class is handed a list of
 * `MeasurementView`s and makes the scene match. It knows nothing about the
 * store, the selection vocabulary or the placement state machine, so there is
 * no path by which a rendering change can alter what a measurement *is*.
 *
 * It still needs WebGL and a 2D canvas context, so most of it has no unit
 * tests. That is the point of moving it here: it is now the only part that
 * does. The one exception is where lines are placed, which
 * `measurement-line-precision.test.ts` checks with a stand-in 2D context.
 */

/** Yellow — a measurement nobody is pointing at. */
const LINE_COLOR = 0xfacc15;
/** Pale yellow — the cursor is on this measurement; a click would take it. */
const LINE_COLOR_HOVER = 0xfef9c3;
/** Brand blue — selected; `Delete` would remove this one. */
const LINE_COLOR_SELECTED = 0x3b82f6;

/**
 * Drawn width in screen pixels. `THREE.LineBasicMaterial.linewidth` cannot do
 * this — WebGL guarantees only a 1-pixel line, and on ANGLE/D3D11 (most
 * Windows machines, this one included) `ALIASED_LINE_WIDTH_RANGE` really is
 * `[1, 1]`, so the old hairline could not be widened at all. `Line2` draws
 * screen-space quads instead, which is why it is worth the extra draw path.
 */
const LINE_WIDTH_PX = 3;
const LINE_WIDTH_PX_ACTIVE = 4;

const MARKER_SCREEN_SIZE = 0.006;
const HOVER_MARKER_SCREEN_SIZE = 0.005;

/** The extension line is dimmer and thinner than any measurement. */
const EXTENSION_COLOR = 0x94a3b8;
const EXTENSION_WIDTH_PX = 1.5;

/** What an end with nothing snapped looks like — used for the projection foot. */
const PLAIN_END = { target: 'point' } as const;

const START_MARKER_COLOR = 0x22c55e;
const END_MARKER_COLOR = 0xef4444;

/**
 * Each end shows what it caught, so a measurement can be read without
 * remembering how it was made — which matters more than usual here, because
 * the same two clicks in the other order mean a different thing.
 *
 *   surface — a small square lying in the surface
 *   edge    — a short segment along the edge
 *   vertex  — a hollow ring, turned to face the camera
 *   point   — a filled dot, as before
 */
const GLYPH_SEGMENTS = 16;

/** The hover glyph is white so it reads as "not placed yet". */
const HOVER_COLOR = 0xffffff;

/** Scratch for `updateLabel`, so the per-frame label pass allocates nothing. */
const scratchForward = new THREE.Vector3();
const scratchOffset = new THREE.Vector3();

export interface MeasurementRendererDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
}

export class MeasurementRenderer {
  private deps: MeasurementRendererDeps;

  /** Scene group per measurement id. Mirrors the views last synced. */
  private groups = new Map<string, THREE.Group>();
  /** The line of each measurement, so hover / selection can restyle it. */
  private lines = new Map<string, Line2>();

  /** The glyph that follows the cursor over geometry. */
  private hoverMarker: THREE.Group | null = null;
  /** Which glyph the hover marker currently is, so it is rebuilt only on a change. */
  private hoverGlyph: string | null = null;
  /** The marker on a placed first point, before the second is picked. */
  private pendingStartMarker: THREE.Group | null = null;

  /** Live preview, shown while the second point is being chosen. */
  private previewLine: Line2 | null = null;
  private previewExtension: Line2 | null = null;
  private previewLabel: THREE.Sprite | null = null;
  /** Every live label, so each can be resized on a frame without walking the scene. */
  private labels = new Set<THREE.Sprite>();

  constructor(deps: MeasurementRendererDeps) {
    this.deps = deps;
  }

  /**
   * Make the scene match `views`: build what is new, drop what is gone, and
   * apply visibility and colour. The single entry point for committed
   * measurements — add, delete, clear, restore and model-hide all arrive here,
   * so there is one place the visuals can drift from.
   */
  sync(views: readonly MeasurementView[]): void {
    const live = new Set<string>();

    for (const view of views) {
      live.add(view.id);
      if (!this.groups.has(view.id)) this.build(view);
      const group = this.groups.get(view.id);
      if (group) group.visible = view.visible;
    }

    for (const [id, group] of [...this.groups]) {
      if (live.has(id)) continue;
      this.disposeGroup(group);
      this.groups.delete(id);
      this.lines.delete(id);
    }

    this.restyle(views);
  }

  /**
   * Show what the cursor has caught, in the shape of the thing it caught.
   *
   * Rebuilt whenever the kind changes rather than reused, because the glyph
   * *is* the feedback: a measuring tool that snaps invisibly is one the user
   * cannot trust, and a single white dot for every kind of snap is
   * indistinguishable from no snapping at all.
   */
  showHoverMarker(position: THREE.Vector3, end?: MeasurementEnd, axis?: THREE.Vector3): void {
    const signature = glyphSignature(end);
    if (!this.hoverMarker || this.hoverGlyph !== signature) {
      this.hideHoverMarker();
      this.hoverMarker = this.createPointMarker(position, HOVER_COLOR, end, axis, 0.6);
      this.hoverGlyph = signature;
      this.deps.scene.add(this.hoverMarker);
    }

    this.hoverMarker.position.copy(position);
    // An edge glyph has to keep pointing along the edge, and a surface glyph
    // along its normal, as the cursor travels over changing geometry.
    reorientGlyph(this.hoverMarker, end, axis);
  }

  hideHoverMarker(): void {
    if (!this.hoverMarker) return;
    this.disposeGroup(this.hoverMarker);
    this.hoverMarker = null;
    this.hoverGlyph = null;
  }

  /**
   * Mark a placed first point while the second is being chosen. Keeps its
   * glyph, because what it caught — a surface or not — is half of what
   * decides what the finished measurement will mean.
   */
  showPendingStart(position: THREE.Vector3, end?: MeasurementEnd, axis?: THREE.Vector3): void {
    this.hidePendingStart();
    this.pendingStartMarker = this.createPointMarker(position, START_MARKER_COLOR, end, axis);
    this.deps.scene.add(this.pendingStartMarker);
  }

  hidePendingStart(): void {
    if (!this.pendingStartMarker) return;
    this.disposeGroup(this.pendingStartMarker);
    this.pendingStartMarker = null;
  }

  /**
   * The dashed line and live distance of the measurement the next click would
   * make. `anchorAt` names the end the surface plate belongs to: the start
   * when the surface was picked first, the end (under the cursor) when it is
   * the one being hovered.
   */
  showPreview(
    start: THREE.Vector3,
    end: THREE.Vector3,
    anchor?: THREE.Vector3,
    anchorAt: 'start' | 'end' = 'start',
  ): void {
    const distance = start.distanceTo(end);

    // The extension line has to follow the cursor too, or the plate appears
    // detached from the measurement right up to the moment of the click.
    if (anchor) {
      const foot = anchorAt === 'end' ? end : start;
      if (this.previewExtension) {
        this.setLinePoints(this.previewExtension, anchor, foot);
      } else {
        this.previewExtension = this.createExtensionLine(anchor, foot);
        this.deps.scene.add(this.previewExtension);
      }
    } else if (this.previewExtension) {
      this.removePreviewExtension();
    }

    if (this.previewLine) {
      this.setLinePoints(this.previewLine, start, end);
    } else {
      this.previewLine = this.createLine(start, end, LINE_COLOR, LINE_WIDTH_PX, true);
      this.deps.scene.add(this.previewLine);
    }

    this.removePreviewLabel();
    this.previewLabel = this.createLabel(distance);
    this.previewLabel.position.addVectors(start, end).multiplyScalar(0.5);
    this.updateLabel(this.previewLabel);
    this.deps.scene.add(this.previewLabel);
  }

  hidePreview(): void {
    this.removePreviewExtension();
    if (this.previewLine) {
      this.deps.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine.material.dispose();
      this.previewLine = null;
    }
    this.removePreviewLabel();
  }

  /**
   * Per-frame upkeep: markers hold a constant screen size, and every fat line's
   * resolution tracks the canvas or its apparent thickness drifts after a
   * resize. Called from the render loop before each draw.
   */
  updateScales(): void {
    for (const group of this.groups.values()) this.scaleMarkers(group);
    if (this.pendingStartMarker) this.scaleMarkers(this.pendingStartMarker);
    if (this.hoverMarker) {
      const dist = this.deps.camera.position.distanceTo(this.hoverMarker.position);
      this.hoverMarker.scale.setScalar(dist * HOVER_MARKER_SCREEN_SIZE);
    }

    for (const label of this.labels) this.updateLabel(label);

    const width = this.canvasWidth();
    const height = this.canvasHeight();
    for (const line of this.lines.values()) line.material.resolution.set(width, height);
    this.previewLine?.material.resolution.set(width, height);
    this.previewExtension?.material.resolution.set(width, height);
  }

  dispose(): void {
    this.hidePreview();
    this.hideHoverMarker();
    this.hidePendingStart();
    for (const group of this.groups.values()) this.disposeGroup(group);
    this.groups.clear();
    this.lines.clear();
    this.labels.clear();
  }

  // ── Building ───────────────────────────────────────────────

  private build(view: MeasurementView): void {
    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    group.userData.measurementId = view.id;

    const distance = view.start.distanceTo(view.end);

    // For an orthogonal measurement the drawn segment IS the surface normal,
    // so the square glyph can be oriented from it without storing a plane.
    const axis = view.end.clone().sub(view.start);

    // The surface marker stays where it was put, like a plate held against a
    // wall; the measurement strikes the plane square from the target, which
    // lands at the foot instead. A thin dashed line joins the two so it is
    // obvious they lie on the same plane — the extension line of an ordinary
    // dimension. The plate belongs to whichever end picked the surface.
    const ends = [
      { at: 'start', point: view.start, color: START_MARKER_COLOR, snap: view.startSnap },
      { at: 'end', point: view.end, color: END_MARKER_COLOR, snap: view.endSnap },
    ] as const;
    const plateAt = view.anchor ? (view.anchorAt ?? 'start') : null;
    for (const end of ends) {
      if (view.anchor && plateAt === end.at) {
        group.add(this.createPointMarker(view.anchor, end.color, end.snap, axis));
        group.add(this.createPointMarker(end.point, end.color, PLAIN_END, axis));
        group.add(this.createExtensionLine(view.anchor, end.point));
      } else {
        group.add(this.createPointMarker(end.point, end.color, end.snap, axis));
      }
    }

    const line = this.createLine(view.start, view.end, LINE_COLOR, LINE_WIDTH_PX, false);
    group.add(line);
    this.lines.set(view.id, line);

    const label = this.createLabel(distance);
    label.position.addVectors(view.start, view.end).multiplyScalar(0.5);
    this.updateLabel(label);
    group.add(label);

    this.deps.scene.add(group);
    this.groups.set(view.id, group);
  }

  /** Apply the normal / hovered / selected colour to every measurement line. */
  private restyle(views: readonly MeasurementView[]): void {
    for (const view of views) {
      const line = this.lines.get(view.id);
      if (!line) continue;
      const active = view.selected || view.hovered;
      line.material.color.setHex(
        view.selected ? LINE_COLOR_SELECTED : view.hovered ? LINE_COLOR_HOVER : LINE_COLOR,
      );
      line.material.linewidth = active ? LINE_WIDTH_PX_ACTIVE : LINE_WIDTH_PX;
    }
  }

  /**
   * A fat line. See `LINE_WIDTH_PX` for why `Line2` rather than a plain line.
   */
  private createLine(
    start: THREE.Vector3,
    end: THREE.Vector3,
    color: number,
    width: number,
    dashed: boolean,
  ): Line2 {
    const material = new LineMaterial({
      color,
      linewidth: width,
      depthTest: false,
      transparent: true,
      dashed,
      dashSize: 0.1,
      gapSize: 0.05,
    });
    material.resolution.set(this.canvasWidth(), this.canvasHeight());

    const line = new Line2(new LineGeometry(), material);
    this.setLinePoints(line, start, end);
    line.renderOrder = 1000;
    // Line2 extends THREE.Mesh, so without this flag `raycastVisible` would
    // collect it and a measurement could steal clicks from the geometry it
    // annotates — the exact regression the screen-space pick path avoids.
    line.userData.isMeasurement = true;
    return line;
  }

  /**
   * The thin dashed run along the plane from the clicked point to the foot.
   * Never the measurement itself — it carries no number and is drawn thinner
   * so it cannot be mistaken for one.
   */
  private createExtensionLine(from: THREE.Vector3, to: THREE.Vector3): Line2 {
    const line = this.createLine(from, to, EXTENSION_COLOR, EXTENSION_WIDTH_PX, true);
    line.material.opacity = 0.7;
    return line;
  }

  /**
   * Put a fat line between two world points, held by its start.
   *
   * The geometry stores the end relative to the start, and the start goes in
   * the object's position — never both points as raw world coordinates. The
   * GPU works in 32-bit floats, which far from the origin cannot place a point
   * any closer than half a metre (a Norwegian northing is about 6 650 000 m),
   * and where it rounds to moves with the camera: the line jumped about on
   * every orbit while its markers stayed put (#105). An object's position is
   * combined with the camera in double precision before the GPU sees it, which
   * is how the model batches and the markers stay still.
   */
  private setLinePoints(line: Line2, start: THREE.Vector3, end: THREE.Vector3): void {
    line.position.copy(start);
    line.geometry.setPositions([0, 0, 0, end.x - start.x, end.y - start.y, end.z - start.z]);
    line.computeLineDistances();
  }

  private canvasWidth(): number {
    return this.deps.canvas.clientWidth || this.deps.canvas.width || 1;
  }

  private canvasHeight(): number {
    return this.deps.canvas.clientHeight || this.deps.canvas.height || 1;
  }

  private createPointMarker(
    position: THREE.Vector3,
    color: number,
    end?: MeasurementEnd,
    axis?: THREE.Vector3,
    opacity = 0.9,
  ): THREE.Group {
    const markerGroup = new THREE.Group();
    markerGroup.userData.isMeasurement = true;
    markerGroup.userData.isMeasurementMarker = true;
    markerGroup.position.copy(position);

    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
    });

    const target = end?.target ?? 'point';
    let mesh: THREE.Object3D;

    if (target === 'face' && axis) {
      // A square lying in the surface: its own normal is the measurement's
      // direction, which for an orthogonal measurement is the surface normal.
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
    } else if (target === 'edge' && end?.direction) {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 6), mat);
      // Cylinders are built along y; lay it along the edge.
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        end.direction.clone().normalize(),
      );
    } else if (target === 'vertex') {
      mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.3, GLYPH_SEGMENTS), mat);
      // A ring is only legible face-on, so it is turned to the camera every
      // frame by `scaleMarkers`.
      markerGroup.userData.billboard = true;
    } else if (target === 'centre') {
      mesh = centreGlyph(mat);
      // The same face-on treatment as the corner ring, which it must not be
      // mistaken for: the cross through it is what says "centre".
      markerGroup.userData.billboard = true;
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 10), mat);
    }

    mesh.renderOrder = 1000;
    mesh.userData.isMeasurement = true;
    markerGroup.add(mesh);

    return markerGroup;
  }

  private createLabel(distance: number): THREE.Sprite {
    const text = formatDistance(distance);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Size canvas to fit text
    const fontSize = 64;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    const padding = 20;
    canvas.width = metrics.width + padding * 2;
    canvas.height = fontSize + padding * 2;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 12);
    ctx.fill();

    // Text
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 1001;
    sprite.userData.isMeasurement = true;
    // Never a pick target (D9): it is the only part of a measurement with real
    // screen area, and it grows without bound as the camera closes in.
    sprite.userData.isMeasurementLabel = true;
    sprite.userData.aspect = canvas.width / canvas.height;
    this.labels.add(sprite);

    return sprite;
  }

  private removePreviewExtension(): void {
    if (!this.previewExtension) return;
    this.deps.scene.remove(this.previewExtension);
    this.previewExtension.geometry.dispose();
    this.previewExtension.material.dispose();
    this.previewExtension = null;
  }

  private removePreviewLabel(): void {
    if (!this.previewLabel) return;
    this.labels.delete(this.previewLabel);
    this.deps.scene.remove(this.previewLabel);
    this.previewLabel.material.map?.dispose();
    this.previewLabel.material.dispose();
    this.previewLabel = null;
  }

  /**
   * Hold a label at `LABEL_HEIGHT_PX` on screen (#57). The width follows the
   * texture's own aspect, since the text — and so the canvas — varies in length.
   */
  private updateLabel(sprite: THREE.Sprite): void {
    const camera = this.deps.camera;
    camera.getWorldDirection(scratchForward);
    scratchOffset.subVectors(sprite.position, camera.position);
    const depth = scratchOffset.dot(scratchForward);
    const height = labelWorldHeight(depth, camera.fov, this.canvasHeight());
    const aspect = (sprite.userData.aspect as number | undefined) ?? 2;
    sprite.scale.set(height * aspect, height, 1);
  }

  private scaleMarkers(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Group && child.userData.isMeasurementMarker) {
        const dist = this.deps.camera.position.distanceTo(child.position);
        child.scale.setScalar(dist * MARKER_SCREEN_SIZE);
        if (child.userData.billboard) child.quaternion.copy(this.deps.camera.quaternion);
      }
    });
  }

  private disposeGroup(group: THREE.Group): void {
    this.deps.scene.remove(group);
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      if (child instanceof THREE.Sprite) {
        this.labels.delete(child);
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * The centre glyph: a thin ring with a cross through it, the drafting mark for
 * a centre point. Larger than the corner ring so the two read differently even
 * at a glance.
 */
function centreGlyph(mat: THREE.MeshBasicMaterial): THREE.Group {
  const glyph = new THREE.Group();
  const parts: THREE.Mesh[] = [
    new THREE.Mesh(new THREE.RingGeometry(1.35, 1.65, GLYPH_SEGMENTS * 2), mat),
    new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.28), mat),
    new THREE.Mesh(new THREE.PlaneGeometry(0.28, 4.2), mat),
  ];
  for (const part of parts) {
    part.renderOrder = 1000;
    part.userData.isMeasurement = true;
    glyph.add(part);
  }
  return glyph;
}

/** Identifies which glyph an end needs, so the hover marker rebuilds only on a change. */
function glyphSignature(end: MeasurementEnd | undefined): string {
  return end?.target ?? 'point';
}

/**
 * Point a live glyph at the thing it is describing. Only the oriented kinds
 * need it — a dot and a ring have no direction of their own, and the ring is
 * turned to the camera every frame anyway.
 */
function reorientGlyph(
  group: THREE.Group,
  end: MeasurementEnd | undefined,
  axis: THREE.Vector3 | undefined,
): void {
  const mesh = group.children[0];
  if (!mesh) return;
  if (end?.target === 'face' && axis) {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
  } else if (end?.target === 'edge' && end.direction) {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.direction.clone().normalize());
  }
}
