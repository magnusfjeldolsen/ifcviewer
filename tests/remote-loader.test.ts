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

  it('still enforces the size limit when HEAD is rejected', async () => {
    // The regression this guards: the 500 MB check used to live ONLY in the
    // HEAD pre-check, which is wrapped in a try/catch that falls through to
    // GET. Google Drive's download endpoint serves GET but rejects HEAD, so
    // on the one provider most likely to hold a huge file the guard silently
    // stopped guarding — and the browser would try to buffer the whole thing.
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(600 * 1024 * 1024) },
      });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('too-large');
  });

  it('still enforces the size limit when HEAD throws (CORS-blocked)', async () => {
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(600 * 1024 * 1024) },
      });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('too-large');
  });

  it('does not reject a file that is under the limit on the GET path', async () => {
    // The guard must not become so eager that it blocks ordinary loads.
    mockFetch(async (_url, init) => {
      if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
      return new Response(makeIfcBuffer(), {
        status: 200,
        headers: { 'content-length': '1024' },
      });
    });

    const result = await loader.fetch('https://example.com/model.ifc');
    expect(result.status).toBe('ok');
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

  describe('naming the downloaded model', () => {
    function respondWith(disposition?: string) {
      const buffer = makeIfcBuffer();
      mockFetch(
        async () =>
          new Response(buffer, {
            status: 200,
            headers: disposition ? { 'content-disposition': disposition } : {},
          }),
      );
    }

    // The case this exists for: SharePoint's download endpoint has no filename
    // in its path, so the URL alone yields "download.aspx". The real name is in
    // the header, and SharePoint lists Content-Disposition in
    // Access-Control-Expose-Headers, so a browser is allowed to read it.
    it('prefers the name in Content-Disposition over the URL path', async () => {
      respondWith(
        "attachment;filename*=utf-8''Project%2DTestConcrete%2Eifc;filename=\"Project-TestConcrete.ifc\"",
      );

      const result = await loader.fetch(
        'https://tommerdal-my.sharepoint.com/personal/x/_layouts/15/download.aspx?share=abc',
      );

      expect(result.file!.name).toBe('Project-TestConcrete.ifc');
    });

    it('reads the plain quoted form when that is all the server sends', async () => {
      respondWith('attachment; filename="Bygg A - Konstruksjon.ifc"');

      const result = await loader.fetch('https://example.com/d?id=7');

      expect(result.file!.name).toBe('Bygg A - Konstruksjon.ifc');
    });

    // The header comes from a third-party server we do not operate, and the
    // name it yields becomes a model name shown in the UI and used as a
    // session-storage key. Keep only the last path segment.
    it('keeps only the final segment, so a path in the header cannot escape', async () => {
      respondWith('attachment; filename="../../../etc/passwd"');

      const result = await loader.fetch('https://example.com/d?id=7');

      expect(result.file!.name).toBe('passwd');
    });

    it('ignores a backslash-separated path too', async () => {
      respondWith('attachment; filename="C:\\\\Windows\\\\evil.ifc"');

      const result = await loader.fetch('https://example.com/d?id=7');

      expect(result.file!.name).toBe('evil.ifc');
    });

    // Both forms are present in real SharePoint headers, so a bad extended
    // value must not abandon the header — the plain one is still good.
    it('uses the plain form when the extended one sanitises away to nothing', async () => {
      respondWith("attachment; filename*=utf-8''%2F%2F; filename=\"Good.ifc\"");

      const result = await loader.fetch('https://example.com/d?id=7');

      expect(result.file!.name).toBe('Good.ifc');
    });

    it('falls back to the URL when the header carries no usable name', async () => {
      respondWith('attachment; filename=""');

      const result = await loader.fetch('https://example.com/path/Real.ifc');

      expect(result.file!.name).toBe('Real.ifc');
    });
  });
});
