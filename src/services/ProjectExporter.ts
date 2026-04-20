import type { CameraState, ModelRecord } from './SessionStore';

export interface ProjectManifest {
  version: 1;
  exportedAt: string;
  camera?: CameraState;
  models: ModelRecord[];
}

export class ProjectExporter {
  async exportProject(
    models: ModelRecord[],
    camera: CameraState | undefined,
    getBuffer: (id: string) => Promise<ArrayBuffer | null>,
  ): Promise<Blob> {
    const { zipSync } = await import('fflate');

    const manifest: ProjectManifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      camera,
      models,
    };

    const files: Record<string, Uint8Array> = {
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    };

    // Only include buffers for local models
    for (const model of models) {
      if (model.source.type === 'local') {
        const buffer = await getBuffer(model.id);
        if (buffer) {
          files[`buffers/${model.id}.ifc`] = new Uint8Array(buffer);
        }
      }
    }

    const zipped = zipSync(files, { level: 6 });
    return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  }

  async importProject(blob: Blob): Promise<{
    manifest: ProjectManifest;
    buffers: Map<string, ArrayBuffer>;
    warnings: string[];
  }> {
    const { unzipSync } = await import('fflate');
    const warnings: string[] = [];

    let entries: Record<string, Uint8Array>;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      entries = unzipSync(new Uint8Array(arrayBuffer));
    } catch {
      throw new Error('Invalid project file — not a valid zip archive');
    }

    // Parse and validate manifest
    const manifestBytes = entries['manifest.json'];
    if (!manifestBytes) {
      throw new Error('Invalid project file — missing manifest.json');
    }

    let manifest: ProjectManifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      throw new Error('Invalid project file — corrupt manifest.json');
    }

    if (!manifest.version || !Array.isArray(manifest.models)) {
      throw new Error('Invalid project file — manifest missing required fields');
    }

    // Extract buffers with integrity checks
    const buffers = new Map<string, ArrayBuffer>();
    for (const model of manifest.models) {
      if (model.source.type !== 'local') continue;

      const key = `buffers/${model.id}.ifc`;
      const data = entries[key];

      if (!data) {
        warnings.push(`Buffer missing for "${model.name}" — will show as unavailable`);
        continue;
      }

      if (model.sizeBytes > 0 && data.byteLength !== model.sizeBytes) {
        warnings.push(
          `Buffer size mismatch for "${model.name}" (expected ${model.sizeBytes}, got ${data.byteLength}) — skipping`,
        );
        continue;
      }

      buffers.set(model.id, (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength));
    }

    return { manifest, buffers, warnings };
  }
}
