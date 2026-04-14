import { describe, it, expect } from 'vitest';

describe('Smoke test', () => {
  it('should pass basic assertion', () => {
    expect(true).toBe(true);
  });

  it('should have access to Three.js', async () => {
    const THREE = await import('three');
    expect(THREE.Scene).toBeDefined();
    expect(THREE.PerspectiveCamera).toBeDefined();
    expect(THREE.WebGLRenderer).toBeDefined();
  });

  it('should have access to web-ifc', async () => {
    const WebIFC = await import('web-ifc');
    expect(WebIFC.IfcAPI).toBeDefined();
  });
});
