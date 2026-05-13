import * as WebIFC from 'web-ifc';

export interface ParsedMesh {
  expressID: number;
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  transform: number[];
  color: { r: number; g: number; b: number; a: number };
}

export interface ParsedModel {
  id: string;
  modelID: number;
  meshes: ParsedMesh[];
}

export class IfcParser {
  // Public so App can route the web-ifc modelID through the property repository.
  // Kept open after parse; App owns CloseModel on remove / reset / dispose.
  api: WebIFC.IfcAPI | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    this.api = new WebIFC.IfcAPI();
    // WASM files are in public/ — Vite serves them at BASE_URL in both dev and prod
    this.api.SetWasmPath(import.meta.env.BASE_URL, false);
    await this.api.Init();
    this.initialized = true;
  }

  async parse(buffer: ArrayBuffer, id: string): Promise<ParsedModel> {
    if (!this.api || !this.initialized) {
      throw new Error('IfcParser not initialized. Call init() first.');
    }

    const data = new Uint8Array(buffer);
    const modelID = this.api.OpenModel(data);
    const meshes: ParsedMesh[] = [];

    this.api.StreamAllMeshes(modelID, (flatMesh: WebIFC.FlatMesh) => {
      for (let i = 0; i < flatMesh.geometries.size(); i++) {
        const placedGeom = flatMesh.geometries.get(i);
        const geom = this.api!.GetGeometry(modelID, placedGeom.geometryExpressID);

        const verts = this.api!.GetVertexArray(
          geom.GetVertexData(),
          geom.GetVertexDataSize(),
        );
        const idxs = this.api!.GetIndexArray(
          geom.GetIndexData(),
          geom.GetIndexDataSize(),
        );

        // Extract vertices (position only, stride of 6: x,y,z,nx,ny,nz)
        const positions = new Float32Array((verts.length / 6) * 3);
        const normals = new Float32Array((verts.length / 6) * 3);
        for (let j = 0; j < verts.length / 6; j++) {
          positions[j * 3] = verts[j * 6];
          positions[j * 3 + 1] = verts[j * 6 + 1];
          positions[j * 3 + 2] = verts[j * 6 + 2];
          normals[j * 3] = verts[j * 6 + 3];
          normals[j * 3 + 1] = verts[j * 6 + 4];
          normals[j * 3 + 2] = verts[j * 6 + 5];
        }

        const color = placedGeom.color;
        const transform = Array.from(placedGeom.flatTransformation);

        meshes.push({
          expressID: flatMesh.expressID,
          vertices: positions,
          normals,
          indices: new Uint32Array(idxs),
          transform,
          color: { r: color.x, g: color.y, b: color.z, a: color.w },
        });

        geom.delete();
      }
      // Free the inner Vector<PlacedGeometry> in WASM heap. Verified via
      // runtime inspection: `flatMesh` itself is a plain JS object (no
      // `.delete` despite the d.ts claim — that's the trap), but
      // `flatMesh.geometries` is an emscripten-bound vector that DOES
      // have `.delete` and DOES leak its heap allocation if not freed.
      // The d.ts for Vector<T> omits `.delete` even though it exists at
      // runtime — cast through unknown to satisfy the typechecker.
      (flatMesh.geometries as unknown as { delete(): void }).delete();
    });

    // NOTE: model is intentionally kept open after parse.
    // The Element Properties Inspector (Phase 1+) needs the web-ifc heap
    // for property queries. Lifetime is now owned by App: CloseModel is
    // called from App.removeModel, App.resetView, and App.dispose.

    return { id, modelID, meshes };
  }

  dispose(): void {
    if (this.api) {
      this.api.Dispose();
      this.api = null;
      this.initialized = false;
    }
  }
}
