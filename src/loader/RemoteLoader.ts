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

function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const decoded = decodeURIComponent(pathname.split('/').pop() || 'model.ifc');
    return decoded;
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

    const name = extractFilename(url);
    return {
      status: 'ok',
      file: { name, buffer },
      message: `Loaded ${name}`,
      contentLength: buffer.byteLength,
    };
  }
}
