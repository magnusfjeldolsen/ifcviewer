import type { LoadedFile } from './FileLoader';

export type RemoteStatus =
  | 'ok'
  | 'cors'
  | 'auth'
  | 'not-found'
  | 'not-ifc'
  | 'too-large'
  | 'network-error'
  | 'timeout';

export interface RemoteFetchResult {
  status: RemoteStatus;
  file?: LoadedFile;
  message: string;
  contentLength?: number;
}

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const FETCH_TIMEOUT = 120_000; // 2 minutes
const IFC_HEADER = 'ISO-10303-21';
const MAX_FILENAME_LENGTH = 200;

/**
 * Reduce a name to something safe to show as a model's label.
 *
 * It can come from a server we do not operate, or from a URL someone was sent,
 * and it is rendered in the Models panel. So: keep only the final path segment,
 * and drop characters that let a name lie about itself. Bidi overrides are the
 * one worth naming — `evil‮fci.exe` renders as `evil.ifc` — and they cost
 * one character class to remove.
 *
 * It is *not* a storage key. Models are keyed by UUID and cached geometry by
 * content hash (see `SessionStore`); the name is only ever a displayed field.
 *
 * Returns null when nothing usable is left, so the caller can fall back.
 */
function sanitizeFilename(raw: string): string | null {
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment
    // C0 and C1 control characters, DEL, and the bidi overrides.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .slice(0, MAX_FILENAME_LENGTH)
    // After the slice, so truncation cannot leave a trailing space behind.
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

/**
 * Recover the file's real name from a `Content-Disposition` header.
 *
 * Needed because a provider's download endpoint often has no name in its path
 * — SharePoint's is `_layouts/15/download.aspx?share=<id>`, which would leave
 * every model called `download.aspx`. The name is in the header instead, and
 * SharePoint lists `Content-Disposition` in `Access-Control-Expose-Headers`,
 * so a cross-origin read is allowed. That last claim is the one thing here
 * that automated tests cannot check — a mocked `Response` is same-origin and
 * never exercises CORS header filtering — so it belongs in the manual test.
 * If it were false the header reads as null and we fall back to the URL, which
 * is the old behaviour rather than a failure.
 *
 * Returns null when there is no usable name, leaving the caller to fall back
 * to the URL path.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  // RFC 5987 `filename*=UTF-8''percent%20encoded` wins when present: it is the
  // form that survives non-ASCII, and SharePoint sends both.
  // Anchored to a parameter boundary so `xfilename=` cannot masquerade as it.
  const extended = /(?:^|;)\s*filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
  if (extended) {
    try {
      // Only return on success: a value that sanitises away to nothing should
      // fall through to the plain form, not abandon the header entirely.
      const decoded = sanitizeFilename(decodeURIComponent(extended[1].trim()));
      if (decoded) return decoded;
    } catch {
      // A malformed percent-sequence falls through to the plain form below.
    }
  }

  // The plain form. Quoted when it contains spaces, bare otherwise; stop the
  // bare form at the next parameter separator.
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (plain) {
    const value = (plain[1] ?? plain[2] ?? '').trim();
    if (value) return sanitizeFilename(value);
  }

  return null;
}

/**
 * Last resort: name the model after the last segment of its URL.
 *
 * Sanitised on the same terms as a header-supplied name — a URL is no more
 * trustworthy than a header, since both arrive from whoever sent the link, and
 * percent-decoding a path can produce control characters just as easily.
 */
function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const decoded = decodeURIComponent(pathname.split('/').pop() || '');
    return sanitizeFilename(decoded) ?? 'model.ifc';
  } catch {
    return 'model.ifc';
  }
}

export class RemoteLoader {
  async fetch(
    url: string,
    token?: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<RemoteFetchResult> {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // HEAD pre-check
    try {
      const headResp = await globalThis.fetch(url, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (headResp.status === 401 || headResp.status === 403) {
        return { status: 'auth', message: 'This file requires authentication.' };
      }
      if (headResp.status === 404) {
        return { status: 'not-found', message: 'File not found at this URL.' };
      }

      const contentLength = Number(headResp.headers.get('content-length') || 0);
      if (contentLength > MAX_FILE_SIZE) {
        const sizeMB = Math.round(contentLength / 1024 / 1024);
        return {
          status: 'too-large',
          message: `File is too large (${sizeMB} MB). Maximum is 500 MB.`,
          contentLength,
        };
      }
    } catch {
      // HEAD may be CORS-blocked or unsupported — fall through to GET
    }

    // GET the file
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { status: 'timeout', message: 'Download timed out.' };
      }
      // CORS errors and network failures both surface as TypeError
      return {
        status: 'cors',
        message:
          "Couldn't fetch this file. The server may not allow browser access (CORS). Try downloading the file and uploading it instead.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'auth', message: 'This file requires authentication.' };
    }
    if (response.status === 404) {
      return { status: 'not-found', message: 'File not found at this URL.' };
    }
    if (!response.ok) {
      return {
        status: 'network-error',
        message: `Server returned ${response.status} ${response.statusText}.`,
      };
    }

    // Read with progress tracking
    const contentLength = Number(response.headers.get('content-length') || 0);

    // Re-check the size here, not only in the HEAD pre-check above. That
    // check is wrapped in a try/catch that falls through to this GET, so on
    // any host that rejects or CORS-blocks HEAD the guard silently stopped
    // guarding — and Google Drive's download endpoint is exactly such a host.
    // Failing open on the one provider we most expect to serve huge files is
    // worse than having no guard at all, because it looks like it is working.
    if (contentLength > MAX_FILE_SIZE) {
      const sizeMB = Math.round(contentLength / 1024 / 1024);
      return {
        status: 'too-large',
        message: `File is too large (${sizeMB} MB). Maximum is 500 MB.`,
      };
    }

    let buffer: ArrayBuffer;

    if (onProgress && response.body && contentLength > 0) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(received, contentLength);
      }

      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      buffer = merged.buffer;
    } else {
      buffer = await response.arrayBuffer();
    }

    // Validate IFC header
    const headerBytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64));
    const headerText = new TextDecoder().decode(headerBytes);
    if (!headerText.includes(IFC_HEADER)) {
      return {
        status: 'not-ifc',
        message: "This doesn't appear to be an IFC file.",
      };
    }

    const name =
      filenameFromDisposition(response.headers.get('content-disposition')) ??
      extractFilename(url);
    return {
      status: 'ok',
      file: { name, buffer },
      message: `Loaded ${name}`,
      contentLength: buffer.byteLength,
    };
  }
}
