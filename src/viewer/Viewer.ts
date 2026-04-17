import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { raycastVisible } from '../utils/raycast';

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private canvas: HTMLCanvasElement;
  private animationId: number | null = null;
  private updateCallbacks: Array<() => void> = [];

  // Pivot picking state
  private pickingPivot = false;
  private pivotTransitioning = false;
  private mouse = new THREE.Vector2();
  private pivotMarker: THREE.Mesh | null = null;
  private defaultTarget = new THREE.Vector3();
  private boundPivotKeydown!: (e: KeyboardEvent) => void;
  private boundPivotClick!: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(10, 10, 10);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('start', () => {
      this.pivotTransitioning = false;
    });

    this.setupLights();
    this.setupGrid();
    this.setupPivotPicking();

    window.addEventListener('resize', this.onResize);
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onUpdate(callback: () => void): void {
    this.updateCallbacks.push(callback);
  }

  getCameraState(): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } {
    return {
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: this.controls.target.x, y: this.controls.target.y, z: this.controls.target.z },
    };
  }

  restoreCameraState(state: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }): void {
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.controls.target.set(state.target.x, state.target.y, state.target.z);
    this.controls.update();
  }

  animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    if (!this.pivotTransitioning) {
      this.controls.update();
    }
    for (const cb of this.updateCallbacks) cb();
    this.updatePivotMarkerScale();
    this.renderer.render(this.scene, this.camera);
  };

  fitToBox(box: THREE.Box3): void {
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 1.5;

    this.camera.position.set(
      center.x + distance,
      center.y + distance * 0.7,
      center.z + distance,
    );
    this.camera.near = distance * 0.01;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.update();

    // Store as default for reset
    this.defaultTarget.copy(center);
  }

  resetPivot(): void {
    this.controls.target.copy(this.defaultTarget);
    this.controls.update();
    this.removePivotMarker();
  }

  clearPivot(): void {
    if (this.pickingPivot) this.cancelPivotPicking();
    this.removePivotMarker();
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.boundPivotKeydown);
    this.canvas.removeEventListener('click', this.boundPivotClick);
    this.removePivotMarker();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(10, 20, 10);
    this.scene.add(directional);
  }

  private setupGrid(): void {
    const grid = new THREE.GridHelper(50, 50);
    this.scene.add(grid);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  // ── Pivot picking ────────────────────────────────────────

  private setupPivotPicking(): void {
    this.boundPivotKeydown = (e: KeyboardEvent) => {
      if (e.key === 'v' || e.key === 'V') {
        if (this.pickingPivot) {
          this.cancelPivotPicking();
        } else {
          this.startPivotPicking();
        }
      }
      if (e.key === 'Escape' && this.pickingPivot) {
        this.cancelPivotPicking();
      }
    };

    this.boundPivotClick = (e: MouseEvent) => {
      if (!this.pickingPivot) return;
      this.placePivot(e);
    };

    document.addEventListener('keydown', this.boundPivotKeydown);
    this.canvas.addEventListener('click', this.boundPivotClick);
  }

  private startPivotPicking(): void {
    this.pickingPivot = true;
    this.canvas.style.cursor = 'crosshair';
  }

  private cancelPivotPicking(): void {
    this.pickingPivot = false;
    this.canvas.style.cursor = '';
  }

  private placePivot(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const hit = raycastVisible(this.mouse, this.camera, this.scene, this.renderer);
    if (!hit) {
      this.cancelPivotPicking();
      return;
    }

    const point = hit.point;
    this.controls.target.copy(point);
    this.pivotTransitioning = true;

    this.showPivotMarker(point);
    this.cancelPivotPicking();
  }

  private showPivotMarker(point: THREE.Vector3): void {
    this.removePivotMarker();

    const geom = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      depthTest: false,
      transparent: true,
      opacity: 0.6,
    });
    this.pivotMarker = new THREE.Mesh(geom, mat);
    this.pivotMarker.position.copy(point);
    this.pivotMarker.renderOrder = 998;
    this.pivotMarker.userData.isPivotMarker = true;
    this.scene.add(this.pivotMarker);
  }

  private updatePivotMarkerScale = (): void => {
    if (!this.pivotMarker) return;
    const dist = this.camera.position.distanceTo(this.pivotMarker.position);
    const scale = dist * 0.008;
    this.pivotMarker.scale.setScalar(scale);
  };

  private removePivotMarker(): void {
    if (this.pivotMarker) {
      this.scene.remove(this.pivotMarker);
      this.pivotMarker.geometry.dispose();
      (this.pivotMarker.material as THREE.Material).dispose();
      this.pivotMarker = null;
    }
  }
}
