import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/loader/urlNormalizer';

describe('normalizeUrl', () => {
  describe('GitHub URLs', () => {
    it('should rewrite github.com blob URL to raw.githubusercontent.com', () => {
      const result = normalizeUrl(
        'https://github.com/user/repo/blob/main/path/to/model.ifc',
      );
      expect(result.url).toBe(
        'https://raw.githubusercontent.com/user/repo/main/path/to/model.ifc',
      );
      expect(result.provider).toBe('GitHub');
    });

    it('should handle branch names with slashes', () => {
      const result = normalizeUrl(
        'https://github.com/user/repo/blob/feature/branch/model.ifc',
      );
      // The regex captures "feature" as ref and "branch/model.ifc" as path
      expect(result.url).toBe(
        'https://raw.githubusercontent.com/user/repo/feature/branch/model.ifc',
      );
      expect(result.provider).toBe('GitHub');
    });

    it('should handle URL-encoded filenames', () => {
      const result = normalizeUrl(
        'https://github.com/magnusfjeldolsen/ifcviewer/blob/main/assets/ifcs/Snowdon%20Towers%20Sample%20Structural.ifc',
      );
      expect(result.url).toBe(
        'https://raw.githubusercontent.com/magnusfjeldolsen/ifcviewer/main/assets/ifcs/Snowdon%20Towers%20Sample%20Structural.ifc',
      );
      expect(result.provider).toBe('GitHub');
    });

    it('should not rewrite raw.githubusercontent.com URLs', () => {
      const rawUrl =
        'https://raw.githubusercontent.com/user/repo/main/model.ifc';
      const result = normalizeUrl(rawUrl);
      expect(result.url).toBe(rawUrl);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('GitLab URLs', () => {
    it('should rewrite gitlab.com blob URL to raw URL', () => {
      const result = normalizeUrl(
        'https://gitlab.com/user/repo/-/blob/main/model.ifc',
      );
      expect(result.url).toBe(
        'https://gitlab.com/user/repo/-/raw/main/model.ifc',
      );
      expect(result.provider).toBe('GitLab');
    });
  });

  describe('Dropbox URLs', () => {
    it('should rewrite dl=0 to dl=1', () => {
      const result = normalizeUrl(
        'https://www.dropbox.com/s/abc123/model.ifc?dl=0',
      );
      expect(result.url).toBe(
        'https://www.dropbox.com/s/abc123/model.ifc?dl=1',
      );
      expect(result.provider).toBe('Dropbox');
    });

    it('should not touch URLs that already have dl=1', () => {
      const url = 'https://www.dropbox.com/s/abc123/model.ifc?dl=1';
      const result = normalizeUrl(url);
      expect(result.url).toBe(url);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('Unknown URLs', () => {
    it('should pass through unrecognized URLs unchanged', () => {
      const url = 'https://example.com/models/building.ifc';
      const result = normalizeUrl(url);
      expect(result.url).toBe(url);
      expect(result.provider).toBeUndefined();
    });

    it('should pass through presigned S3 URLs unchanged', () => {
      const url =
        'https://my-bucket.s3.amazonaws.com/model.ifc?X-Amz-Signature=abc123';
      const result = normalizeUrl(url);
      expect(result.url).toBe(url);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('SharePoint / OneDrive for Business', () => {
    // Verified 2026-08-25 against a live share with a real browser fetch():
    // status 200, type "cors", body beginning ISO-10303-21;. The obvious
    // alternatives all fail - see the rule's comment.
    const share =
      'https://tommerdal-my.sharepoint.com/:u:/g/personal/magnus_tommerdal_no/IQBM-IAzud6TR4ftWsdMvSSTAYSme54ZH1oNIbvSIXKv_oM?e=4dL3As';

    it('rewrites a personal share link to the anonymous download endpoint', () => {
      const result = normalizeUrl(share);
      expect(result.url).toBe(
        'https://tommerdal-my.sharepoint.com/personal/magnus_tommerdal_no/_layouts/15/download.aspx?share=IQBM-IAzud6TR4ftWsdMvSSTAYSme54ZH1oNIbvSIXKv_oM',
      );
      expect(result.provider).toBe('SharePoint');
    });

    it('drops the ?e= share token, which the download endpoint does not take', () => {
      expect(normalizeUrl(share).url).not.toContain('e=4dL3As');
    });

    it('handles a site collection as well as a personal drive', () => {
      const result = normalizeUrl(
        'https://contoso.sharepoint.com/:u:/g/sites/Project/EaBcDeF123?e=xyz',
      );
      expect(result.url).toBe(
        'https://contoso.sharepoint.com/sites/Project/_layouts/15/download.aspx?share=EaBcDeF123',
      );
    });

    it('handles other share-type segments than :u:', () => {
      // SharePoint varies the middle segment by item type (:u: :b: :f: ...).
      const result = normalizeUrl(
        'https://contoso.sharepoint.com/:b:/g/personal/someone_contoso_com/ABC123?e=1',
      );
      expect(result.provider).toBe('SharePoint');
      expect(result.url).toContain('download.aspx?share=ABC123');
    });

    it('leaves an already-direct download URL alone', () => {
      const direct =
        'https://contoso.sharepoint.com/personal/x/_layouts/15/download.aspx?share=ABC';
      const result = normalizeUrl(direct);
      expect(result.url).toBe(direct);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('Google Drive', () => {
    it('rewrites a /file/d/<id>/view share link to the download host', () => {
      const result = normalizeUrl(
        'https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing',
      );
      expect(result.url).toBe(
        'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjK&export=download&confirm=t',
      );
      expect(result.provider).toBe('Google Drive');
    });

    it('rewrites the open?id= form', () => {
      const result = normalizeUrl('https://drive.google.com/open?id=1AbCdEfGhIjK');
      expect(result.url).toContain('id=1AbCdEfGhIjK');
      expect(result.provider).toBe('Google Drive');
    });

    it('carries confirm=t, without which Drive serves an HTML scan warning', () => {
      // Every real IFC is large enough to trigger the virus-scan interstitial,
      // so this parameter is the difference between bytes and an HTML page.
      expect(
        normalizeUrl('https://drive.google.com/file/d/XYZ/view').url,
      ).toContain('confirm=t');
    });

    it('leaves an already-direct usercontent URL alone', () => {
      const direct =
        'https://drive.usercontent.google.com/download?id=XYZ&export=download&confirm=t';
      const result = normalizeUrl(direct);
      expect(result.url).toBe(direct);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('Dropbox — modern link shapes', () => {
    // The previous rule required `?dl=0` at the very END of the URL. Every
    // link Dropbox has issued for years is `.../scl/fi/...?rlkey=...&dl=0`,
    // so the rule could not match a single real link.
    it('rewrites dl=0 when it is not the last parameter', () => {
      const result = normalizeUrl(
        'https://www.dropbox.com/scl/fi/abc123/model.ifc?rlkey=xyz&dl=0&st=aaa',
      );
      expect(result.url).toBe(
        'https://www.dropbox.com/scl/fi/abc123/model.ifc?rlkey=xyz&dl=1&st=aaa',
      );
      expect(result.provider).toBe('Dropbox');
    });

    it('rewrites dl=0 when it is last', () => {
      const result = normalizeUrl(
        'https://www.dropbox.com/scl/fi/abc123/model.ifc?rlkey=xyz&dl=0',
      );
      expect(result.url).toContain('dl=1');
      expect(result.url).not.toContain('dl=0');
    });

    it('appends dl=1 when the flag is absent entirely', () => {
      const result = normalizeUrl(
        'https://www.dropbox.com/scl/fi/abc123/model.ifc?rlkey=xyz',
      );
      expect(result.url).toBe(
        'https://www.dropbox.com/scl/fi/abc123/model.ifc?rlkey=xyz&dl=1',
      );
    });

    it('appends dl=1 to a link with no query string at all', () => {
      const result = normalizeUrl('https://www.dropbox.com/s/abc123/model.ifc');
      expect(result.url).toBe('https://www.dropbox.com/s/abc123/model.ifc?dl=1');
    });

    it('does not double-rewrite a link that already has dl=1', () => {
      const url = 'https://www.dropbox.com/scl/fi/abc/model.ifc?rlkey=x&dl=1';
      const result = normalizeUrl(url);
      expect(result.url).toBe(url);
      expect(result.provider).toBeUndefined();
    });
  });

  describe('provider reporting', () => {
    it('only names a provider when the URL actually changed', () => {
      // `provider` drives "Detected <X> link, using direct download URL." in
      // the UI, so announcing a rewrite that did not happen is a small lie.
      const untouched = normalizeUrl('https://example.com/model.ifc');
      expect(untouched.provider).toBeUndefined();
    });
  });
});
