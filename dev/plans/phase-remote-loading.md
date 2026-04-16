# Phase — Remote IFC Loading

## Goal

Allow users to load IFC models from remote URLs — paste a link, the viewer fetches and renders it. If the remote server blocks the request (CORS, auth, 404), fail gracefully with a clear message and a fallback suggestion.

---

## Background & Motivation

Construction teams often store IFC models in cloud platforms (GitHub, SharePoint, S3, Azure Blob). Today the viewer requires local file upload. Remote loading lets users share a viewer link with a model URL embedded, enabling "click to view" workflows without downloading files first.

---

## Key principle: Shared framework, thin provider configs

Cloud providers differ in URL patterns, auth flows, and APIs — but the underlying mechanics are largely the same. Rather than building N separate loader implementations that each duplicate fetch logic, error handling, and auth plumbing, we use a **layered architecture**:

1. **`RemoteLoader`** — generic fetch engine. Handles any CORS-friendly URL with optional bearer token. This alone covers the 80% case (GitHub, GitLab, presigned S3/Azure/GCS URLs, Dropbox).

2. **`urlNormalizer`** — config-driven rewrite table. Maps user-facing URLs to direct download URLs. Adding a new provider is just adding a regex + replacement string. No auth, no API logic.

3. **`OAuthProvider`** — generic OAuth2/PKCE handler. The auth dance (redirect, code exchange, token refresh) is the same across Microsoft, Google, etc. Provider differences are captured in a config object, not separate implementations.

4. **Provider configs** — each OAuth-requiring provider (SharePoint, Google Drive, etc.) is a small config object + one `resolveDownloadUrl()` function. This is the only provider-specific code.

**What this means in practice:**
- Adding a new CORS-friendly provider = one entry in the URL rewrite table
- Adding a new OAuth provider = one config object (~20 lines) + one URL resolver function
- If a provider changes an endpoint, you update one string in the config
- The fetch engine, error handling, progress tracking, and UI are shared and tested once

---

## Design

### User-facing flow

```
┌─────────────────────────────────────────────────────────┐
│  Upload prompt area (existing)                          │
│                                                         │
│     Drop an .ifc file here                              │
│               or                                        │
│          [ Browse ]                                     │
│               or                                        │
│   ┌────────────────────────────┐  ┌──────┐              │
│   │ Paste a URL to an .ifc ... │  │ Load │              │
│   └────────────────────────────┘  └──────┘              │
└─────────────────────────────────────────────────────────┘
```

The URL input appears alongside the existing upload prompt. Submitting a URL triggers the optimistic fetch flow.

### Optimistic fetch flow

```
User submits URL
  → urlNormalizer rewrites to direct download URL (if pattern matches)
  → Is this an OAuth provider? (detect by domain pattern)
      → Yes: check for existing token → if missing, trigger OAuth flow → get token
      → No: proceed without auth
  → HEAD request (lightweight pre-check)
      → Check Content-Length (reject if > 500 MB)
      → Check status code
  → GET request with progress tracking
      → 200 → validate IFC header (ISO-10303-21) → parse & render ✓
      → 401/403 (non-OAuth URL) → show "Requires authentication" + token input
      → 404 → "File not found at this URL"
      → CORS error → "Server doesn't allow browser access — download and upload instead"
      → Timeout → "Download timed out"
      → Not IFC → "This doesn't appear to be an IFC file"
```

### URL normalization (config-driven rewrite table)

A list of `{ pattern, rewrite }` rules. Detect common URL patterns and rewrite to raw/direct download URLs:

| Input pattern | Rewrite to |
|---------------|-----------|
| `github.com/<user>/<repo>/blob/<ref>/<path>.ifc` | `raw.githubusercontent.com/<user>/<repo>/<ref>/<path>.ifc` |
| `gitlab.com/<user>/<repo>/-/blob/<ref>/<path>.ifc` | `gitlab.com/<user>/<repo>/-/raw/<ref>/<path>.ifc` |
| `dropbox.com/...?dl=0` | Same URL with `dl=1` |

Adding a new provider = adding one entry to this table. No code changes required.

### Bearer token auth (Phase 1.5)

For non-OAuth URLs that return 401/403:

1. Show a secondary input: "This file requires authentication. Paste an access token:"
2. Retry the fetch with `Authorization: Bearer <token>` header
3. Token is kept in memory only (never persisted to localStorage/IndexedDB)
4. On success, proceed with normal parse flow
5. On repeated failure, show "Token was rejected" and offer local upload fallback

### URL sharing via query parameter

Support `?url=<encoded-url>` in the viewer URL. This enables shareable links:

```
https://magnusfjeldolsen.github.io/ifcviewer/?url=https://raw.githubusercontent.com/...model.ifc
```

On page load, if `?url=` is present, auto-trigger the fetch flow. Show a confirmation dialog first: "Load model from `<domain>`?" to prevent blind fetches from crafted links.

---

## Architecture

### Layer 1: `src/loader/RemoteLoader.ts`

Generic fetch engine. Handles any URL. Returns the same `LoadedFile` interface that `FileLoader` uses.

```ts
interface RemoteFetchResult {
  status: 'ok' | 'cors' | 'auth' | 'not-found' | 'not-ifc' | 'too-large' | 'network-error' | 'timeout';
  file?: LoadedFile;        // present when status === 'ok'
  message: string;          // human-readable status/error
  contentLength?: number;   // from HEAD, if available
}

class RemoteLoader {
  async fetch(url: string, token?: string): Promise<RemoteFetchResult>;
}
```

This is the only module that calls `fetch()`. Everything else resolves URLs and tokens, then delegates to `RemoteLoader`.

### Layer 2: `src/loader/urlNormalizer.ts`

Pure function with a config-driven rewrite table:

```ts
interface RewriteRule {
  name: string;                          // e.g. "GitHub"
  pattern: RegExp;                       // match user-facing URL
  rewrite: (match: RegExpMatchArray) => string;  // produce direct download URL
}

const rules: RewriteRule[] = [
  { name: 'GitHub', pattern: /.../, rewrite: (m) => `https://raw.githubusercontent.com/...` },
  { name: 'GitLab', pattern: /.../, rewrite: (m) => `...` },
  { name: 'Dropbox', pattern: /.../, rewrite: (m) => `...` },
];

function normalizeUrl(url: string): { url: string; provider?: string };
```

### Layer 3: `src/services/OAuthProvider.ts` (Phase 2)

Generic OAuth2/PKCE handler. The flow (redirect → code exchange → token cache → silent refresh) is the same across providers. Differences are captured in config:

```ts
interface OAuthProviderConfig {
  name: string;                         // e.g. "SharePoint", "Google Drive"
  clientId: string;
  authorizeUrl: string;                 // e.g. "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
  tokenUrl: string;                     // e.g. "https://login.microsoftonline.com/common/oauth2/v2.0/token"
  scopes: string[];                     // e.g. ["Files.Read"]
  domainPattern: RegExp;                // e.g. /\.sharepoint\.com/
  resolveDownloadUrl: (url: string, token: string) => Promise<string>;
}
```

The `resolveDownloadUrl` function is the only truly provider-specific logic. Everything else (PKCE challenge generation, token exchange, caching, refresh) is shared.

**Example: SharePoint config**
```ts
const sharepoint: OAuthProviderConfig = {
  name: 'SharePoint',
  clientId: '<azure-app-id>',
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: ['Files.Read', 'Sites.Read.All'],
  domainPattern: /\.sharepoint\.com/,
  resolveDownloadUrl: async (url, token) => {
    // Encode sharing URL per Graph API spec
    const encoded = btoa(url).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    return `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem/content`;
  },
};
```

**Example: Google Drive config (future)**
```ts
const googleDrive: OAuthProviderConfig = {
  name: 'Google Drive',
  clientId: '<google-client-id>',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  domainPattern: /drive\.google\.com/,
  resolveDownloadUrl: async (url, token) => {
    const fileId = url.match(/\/d\/([^/]+)/)?.[1];
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  },
};
```

Adding a new OAuth provider = writing one of these config objects. No new classes, no new modules.

### Layer 4: Provider registry

A simple array of `OAuthProviderConfig` objects. When a URL is submitted:

1. Check `urlNormalizer` for a direct rewrite → if matched, `RemoteLoader.fetch()` directly
2. Check provider registry by `domainPattern` → if matched, run OAuth flow → resolve download URL → `RemoteLoader.fetch()` with token
3. No match → `RemoteLoader.fetch()` directly (optimistic try)

### UI: `src/ui/UrlInput.ts`

Input field + Load button, rendered inside the upload prompt area. Manages:
- URL validation (client-side format check)
- Progress display during download
- Error messages from `RemoteFetchResult`
- Token input (shown on auth failure for non-OAuth URLs)
- OAuth sign-in prompt (shown when an OAuth provider is detected)

### Integration in App.ts

Minimal changes — `App.ts` creates the loader stack and `UrlInput`, wires them together with the same `handleFile()` callback that `FileLoader` uses.

```
Existing:  FileLoader.onLoad → handleFile → parser → modelManager
New:       UrlInput.onSubmit → urlNormalizer → [OAuthProvider?] → RemoteLoader.fetch → handleFile
```

### Query parameter handling in `main.ts`

On startup, check `URLSearchParams` for `url=`. If present, show confirmation, then trigger the fetch flow.

---

## Security considerations

| Concern | Mitigation |
|---------|-----------|
| Malicious IFC (parser exploits) | web-ifc runs in WASM sandbox inside browser sandbox — double isolation. Validate `ISO-10303-21` header before parsing. |
| Decompression bombs (.ifczip) | Not supported in Phase 1. When added, cap decompression ratio. |
| Memory exhaustion (huge files) | HEAD pre-check rejects files > 500 MB. Progress bar lets user cancel. |
| Token leakage | Bearer tokens held in memory only, never persisted. OAuth tokens managed by OAuthProvider in sessionStorage (standard practice), scoped to read-only. Cleared on page unload. |
| URL injection via `?url=` | Confirmation dialog before fetching. Sanitize display of URL (no HTML injection). Only allow `https://` URLs. |
| IP disclosure | Fetching a URL reveals user's IP to the remote server. The confirmation dialog implicitly informs the user they're connecting to that domain. |
| Polyglot files | Never interpret fetched content as HTML/JS. Always treat as binary `ArrayBuffer`. |
| XSS via error messages | Never use `innerHTML` for error/status messages — always `textContent`. |
| OAuth redirect attacks | Use PKCE (prevents auth code interception). Validate `state` parameter on redirect. Only accept redirects to registered URIs. |

---

## File structure (new/modified)

```
src/
├── loader/
│   ├── FileLoader.ts          (existing, unchanged)
│   ├── RemoteLoader.ts        (NEW — generic fetch engine)
│   ├── urlNormalizer.ts        (NEW — config-driven URL rewrite table)
│   ├── providerRegistry.ts    (NEW, Phase 2 — array of OAuthProviderConfig objects)
│   └── index.ts               (update exports)
├── services/
│   ├── OAuthProvider.ts       (NEW, Phase 2 — generic OAuth2/PKCE handler)
│   └── ...
├── ui/
│   ├── UrlInput.ts            (NEW — shared URL input + progress + errors)
│   └── index.ts               (update exports)
├── core/
│   └── App.ts                 (wire up RemoteLoader + UrlInput)
├── main.ts                    (add ?url= query parameter check)

tests/
├── loader/
│   ├── RemoteLoader.test.ts   (NEW)
│   ├── urlNormalizer.test.ts  (NEW)
│   └── providerRegistry.test.ts (NEW, Phase 2)
├── services/
│   └── OAuthProvider.test.ts  (NEW, Phase 2)
├── ui/
│   └── UrlInput.test.ts       (NEW)
```

---

## Implementation checklist

### Phase 1: Public URL loading
- [ ] Create `urlNormalizer.ts` with rewrite table (GitHub, GitLab, Dropbox rules)
- [ ] Create `RemoteLoader.ts` with HEAD pre-check + GET fetch + error classification
- [ ] Create `UrlInput.ts` UI component (input + button + progress + error display)
- [ ] Wire into `App.ts` using existing `handleFile()` pipeline
- [ ] Add `?url=` query parameter support with confirmation dialog
- [ ] Write tests for `urlNormalizer` (pattern matching, edge cases)
- [ ] Write tests for `RemoteLoader` (mock fetch, error classification)
- [ ] Update `index.html` upload prompt area with URL input placeholder
- [ ] Update `styles.css` for URL input styling
- [ ] Manual testing with public GitHub-hosted IFC files

### Phase 1.5: Bearer token auth
- [ ] Detect 401/403 in `RemoteLoader` and surface to UI
- [ ] Add token input to `UrlInput` (shown only after auth failure)
- [ ] Retry fetch with `Authorization: Bearer <token>` header
- [ ] Test with private GitHub repo + personal access token

### Phase 2: Generic OAuth framework + SharePoint
- [ ] Create `OAuthProvider.ts` — generic OAuth2/PKCE handler (authorize, exchange, cache, refresh)
- [ ] Create `providerRegistry.ts` — array of provider configs
- [ ] Add SharePoint config (clientId, endpoints, scopes, `resolveDownloadUrl`)
- [ ] Register Azure AD app (free, ~5 min) and configure redirect URI
- [ ] Detect SharePoint URLs by domain pattern → trigger OAuth → resolve via Graph API
- [ ] Add lazy-loading for OAuth dependencies (only loaded when an OAuth provider is triggered)
- [ ] Write tests for `OAuthProvider` (mock OAuth flow, token refresh)
- [ ] Write tests for SharePoint URL resolution
- [ ] Manual testing with SharePoint-hosted IFC files

### Phase 2+: Additional OAuth providers (future, as needed)
Each new provider = one config object added to `providerRegistry.ts`:
- [ ] **Google Drive** — Google Identity Services, `drive.readonly` scope
- [ ] **Box** — Box OAuth2, Content API
- [ ] **Autodesk BIM 360 / ACC** — Autodesk Forge OAuth2, Data Management API

### Not provider-specific (handled by Phase 1 already)
These work out of the box with `RemoteLoader` + `urlNormalizer`, no special integration needed:
- AWS S3 presigned URLs
- Azure Blob Storage SAS URLs
- Google Cloud Storage signed URLs
- Any server that serves files with CORS headers

---

## Testing strategy

| Test | Type | What it validates |
|------|------|-------------------|
| URL normalizer rules | Unit (Vitest) | Rewrite table: GitHub, GitLab, Dropbox, unknown URLs pass through |
| RemoteLoader error handling | Unit (Vitest, mock fetch) | Correct status classification for all error types |
| OAuthProvider flow | Unit (Vitest, mock) | PKCE challenge, token exchange, cache hit, refresh |
| Provider configs | Unit (Vitest) | Each `resolveDownloadUrl` produces correct API URL |
| UrlInput rendering | Unit (Vitest, DOM) | Input validation, error display, token prompt, OAuth prompt |
| End-to-end public URL | Manual | Load a real IFC from GitHub, verify render |
| End-to-end CORS rejection | Manual | Try a URL without CORS headers, verify graceful message |
| End-to-end bearer token | Manual | Try a private repo URL, enter token, verify load |
| End-to-end SharePoint | Manual | Paste SharePoint link, sign in, verify load |
| Query parameter | Manual | Open viewer with `?url=...`, verify confirmation + load |

---

---

# Appendix: SharePoint / OneDrive Details

This section provides additional context for the SharePoint provider config in Phase 2. The actual implementation is just a config object in `providerRegistry.ts` + the `resolveDownloadUrl` function — the OAuth plumbing is handled by the generic `OAuthProvider`.

## How SharePoint file access works

SharePoint/OneDrive files are accessed via the **Microsoft Graph API**:

```
GET https://graph.microsoft.com/v1.0/shares/{encoded-sharing-url}/driveItem/content
```

This API **supports CORS** but requires an OAuth2 access token from Azure AD (Entra ID).

## What's needed (one-time setup)

| Requirement | Detail |
|------------|--------|
| **Azure AD App Registration** | Register the viewer as an app in Azure portal. Free, ~5 minutes. Gives you a `client_id`. |
| **Redirect URI** | The viewer's GitHub Pages URL must be registered as a redirect URI. |
| **API permissions** | `Files.Read` (user's OneDrive) and/or `Sites.Read.All` (SharePoint sites). Delegated permissions — the app acts as the signed-in user. |
| **Tenant configuration** | Multi-tenant for public use (any Microsoft org). Single-tenant for one org. |

## User experience

1. User pastes a SharePoint link like `https://company.sharepoint.com/sites/Project/Documents/model.ifc`
2. Viewer detects the `.sharepoint.com` domain pattern
3. `OAuthProvider` checks for cached token → if missing, prompts Microsoft sign-in
4. `resolveDownloadUrl` encodes the sharing URL per Graph API spec
5. `RemoteLoader.fetch()` downloads with the OAuth token
6. Normal parse → render flow

## Practical considerations

| Aspect | Impact |
|--------|--------|
| **Still no backend** | OAuth2 PKCE is designed for pure client-side apps. |
| **Admin consent** | Some orgs require admin approval for `Sites.Read.All`. `Files.Read` usually doesn't. |
| **Token security** | Managed by `OAuthProvider` in sessionStorage. Scoped to read-only. |
| **Lazy loading** | OAuth library only loaded when a SharePoint URL is detected — no impact on initial bundle size. |
