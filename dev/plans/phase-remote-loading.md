# Phase — Remote IFC Loading

## Goal

Allow users to load IFC models from remote URLs — paste a link, the viewer fetches and renders it. If the remote server blocks the request (CORS, auth, 404), fail gracefully with a clear message and a fallback suggestion.

---

## Background & Motivation

Construction teams often store IFC models in cloud platforms (GitHub, SharePoint, S3, Azure Blob). Today the viewer requires local file upload. Remote loading lets users share a viewer link with a model URL embedded, enabling "click to view" workflows without downloading files first.

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
  → Validate URL format (must be https://, end with .ifc or known pattern)
  → HEAD request (lightweight pre-check)
      → Check Content-Length (reject if > 500 MB)
      → Check status code
  → GET request with progress tracking
      → 200 → validate IFC header (ISO-10303-21) → parse & render ✓
      → 401/403 → show "Requires authentication" message + token input
      → 404 → "File not found at this URL"
      → CORS error → "Server doesn't allow browser access — download and upload instead"
      → Timeout → "Download timed out"
      → Not IFC → "This doesn't appear to be an IFC file"
```

### URL normalization (smart rewrites)

Detect common URL patterns and rewrite to raw/direct download URLs:

| Input pattern | Rewrite to |
|---------------|-----------|
| `github.com/<user>/<repo>/blob/<ref>/<path>.ifc` | `raw.githubusercontent.com/<user>/<repo>/<ref>/<path>.ifc` |
| `gitlab.com/<user>/<repo>/-/blob/<ref>/<path>.ifc` | `gitlab.com/<user>/<repo>/-/raw/<ref>/<path>.ifc` |
| `dropbox.com/...?dl=0` | Same URL with `dl=1` |

Additional providers can be added later as simple pattern → rewrite rules.

### Bearer token auth (Phase 1.5)

When a fetch returns 401/403:

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

### New module: `src/loader/RemoteLoader.ts`

Single-responsibility module for fetching remote files. Returns the same `LoadedFile` interface that `FileLoader` uses, so `App.ts` can feed it through the identical parse → render pipeline.

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

### New UI component: `src/ui/UrlInput.ts`

Input field + Load button, rendered inside the upload prompt area. Manages:
- URL validation (client-side format check)
- Progress display during download
- Error messages from `RemoteFetchResult`
- Token input (shown on auth failure)

### URL normalizer: `src/loader/urlNormalizer.ts`

Pure function: takes a URL string, returns a normalized URL. Contains the rewrite rules for GitHub, GitLab, Dropbox, etc. Easy to test in isolation.

### Integration in App.ts

Minimal changes — `App.ts` creates a `RemoteLoader` and `UrlInput`, wires them together with the same `handleFile()` callback that `FileLoader` uses.

```
Existing:  FileLoader.onLoad → handleFile → parser → modelManager
New:       UrlInput.onSubmit → RemoteLoader.fetch → handleFile → parser → modelManager
```

### Query parameter handling in `main.ts`

On startup, check `URLSearchParams` for `url=`. If present, show confirmation, then trigger `RemoteLoader.fetch`.

---

## Security considerations

| Concern | Mitigation |
|---------|-----------|
| Malicious IFC (parser exploits) | web-ifc runs in WASM sandbox inside browser sandbox — double isolation. Validate `ISO-10303-21` header before parsing. |
| Decompression bombs (.ifczip) | Not supported in Phase 1. When added, cap decompression ratio. |
| Memory exhaustion (huge files) | HEAD pre-check rejects files > 500 MB. Progress bar lets user cancel. |
| Token leakage | Tokens held in memory only, never persisted. Cleared on page unload. |
| URL injection via `?url=` | Confirmation dialog before fetching. Sanitize display of URL (no HTML injection). Only allow `https://` URLs. |
| IP disclosure | Fetching a URL reveals user's IP to the remote server. The confirmation dialog implicitly informs the user they're connecting to that domain. |
| Polyglot files | Never interpret fetched content as HTML/JS. Always treat as binary `ArrayBuffer`. |
| XSS via error messages | Never use `innerHTML` for error/status messages — always `textContent`. |

---

## File structure (new/modified)

```
src/
├── loader/
│   ├── FileLoader.ts          (existing, unchanged)
│   ├── RemoteLoader.ts        (NEW)
│   ├── urlNormalizer.ts        (NEW)
│   └── index.ts               (update exports)
├── ui/
│   ├── UrlInput.ts            (NEW)
│   └── index.ts               (update exports)
├── core/
│   └── App.ts                 (wire up RemoteLoader + UrlInput)
├── main.ts                    (add ?url= query parameter check)

tests/
├── loader/
│   ├── RemoteLoader.test.ts   (NEW)
│   └── urlNormalizer.test.ts  (NEW)
├── ui/
│   └── UrlInput.test.ts       (NEW)
```

---

## Implementation checklist

### Phase 1: Public URL loading
- [ ] Create `urlNormalizer.ts` with GitHub/GitLab/Dropbox rewrite rules
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

### Phase 2: Provider-specific enhancements (future)
- [ ] SharePoint / OneDrive integration (see SharePoint section below)
- [ ] Google Drive support
- [ ] Presigned URL detection (S3, GCS, Azure SAS)

---

## Testing strategy

| Test | Type | What it validates |
|------|------|-------------------|
| URL normalizer rules | Unit (Vitest) | GitHub, GitLab, Dropbox URL rewrites |
| RemoteLoader error handling | Unit (Vitest, mock fetch) | Correct status classification for all error types |
| UrlInput rendering | Unit (Vitest, DOM) | Input validation, error display, token prompt |
| End-to-end public URL | Manual | Load a real IFC from GitHub, verify render |
| End-to-end CORS rejection | Manual | Try a URL without CORS headers, verify graceful message |
| End-to-end auth flow | Manual | Try a private repo URL, enter token, verify load |
| Query parameter | Manual | Open viewer with `?url=...`, verify confirmation + load |

---

---

# SharePoint / OneDrive Integration

## The challenge

SharePoint does **not** serve files with CORS headers for direct browser `fetch`. Unlike GitHub's `raw.githubusercontent.com`, there's no public raw URL you can hit from client-side JS. This means the standard `fetch(url)` approach won't work.

## How SharePoint file access works

SharePoint/OneDrive files are accessed via the **Microsoft Graph API**:

```
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives/{drive-id}/items/{item-id}/content
```

This API **does support CORS** — but requires an OAuth2 access token from Azure AD (Entra ID).

## Authentication flow

SharePoint uses **OAuth 2.0 Authorization Code flow with PKCE** (suitable for SPAs with no backend):

```
1. User clicks "Load from SharePoint"
2. App redirects to Microsoft login:
   https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
   ?client_id=<app-id>
   &response_type=code
   &redirect_uri=<viewer-url>
   &scope=Files.Read Sites.Read.All
   &code_challenge=<PKCE-challenge>

3. User signs in with their Microsoft account → redirected back with auth code
4. App exchanges code for access token (client-side, PKCE makes this safe)
5. App calls Graph API with token to download the IFC file
6. Token expires after ~1 hour; refresh token can extend the session
```

### What's needed to make this work

| Requirement | Detail |
|------------|--------|
| **Azure AD App Registration** | Register the viewer as an app in Azure portal. This is free and takes ~5 minutes. Gives you a `client_id`. |
| **MSAL.js library** | Microsoft's official auth library for SPAs. Handles the OAuth/PKCE flow, token caching, silent refresh. ~30KB gzipped. |
| **Redirect URI** | The viewer's GitHub Pages URL must be registered as a redirect URI in the Azure app. |
| **API permissions** | `Files.Read` (user's OneDrive) and/or `Sites.Read.All` (SharePoint sites). These are delegated permissions — the app acts as the signed-in user, not as itself. |
| **Tenant configuration** | For multi-tenant use (any Microsoft org), the app must be registered as multi-tenant. For a single org, single-tenant is simpler. |

### User experience for SharePoint

Two possible UX flows:

**Option A: Paste SharePoint URL**
1. User pastes a SharePoint link like `https://company.sharepoint.com/sites/Project/Documents/model.ifc`
2. Viewer detects the SharePoint domain pattern
3. Prompts Microsoft sign-in (if not already authenticated)
4. Resolves the URL to a Graph API path using SharePoint's `shares` API:
   ```
   GET https://graph.microsoft.com/v1.0/shares/{encoded-sharing-url}/driveItem/content
   ```
5. Downloads and renders

**Option B: SharePoint file picker**
1. User clicks "Load from SharePoint"
2. Opens Microsoft's built-in file picker component
3. User browses their SharePoint/OneDrive and selects an IFC file
4. Picker returns a download URL + token
5. Viewer fetches and renders

Option A is more natural for users who already have a link. Option B is better for browsing. Both can coexist.

### Practical considerations

| Aspect | Impact |
|--------|--------|
| **Still no backend** | MSAL.js + PKCE is designed for pure client-side apps. The "no backend" principle is preserved. |
| **App registration is a one-time step** | You do it once in Azure portal, then it works for all users. |
| **Multi-tenant vs single-tenant** | Multi-tenant lets anyone with a Microsoft account use it. Single-tenant locks it to one org. For a public viewer, multi-tenant makes sense. |
| **Admin consent** | Some orgs require an admin to approve `Sites.Read.All`. `Files.Read` usually doesn't need admin consent. |
| **Token security** | MSAL.js handles storage (sessionStorage by default). Tokens are scoped to read-only file access. |
| **Dependency** | Adds `@azure/msal-browser` as a dependency (~30KB gzipped). Only loaded when user initiates SharePoint auth. |
| **Complexity** | Significantly more complex than the public URL flow. The OAuth dance, token refresh, and Graph API resolution add substantial code. Worth it if SharePoint is a primary use case for your users. |

### SharePoint implementation outline

```
src/
├── loader/
│   └── SharePointLoader.ts    (NEW — Graph API integration)
├── services/
│   └── MsalAuth.ts            (NEW — MSAL.js wrapper, token management)
├── ui/
│   └── SharePointButton.ts    (NEW — "Load from SharePoint" button + picker)
```

### Recommendation

**Don't build SharePoint support in Phase 1.** Start with public URLs (GitHub, presigned cloud links). If SharePoint is a confirmed need for your users:

1. Register an Azure AD app (free, 5 minutes)
2. Add MSAL.js + the SharePoint loader as a Phase 2 feature
3. Start with Option A (paste URL) since it reuses the existing URL input UX
4. Add Option B (file picker) later if users want to browse

The Graph API sharing URL approach (`/shares/{encoded-url}/driveItem/content`) is particularly elegant because users just paste their normal SharePoint link — no need to understand Graph API paths.
