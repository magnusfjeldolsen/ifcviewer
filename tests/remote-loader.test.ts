import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteLoader } from '../src/loader/RemoteLoader';

// IFC header bytes for a valid stub
const IFC_HEADER = 'ISO-10303-21;';
function makeIfcBuffer(): ArrayBuffer {
  return new TextEncoder().encode(IFC_HEADER + '\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;').buffer;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl as typeof globalThis.fetch);
}

describe('RemoteLoader', () => {
  let loader: RemoteLoader;

  beforeEach(() => {
    loader = new RemoteLoader();
    vi.restoreAllMocks();
  });

  it('should return ok with a valid IFC file', async () => {
    const buffer = makeIfcBuffer();
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(buffer.byteLength) },
        });
      }
      return new Response(buffer, {
        status: 200,
        headers: { 'content-length': String(buffer.byteLength) },
      });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('ok');
    expect(result.file).toBeDefined();
    expect(result.file!.name).toBe('model.ifc');
    expect(result.file!.buffer.byteLength).toBe(buffer.byteLength);
  });

  it('should return auth on 401', async () => {
    mockFetch(async () => new Response(null, { status: 401 }));

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('auth');
  });

  it('should return auth on 403', async () => {
    mockFetch(async () => new Response(null, { status: 403 }));

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('auth');
  });

  it('should return not-found on 404', async () => {
    mockFetch(async () => new Response(null, { status: 404 }));

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('not-found');
  });

  it('should return not-ifc when file lacks IFC header', async () => {
    const htmlBuffer = new TextEncoder().encode('<html>Not an IFC</html>').buffer;
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }
      return new Response(htmlBuffer, { status: 200 });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('not-ifc');
  });

  it('should return too-large when content-length exceeds limit', async () => {
    mockFetch(async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-length': String(600 * 1024 * 1024) },
      }),
    );

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('too-large');
  });

  it('should return cors on TypeError (CORS or network failure)', async () => {
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
      throw new TypeError('Failed to fetch');
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('cors');
  });

  it('should pass Authorization header when token is provided', async () => {
    const buffer = makeIfcBuffer();
    const spy = mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }
      return new Response(buffer, { status: 200 });
    });

    await loader.fetch('https://example.com/model.ifc', 'my-token');

    // Check the GET call (second call after HEAD)
    const getCall = spy.mock.calls.find(
      (call) => !(call[1] as RequestInit)?.method || (call[1] as RequestInit)?.method !== 'HEAD',
    );
    expect(getCall).toBeDefined();
    const headers = (getCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  it('should extract filename from URL', async () => {
    const buffer = makeIfcBuffer();
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response(buffer, { status: 200 });
    });

    const result = await loader.fetch(
      'https://example.com/path/to/Snowdon%20Towers.ifc',
    );
    expect(result.status).toBe('ok');
    expect(result.file!.name).toBe('Snowdon Towers.ifc');
  });

  it('should fall through HEAD failure and proceed with GET', async () => {
    const buffer = makeIfcBuffer();
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') throw new TypeError('CORS blocked');
      return new Response(buffer, { status: 200 });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('ok');
  });
});
