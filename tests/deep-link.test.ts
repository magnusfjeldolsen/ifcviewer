import { describe, it, expect } from 'vitest';
import { parseDeepLink, moveUrlParamToHash } from '../src/core/deepLink';

/**
 * A share link carries a URL that is itself the credential — "anyone with
 * the link" means the token in it *is* the password. In the query string it
 * reaches Google Analytics (page_location), the Referer header and browser
 * history. In the fragment it reaches none of them, because fragments are
 * never sent to a server.
 */
describe('parseDeepLink', () => {
  it('reads a URL from the fragment', () => {
    const link = parseDeepLink('', '#url=https%3A%2F%2Fexample.com%2Fa.ifc');
    expect(link.url).toBe('https://example.com/a.ifc');
    expect(link.fromQuery).toBe(false);
  });

  it('still reads the legacy query form, and flags it for scrubbing', () => {
    const link = parseDeepLink('?url=https%3A%2F%2Fexample.com%2Fa.ifc', '');
    expect(link.url).toBe('https://example.com/a.ifc');
    expect(link.fromQuery).toBe(true);
  });

  it('prefers the fragment when both are present', () => {
    const link = parseDeepLink(
      '?url=https%3A%2F%2Fquery.example.com%2Fa.ifc',
      '#url=https%3A%2F%2Ffragment.example.com%2Fa.ifc',
    );
    expect(link.url).toBe('https://fragment.example.com/a.ifc');
    expect(link.fromQuery).toBe(false);
  });

  it('returns nothing when neither is present', () => {
    expect(parseDeepLink('', '').url).toBeNull();
    expect(parseDeepLink('?other=1', '#section').url).toBeNull();
  });

  it('survives a share link whose own query survived encoding', () => {
    const shared = 'https://tommerdal-my.sharepoint.com/:u:/g/personal/x/ABC?e=4dL3As';
    const link = parseDeepLink('', `#url=${encodeURIComponent(shared)}`);
    expect(link.url).toBe(shared);
  });
});

describe('moveUrlParamToHash', () => {
  it('moves the parameter out of the query and into the fragment', () => {
    const before = 'https://app.example/ifcviewer/?url=https%3A%2F%2Fx.com%2Fa.ifc';
    const after = moveUrlParamToHash(before);
    expect(after).not.toContain('?url=');
    expect(new URL(after).search).toBe('');
    expect(parseDeepLink('', new URL(after).hash).url).toBe('https://x.com/a.ifc');
  });

  it('keeps other query parameters where they are', () => {
    const before = 'https://app.example/?debug=1&url=https%3A%2F%2Fx.com%2Fa.ifc';
    const after = moveUrlParamToHash(before);
    const parsed = new URL(after);
    expect(parsed.searchParams.get('debug')).toBe('1');
    expect(parsed.searchParams.has('url')).toBe(false);
  });

  it('leaves an href without the parameter untouched', () => {
    const href = 'https://app.example/ifcviewer/?debug=1';
    expect(moveUrlParamToHash(href)).toBe(href);
  });

  it('round-trips a real SharePoint share link without corrupting its token', () => {
    const shared =
      'https://tommerdal-my.sharepoint.com/:u:/g/personal/magnus_tommerdal_no/IQBM-IAz?e=4dL3As';
    const before = `https://app.example/?url=${encodeURIComponent(shared)}`;
    const after = moveUrlParamToHash(before);
    expect(parseDeepLink('', new URL(after).hash).url).toBe(shared);
  });
});
