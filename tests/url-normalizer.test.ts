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
});
