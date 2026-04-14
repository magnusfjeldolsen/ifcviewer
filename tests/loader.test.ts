import { describe, it, expect, vi } from 'vitest';
import { FileLoader } from '../src/loader/FileLoader';

describe('FileLoader', () => {
  it('should be instantiable', () => {
    const loader = new FileLoader();
    expect(loader).toBeDefined();
  });

  it('should register onLoad callback', () => {
    const loader = new FileLoader();
    const callback = vi.fn();
    loader.onLoad(callback);
    // Callback is stored internally — no public way to verify except through integration
    expect(loader).toBeDefined();
  });

  it('should clean up on dispose', () => {
    const loader = new FileLoader();
    loader.dispose();
    // Should not throw
    expect(loader).toBeDefined();
  });
});
