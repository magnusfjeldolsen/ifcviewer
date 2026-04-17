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
    name: 'Dropbox',
    pattern: /^(https:\/\/www\.dropbox\.com\/.+)(\?dl=0)$/i,
    rewrite: (m) => `${m[1]}?dl=1`,
  },
];

export interface NormalizedUrl {
  url: string;
  provider?: string;
}

export function normalizeUrl(url: string): NormalizedUrl {
  for (const rule of rules) {
    const match = url.match(rule.pattern);
    if (match) {
      return { url: rule.rewrite(match), provider: rule.name };
    }
  }
  return { url };
}
