# Phase: SEO, Branding & Analytics

## Goal

Make the IFC viewer discoverable via search engines, add company branding for Tommerdal Consult AS, and integrate Google Analytics 4 with GDPR-compliant cookie consent. The messaging emphasizes that the viewer is **free, open-source, runs 100% locally in the browser, and no model data ever leaves the user's device**.

## Branch

`feature/seo-analytics` — branched off `feature/scaffold` (main branch).

## Implementation Order

Three phases, each ending with passing tests and manual verification before moving on:

1. **SEO** — meta tags, semantic HTML, robots.txt, sitemap.xml, favicon
2. **Branding** — Tommerdal Consult AS credit link + footer element
3. **Analytics** — Cookie consent banner + GA4 integration

---

## Phase 1: SEO

### Step 1.1 — Branch setup

```bash
git checkout feature/scaffold
git pull origin feature/scaffold
git checkout -b feature/seo-analytics
```

### Step 1.2 — Run existing tests

```bash
npm run test
npm run lint
npm run typecheck
```

All must pass before writing any code.

### Step 1.3 — Meta tags in `index.html`

Add the following inside `<head>` (after the existing viewport meta, around line 7):

```html
<!-- SEO -->
<meta name="description" content="Free open-source IFC viewer. View and inspect BIM models directly in your browser — no upload, no server, no data leaves your device." />
<meta name="keywords" content="IFC viewer, BIM viewer, free, open-source, browser, local, no upload, Industry Foundation Classes, 3D model viewer" />
<meta name="author" content="Tømmerdal Consult AS" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="https://magnusfjeldolsen.github.io/ifcviewer/" />

<!-- Open Graph (social media previews) -->
<meta property="og:title" content="IFC Viewer — Free Online BIM File Viewer" />
<meta property="og:description" content="Free open-source IFC viewer. 100% client-side — no upload, no server, no data leaves your device. No account required." />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://magnusfjeldolsen.github.io/ifcviewer/" />
<meta property="og:image" content="https://magnusfjeldolsen.github.io/ifcviewer/assets/logo/logo.png" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="IFC Viewer — Free Online BIM File Viewer" />
<meta name="twitter:description" content="Free open-source IFC viewer. 100% client-side — your files never leave your browser." />
<meta name="twitter:image" content="https://magnusfjeldolsen.github.io/ifcviewer/assets/logo/logo.png" />
```

Update the `<title>` (line 5) from:
```html
<title>IFC Viewer</title>
```
to:
```html
<title>IFC Viewer — Free Online BIM File Viewer | Tømmerdal Consult AS</title>
```

Add favicon link (inside `<head>`):
```html
<link rel="icon" type="image/png" href="/ifcviewer/assets/logo/favicon.png" />
```

### Step 1.4 — Semantic HTML in `index.html`

Wrap the existing content in `<main>` and add a `<footer>` element (empty for now — branding goes in Phase 2):

```html
<body>
  <main id="app">
    <canvas id="viewer-canvas"></canvas>
    <!-- ... existing content ... -->
  </main>
  <footer id="app-footer"></footer>
  <script type="module" src="/src/main.ts"></script>
</body>
```

### Step 1.5 — Create `public/robots.txt`

```
User-agent: *
Allow: /

Sitemap: https://magnusfjeldolsen.github.io/ifcviewer/sitemap.xml
```

### Step 1.6 — Create `public/sitemap.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaszorg/schemas/sitemap/0.9">
  <url>
    <loc>https://magnusfjeldolsen.github.io/ifcviewer/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

### Step 1.7 — Logo and favicon

**Manual step:** User places the company logo at `public/assets/logo/logo.png`.

Create a favicon (scaled-down version) at `public/assets/logo/favicon.png` — either manually or by adding a build step. For now, the same logo file can be copied as the favicon.

### Step 1.8 — Verify

```bash
npm run test
npm run lint
npm run typecheck
npm run dev
```

Manual checks:
- View page source — confirm all meta tags are present
- Check `<title>` in browser tab
- Visit `/ifcviewer/robots.txt` and `/ifcviewer/sitemap.xml` in dev server
- Test Open Graph preview with a sharing debugger tool (after deploy)
- Confirm favicon shows in browser tab
- Confirm the viewer still works normally (load a file, orbit, use tools)

---

## Phase 2: Branding

### Step 2.1 — Create `src/ui/Footer.ts`

A small UI component that renders company credit into the `<footer>` element.

```ts
export class Footer {
  private container: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'app-footer-content';
    this.container.innerHTML =
      'Developed by <a href="http://www.tommerdal.no/" target="_blank" rel="noopener noreferrer">Tømmerdal Consult AS</a>';
    parent.appendChild(this.container);
  }

  dispose(): void {
    this.container.remove();
  }
}
```

### Step 2.2 — Footer styles in `src/styles.css`

Add after the existing memory-toggle section (after line ~352):

```css
/* Footer / branding */
#app-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 6px 16px;
  pointer-events: none;
  z-index: 10;
}

.app-footer-content {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  pointer-events: auto;
}

.app-footer-content a {
  color: rgba(255, 255, 255, 0.5);
  text-decoration: none;
  transition: color 0.2s;
}

.app-footer-content a:hover {
  color: rgba(255, 255, 255, 0.8);
  text-decoration: underline;
}
```

### Step 2.3 — Export Footer from `src/ui/index.ts`

Add:
```ts
export { Footer } from './Footer';
```

### Step 2.4 — Wire up in `src/core/App.ts`

- Import `Footer`
- Add private field `private footer: Footer;`
- In constructor, after existing UI setup: `this.footer = new Footer(document.getElementById('app-footer')!);`
- In `dispose()`: `this.footer.dispose();`

### Step 2.5 — Verify

```bash
npm run test
npm run lint
npm run typecheck
npm run dev
```

Manual checks:
- "Developed by Tommerdal Consult AS" visible bottom-right, small and muted
- Link opens http://www.tommerdal.no/ in new tab
- Text doesn't overlap toolbar, model tree, or status bar
- Text doesn't interfere with 3D interaction (pointer-events: none on container)
- Viewer still works normally

---

## Phase 3: Google Analytics + Cookie Consent

### Prerequisites

**User must create a GA4 property before this phase:**
1. Go to https://analytics.google.com/
2. Create a new property for the IFC viewer
3. Get the Measurement ID (format: `G-XXXXXXXXXX`)
4. Provide the ID — it will be stored in a config file

### Step 3.1 — Create `src/config.ts`

```ts
export const CONFIG = {
  GA_MEASUREMENT_ID: 'G-71KTY05FQ8',
} as const;
```

### Step 3.2 — Create `src/services/CookieConsent.ts`

Manages consent state in localStorage.

```ts
export type ConsentStatus = 'accepted' | 'declined' | 'pending';

export class CookieConsent {
  private static readonly STORAGE_KEY = 'ifcviewer:cookieConsent';

  static getStatus(): ConsentStatus {
    try {
      const value = localStorage.getItem(CookieConsent.STORAGE_KEY);
      if (value === 'accepted' || value === 'declined') return value;
    } catch { /* private browsing */ }
    return 'pending';
  }

  static accept(): void {
    try { localStorage.setItem(CookieConsent.STORAGE_KEY, 'accepted'); }
    catch { /* private browsing */ }
  }

  static decline(): void {
    try { localStorage.setItem(CookieConsent.STORAGE_KEY, 'declined'); }
    catch { /* private browsing */ }
  }
}
```

### Step 3.3 — Create `src/services/Analytics.ts`

Dynamically loads GA4 script only when consent is given.

```ts
import { CONFIG } from '../config';

export class Analytics {
  private static loaded = false;

  static load(): void {
    if (Analytics.loaded) return;
    if (!CONFIG.GA_MEASUREMENT_ID) return;

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${CONFIG.GA_MEASUREMENT_ID}`;
    document.head.appendChild(script);

    const w = window as any;
    w.dataLayer = w.dataLayer || [];
    function gtag(...args: any[]) { w.dataLayer.push(args); }
    gtag('js', new Date());
    gtag('config', CONFIG.GA_MEASUREMENT_ID);

    Analytics.loaded = true;
  }
}
```

### Step 3.4 — Create `src/ui/CookieBanner.ts`

Cookie icon fixed bottom-left. Expands to a banner on first visit.

```
Collapsed state (after choice):
  🍪  (small clickable icon, bottom-left)

Expanded state (first visit or when icon clicked):
  ┌─────────────────────────────────────────────┐
  │ 🍪 This site uses cookies for analytics.    │
  │                      [Accept]  [Decline]    │
  └─────────────────────────────────────────────┘
```

Behavior:
- On first visit (`pending`): shows expanded banner
- User clicks Accept: saves consent, loads GA4, collapses to icon
- User clicks Decline: saves decline, collapses to icon
- Clicking icon after choice: re-expands banner so user can change preference
- Changing from decline to accept: loads GA4
- Changing from accept to decline: sets flag (GA4 cannot be fully unloaded without page reload — show a note that it takes effect on next visit)

### Step 3.5 — Cookie banner styles in `src/styles.css`

```css
/* Cookie consent */
.cookie-banner {
  position: fixed;
  bottom: 8px;
  left: 8px;
  z-index: 100;
  pointer-events: auto;
}

.cookie-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(30, 30, 30, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  transition: background 0.2s;
}

.cookie-icon:hover {
  background: rgba(50, 50, 50, 0.95);
}

.cookie-expanded {
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  display: flex;
  align-items: center;
  gap: 12px;
  backdrop-filter: blur(8px);
}

.cookie-expanded button {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  color: white;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.2s;
}

.cookie-expanded button:hover {
  background: rgba(255, 255, 255, 0.2);
}

.cookie-expanded button.accept {
  background: #3b82f6;
  border-color: #3b82f6;
}

.cookie-expanded button.accept:hover {
  background: #2563eb;
}
```

### Step 3.6 — Export new modules from `src/ui/index.ts` and `src/services/index.ts`

Add CookieBanner export to `src/ui/index.ts`.

### Step 3.7 — Wire up in `src/core/App.ts`

- Import `CookieConsent`, `Analytics`, `CookieBanner`
- Add private field for `CookieBanner`
- In constructor:
  - Create `CookieBanner` in the `<footer>` element (left side)
  - If consent already accepted, call `Analytics.load()`
  - Register callback on banner: when user accepts, call `Analytics.load()`
- In `dispose()`: clean up banner

### Step 3.8 — Write tests

Tests for `CookieConsent`:
- `getStatus()` returns `'pending'` when no localStorage value
- `accept()` then `getStatus()` returns `'accepted'`
- `decline()` then `getStatus()` returns `'declined'`
- Handles localStorage errors gracefully (private browsing)

Tests for `Analytics`:
- Does not inject script when measurement ID is empty
- Does not inject script twice (idempotent)

Tests for `CookieBanner`:
- Renders expanded when status is `'pending'`
- Renders collapsed (icon only) when status is `'accepted'` or `'declined'`
- Accept button calls `CookieConsent.accept()`
- Decline button calls `CookieConsent.decline()`

### Step 3.9 — Verify

```bash
npm run test
npm run lint
npm run typecheck
npm run dev
```

Manual checks:
- First visit: cookie banner expanded bottom-left with Accept/Decline
- Click Accept: banner collapses to cookie icon, check DevTools Network tab for gtag.js loading
- Reload: icon only (no banner), GA4 loads automatically
- Clear localStorage, reload: banner shows again
- Click Decline: no GA4 script loaded, icon only
- Click icon after decline: banner re-expands, can change to Accept
- Cookie icon doesn't overlap Tommerdal credit (left vs right)
- All tools still work (clipping, measurement, model tree, etc.)

---

## Phase 4: PR and Deploy

### Step 4.1 — Final verification

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

### Step 4.2 — Create PR

```bash
git push -u origin feature/seo-analytics
gh pr create --base feature/scaffold --title "Add SEO, branding, and analytics" --body "..."
```

PR description should cover:
- SEO meta tags and Open Graph for discoverability
- Tommerdal Consult AS branding (bottom-right)
- GA4 with cookie consent (bottom-left, GDPR-compliant)
- No tracking without explicit user consent
- Measurement ID left blank — to be configured when GA4 property is created

### Step 4.3 — After merge

- User creates GA4 property and sets the measurement ID in `src/config.ts`
- Verify on live GitHub Pages:
  - Open Graph preview works (use Facebook/LinkedIn sharing debugger)
  - robots.txt and sitemap.xml accessible
  - Analytics reporting data in GA4 dashboard (after a few hours)
  - Cookie consent works on mobile browsers

---

## File Summary

### New files
| File | Purpose |
|------|---------|
| `public/robots.txt` | Search engine crawl rules |
| `public/sitemap.xml` | Sitemap for search engines |
| `public/assets/logo/logo.png` | Company logo (manual) |
| `public/assets/logo/favicon.png` | Favicon (manual) |
| `src/config.ts` | GA4 measurement ID config |
| `src/services/CookieConsent.ts` | Cookie consent state management |
| `src/services/Analytics.ts` | GA4 dynamic loader |
| `src/ui/CookieBanner.ts` | Cookie consent UI |
| `src/ui/Footer.ts` | Company branding credit |

### Modified files
| File | Changes |
|------|---------|
| `index.html` | Meta tags, semantic HTML, favicon, footer element |
| `src/styles.css` | Footer + cookie banner styles |
| `src/ui/index.ts` | Export Footer, CookieBanner |
| `src/core/App.ts` | Wire up Footer, CookieBanner, Analytics |

### Test files
| File | Covers |
|------|--------|
| `tests/CookieConsent.test.ts` | Consent state management |
| `tests/Analytics.test.ts` | Script injection logic |
| `tests/CookieBanner.test.ts` | Banner UI behavior |
