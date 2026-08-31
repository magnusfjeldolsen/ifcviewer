/**
 * Gate on URLs the app is about to `fetch`.
 *
 * The threat this exists for is narrow and worth stating precisely, because
 * it is easy to over-imagine: a shared link can make *someone else's*
 * browser issue a GET to a host of the link author's choosing. It cannot
 * read the response — CORS stops that — and `RemoteLoader` never sets
 * `credentials: 'include'`, so a cross-origin fetch carries no cookies,
 * which removes most of the CSRF value. What remains is using a stranger's
 * browser to reach hosts only their network can reach: a router admin page,
 * an intranet service, a cloud instance-metadata endpoint.
 *
 * Hence the `source` distinction. A URL the user typed is theirs, and they
 * are allowed to point it at their own NAS. A URL that arrived inside a
 * link was authored by someone else, and is held to public https only.
 *
 * This is not a defence against malicious *file content*. IFC bytes are
 * never executed — they go to a WASM parser in a worker — and every string
 * from a model reaches the DOM through `textContent`. That property is
 * enforced by the `innerHTML` lint rule in `eslint.config.js`.
 */

export type UrlSource = 'user' | 'link';

export type UrlSafety = { ok: true } | { ok: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Strip the brackets IPv6 hosts carry in a URL: `[::1]` -> `::1`. */
function unwrapIpv6(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false;

  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 192 && b === 168) return true; // RFC1918
  // RFC1918 172.16.0.0/12 — the block ends at 172.31, so 172.32 is public.
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = unwrapIpv6(hostname).toLowerCase();
  if (host === '::1' || host === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
  return false;
}

function isIntranetName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // A single-label name ("fileserver", "nas") only resolves through a local
  // search domain, so in a link from outside it can only mean the victim's
  // own network. Public hostnames always carry a dot.
  if (!host.includes('.')) return true;
  return false;
}

function isPrivateHost(hostname: string): boolean {
  return (
    isPrivateIpv4(hostname) || isPrivateIpv6(hostname) || isIntranetName(hostname)
  );
}

export function checkRemoteUrl(raw: string, source: UrlSource): UrlSafety {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `Only http and https URLs can be loaded (got ${parsed.protocol}).`,
    };
  }

  // A URL the user typed is theirs to point wherever they like, including a
  // NAS on their own network over plain http.
  if (source === 'user') return { ok: true };

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'A shared link must use https. Ask the sender for an https URL.',
    };
  }

  if (isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        'This link points at a private or local network address, so it was not opened. ' +
        'If you meant to load it, paste the address into the URL box yourself.',
    };
  }

  return { ok: true };
}
