/**
 * Rewrite a "share this file" URL into one a browser can actually `fetch`.
 *
 * Every provider here hands out links that open a *viewer page*, not the
 * bytes. Each rule turns such a link into that provider's direct-download
 * endpoint — and, critically, one that answers with an
 * `Access-Control-Allow-Origin` header, since we fetch cross-origin from a
 * static site.
 *
 * **These endpoints are not documented APIs.** They are the URLs the
 * providers' own web apps use. They work, they are widely relied on, and they
 * can change without notice. So a rule that stops working must fail visibly:
 * the fetch will 403 or lose CORS and `RemoteLoader` will report it. Never
 * add a silent fallback that leaves the user staring at "could not load".
 */

interface RewriteRule {
  name: string;
  pattern: RegExp;
  rewrite: (match: RegExpMatchArray) => string;
}

const rules: RewriteRule[] = [
  {
    name: 'GitHub',
    pattern: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.ifc)$/i,
    rewrite: (m) =>
      `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
  },
  {
    name: 'GitLab',
    pattern: /^https:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/([^/]+)\/(.+\.ifc)$/i,
    rewrite: (m) =>
      `https://gitlab.com/${m[1]}/${m[2]}/-/raw/${m[3]}/${m[4]}`,
  },
  {
    /**
     * OneDrive for Business / SharePoint.
     *
     * Verified 2026-08-25 against a live "anyone with the link" share, with a
     * real browser `fetch()` from the page origin — not just curl:
     * `status: 200`, `type: "cors"`, body beginning `ISO-10303-21;`.
     *
     * The obvious candidates all fail, which is why the rule looks like this:
     *   - the raw share link 302s to the `onedrive.aspx` viewer page;
     *   - `&download=1` 302s to the file's direct path, but the redirect drops
     *     the share token, so the second hop is anonymous and 403s;
     *   - `api.onedrive.com/v1.0/shares/...` answers 308 "User migrated" —
     *     it serves consumer OneDrive, not business/SharePoint;
     *   - Microsoft Graph answers 401; it wants OAuth, which defeats the
     *     point of a link a client can just open.
     *
     * `download.aspx?share=<id>` is the one that serves bytes anonymously
     * with `Access-Control-Allow-Origin: *`.
     */
    name: 'SharePoint',
    pattern: /^https:\/\/([^/]+\.sharepoint\.com)\/:[a-z]:\/[a-z]\/(personal\/[^/]+|sites\/[^/]+)\/([^/?#]+)/i,
    rewrite: (m) =>
      `https://${m[1]}/${m[2]}/_layouts/15/download.aspx?share=${m[3]}`,
  },
  {
    /**
     * Google Drive.
     *
     * A `/file/d/<id>/view` share link renders a preview page. The download
     * host serves the bytes with permissive CORS instead.
     *
     * `confirm=t` matters: without it, Drive answers a file large enough to
     * skip virus scanning — which every real IFC will be — with an HTML
     * interstitial rather than the file. With it, the scan warning is
     * acknowledged up front and the bytes come back.
     *
     * Caveat worth knowing: this endpoint serves GET but **rejects HEAD**,
     * which is why `RemoteLoader` must not rely on a HEAD pre-check for its
     * size guard.
     */
    name: 'Google Drive',
    pattern: /^https:\/\/drive\.google\.com\/file\/d\/([^/]+)\//i,
    rewrite: (m) =>
      `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`,
  },
  {
    /**
     * Google Drive, `open?id=` form — the same file, a different share button.
     */
    name: 'Google Drive',
    pattern: /^https:\/\/drive\.google\.com\/open\?(?:.*&)?id=([^&#]+)/i,
    rewrite: (m) =>
      `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`,
  },
  {
    /**
     * Dropbox.
     *
     * The previous rule required `?dl=0` at the very end of the URL. Modern
     * Dropbox links are `.../scl/fi/<id>/<name>?rlkey=...&st=...&dl=0`, where
     * the flag is `&dl=0` and rarely last — so the rule could not match any
     * link Dropbox has handed out for years. This rewrites the flag wherever
     * it appears, and appends it when it is absent.
     */
    name: 'Dropbox',
    pattern: /^https:\/\/(?:www\.)?dropbox\.com\/.+/i,
    rewrite: (m) => {
      const url = m[0];
      if (/[?&]dl=1(&|$)/i.test(url)) return url;
      if (/[?&]dl=0(&|$)/i.test(url)) return url.replace(/([?&])dl=0(&|$)/i, '$1dl=1$2');
      return `${url}${url.includes('?') ? '&' : '?'}dl=1`;
    },
  },
];

export interface NormalizedUrl {
  url: string;
  provider?: string;
}

export function normalizeUrl(url: string): NormalizedUrl {
  for (const rule of rules) {
    const match = url.match(rule.pattern);
    if (!match) continue;

    const rewritten = rule.rewrite(match);
    // `provider` is what drives "Detected <X> link, using direct download
    // URL." in the UI. A rule can match a link that is already in
    // direct-download form (a Dropbox link with `dl=1`, say) and hand it back
    // untouched — announcing a rewrite that did not happen would be a small
    // lie, so only claim the provider when the URL actually changed.
    return rewritten === url ? { url } : { url: rewritten, provider: rule.name };
  }
  return { url };
}
