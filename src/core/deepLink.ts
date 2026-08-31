/**
 * Reading the model URL out of the page address.
 *
 * The canonical form is a fragment — `#url=<encoded>` — not a query string,
 * and the reason is specific rather than stylistic. A "anyone with the link"
 * share URL *is* the credential: the token in it is the password. Anything
 * in the query string is sent to Google Analytics as `page_location`, leaks
 * through the `Referer` header, and is kept in browser history. A fragment
 * is never transmitted to any server, so the same link in `#url=` keeps the
 * token between the sender and the recipient's browser.
 *
 * `?url=` is still read, because links in that form were already handed out.
 * `fromQuery` tells the caller to scrub it — see `moveUrlParamToHash`.
 */

const PARAM = 'url';

export interface DeepLink {
  /** The model URL the address asks for, or null if it asks for none. */
  url: string | null;
  /**
   * True when the URL arrived in the query string, where it is exposed.
   * The caller should rewrite the address before anything reads it.
   */
  fromQuery: boolean;
}

export function parseDeepLink(search: string, hash: string): DeepLink {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get(PARAM);
  if (fromHash) return { url: fromHash, fromQuery: false };

  const fromSearch = new URLSearchParams(search).get(PARAM);
  if (fromSearch) return { url: fromSearch, fromQuery: true };

  return { url: null, fromQuery: false };
}

/**
 * Rewrite an href so the model URL moves from the query string to the
 * fragment, leaving every other parameter alone. Returns the href unchanged
 * when there is no such parameter.
 */
export function moveUrlParamToHash(href: string): string {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return href;
  }

  const value = parsed.searchParams.get(PARAM);
  if (!value) return href;

  parsed.searchParams.delete(PARAM);
  parsed.hash = `${PARAM}=${encodeURIComponent(value)}`;
  return parsed.toString();
}
