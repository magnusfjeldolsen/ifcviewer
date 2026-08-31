import { describe, it, expect } from 'vitest';
import { checkRemoteUrl } from '../src/loader/urlSafety';

/**
 * The trust distinction under test: a URL the user typed is theirs, a URL
 * that arrived inside a shared link was authored by someone else. Only the
 * second one can be used to make a browser reach somewhere it shouldn't.
 */
describe('checkRemoteUrl', () => {
  describe('schemes — rejected regardless of who supplied the URL', () => {
    for (const source of ['user', 'link'] as const) {
      it(`rejects javascript: from ${source}`, () => {
        const result = checkRemoteUrl('javascript:alert(1)', source);
        expect(result.ok).toBe(false);
      });

      it(`rejects data: from ${source}`, () => {
        const result = checkRemoteUrl('data:text/plain,ISO-10303-21;', source);
        expect(result.ok).toBe(false);
      });

      it(`rejects file: from ${source}`, () => {
        const result = checkRemoteUrl('file:///C:/models/a.ifc', source);
        expect(result.ok).toBe(false);
      });

      it(`rejects unparseable input from ${source}`, () => {
        expect(checkRemoteUrl('not a url', source).ok).toBe(false);
        expect(checkRemoteUrl('', source).ok).toBe(false);
      });
    }
  });

  describe('a URL the user typed themselves', () => {
    it('accepts https', () => {
      expect(checkRemoteUrl('https://example.com/a.ifc', 'user').ok).toBe(true);
    });

    it('accepts plain http', () => {
      expect(checkRemoteUrl('http://example.com/a.ifc', 'user').ok).toBe(true);
    });

    // The user explicitly wants to load from a NAS on the local network.
    // Typing that address is not the attack we are defending against.
    it('accepts a private-network NAS address', () => {
      expect(checkRemoteUrl('http://192.168.1.50/share/a.ifc', 'user').ok).toBe(true);
    });

    it('accepts localhost', () => {
      expect(checkRemoteUrl('http://localhost:8080/a.ifc', 'user').ok).toBe(true);
    });
  });

  describe('a URL that arrived in a shared link', () => {
    it('accepts a public https URL', () => {
      expect(checkRemoteUrl('https://example.com/a.ifc', 'link').ok).toBe(true);
    });

    it('rejects plain http, so a link cannot downgrade the transport', () => {
      const result = checkRemoteUrl('http://example.com/a.ifc', 'link');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/https/i);
    });

    it('rejects loopback', () => {
      expect(checkRemoteUrl('https://127.0.0.1/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://localhost/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://[::1]/a.ifc', 'link').ok).toBe(false);
    });

    it('rejects RFC1918 private ranges', () => {
      expect(checkRemoteUrl('https://10.0.0.5/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://172.16.0.1/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://172.31.255.254/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://192.168.1.50/a.ifc', 'link').ok).toBe(false);
    });

    // 172.16/12 is the private block — 172.32 is ordinary public space.
    // Getting this boundary wrong in the permissive direction is a hole;
    // getting it wrong the other way blocks real hosts.
    it('does not mistake 172.32 for a private address', () => {
      expect(checkRemoteUrl('https://172.32.0.1/a.ifc', 'link').ok).toBe(true);
      expect(checkRemoteUrl('https://172.15.0.1/a.ifc', 'link').ok).toBe(true);
    });

    // 169.254.169.254 is the cloud instance-metadata address. Worth its own
    // test because it is the single most-targeted internal endpoint there is.
    it('rejects link-local, including the cloud metadata address', () => {
      expect(checkRemoteUrl('https://169.254.169.254/latest/meta-data/', 'link').ok).toBe(false);
    });

    it('rejects IPv6 unique-local and link-local', () => {
      expect(checkRemoteUrl('https://[fd00::1]/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://[fe80::1]/a.ifc', 'link').ok).toBe(false);
    });

    it('rejects intranet names — mDNS and bare single-label hosts', () => {
      expect(checkRemoteUrl('https://nas.local/a.ifc', 'link').ok).toBe(false);
      expect(checkRemoteUrl('https://fileserver/a.ifc', 'link').ok).toBe(false);
    });

    it('accepts the providers the app actually rewrites to', () => {
      expect(
        checkRemoteUrl(
          'https://tommerdal-my.sharepoint.com/personal/x/_layouts/15/download.aspx?share=abc',
          'link',
        ).ok,
      ).toBe(true);
      expect(
        checkRemoteUrl('https://drive.usercontent.google.com/download?id=abc', 'link').ok,
      ).toBe(true);
    });

    it('gives a reason a user can act on', () => {
      const result = checkRemoteUrl('https://192.168.1.50/a.ifc', 'link');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.reason).toMatch(/private|local network/i);
      }
    });
  });
});
