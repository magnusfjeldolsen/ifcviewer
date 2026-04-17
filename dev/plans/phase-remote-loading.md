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
  name: string;                         // e.g. "GitHub", "SharePoint", "Google Drive"
  clientId: string;
  authorizeUrl: string;                 // e.g. "https://github.com/login/oauth/authorize"
  tokenUrl: string;                     // e.g. "https://github.com/login/oauth/access_token"
  scopes: string[];                     // e.g. ["repo"]
  domainPattern: RegExp;                // e.g. /github\.com/
  flow: 'redirect' | 'device';         // redirect = OAuth2 PKCE popup; device = GitHub-style device flow
  resolveDownloadUrl: (url: string, token: string) => Promise<string>;
}
```

Two flow types:
- **`redirect`** (SharePoint, Google): standard OAuth2 PKCE — popup/redirect to provider login, redirect back with code, exchange for token. Works when the provider's token endpoint supports CORS.
- **`device`** (GitHub): user gets a code, enters it on github.com/login/device, app polls for the token. No redirect, no CORS proxy needed. Better UX for providers whose token endpoint doesn't support browser CORS.

The `resolveDownloadUrl` function is the only truly provider-specific logic. Everything else (PKCE challenge generation, token exchange, device polling, caching, refresh) is shared.

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

**Example: GitHub config (private repos)**
```ts
const github: OAuthProviderConfig = {
  name: 'GitHub',
  clientId: '<github-oauth-app-id>',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['repo'],
  domainPattern: /github\.com/,
  resolveDownloadUrl: async (url, token) => {
    // Rewrite github.com blob URL to raw URL (same as urlNormalizer, but now authed)
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
    if (match) {
      const [, user, repo, ref, path] = match;
      return `https://raw.githubusercontent.com/${user}/${repo}/${ref}/${path}`;
    }
    return url;
  },
};
```

Note: GitHub OAuth has a quirk — the token exchange (`access_token` endpoint) does not support CORS from browsers. This means the token exchange step needs either:
- A tiny serverless proxy (Cloudflare Worker / Netlify Function) to forward the code-for-token exchange, OR
- Using GitHub's [Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) which avoids the redirect entirely — user gets a code, enters it on github.com, and the app polls for the token. This works fully client-side but is a slightly different UX.

The `OAuthProvider` should support both redirect-based and device-based flows to accommodate providers like GitHub. The device flow is actually simpler for the user (no redirect, no popup) and avoids the CORS proxy requirement entirely.

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
2. If the direct fetch returns 401/403 AND the URL matches a provider in the registry by `domainPattern` → trigger OAuth flow → resolve download URL → `RemoteLoader.fetch()` with token
3. If the direct fetch returns 401/403 and no provider matches → show manual token input (Phase 1.5 fallback)
4. No match in normalizer → `RemoteLoader.fetch()` directly (optimistic try)

This means GitHub URLs follow a natural escalation: public repos work in Phase 1 (url rewrite → direct fetch), private repos get the manual token prompt in Phase 1.5, and proper "Sign in with GitHub" arrives in Phase 2.

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

### Phase 2: Generic OAuth framework + first providers
- [ ] Create `OAuthProvider.ts` — generic OAuth2/PKCE handler (authorize, exchange, cache, refresh)
- [ ] Support both redirect-based flow (SharePoint, Google) and device flow (GitHub) in `OAuthProvider`
- [ ] Create `providerRegistry.ts` — array of provider configs
- [ ] Add GitHub OAuth config — register GitHub OAuth App (free, ~2 min), implement device flow for token exchange
- [ ] Add SharePoint config — register Azure AD app (free, ~5 min), configure redirect URI, `resolveDownloadUrl` via Graph API `/shares/` endpoint
- [ ] Detect provider by domain pattern on 401/403 → trigger appropriate OAuth flow → resolve download URL → fetch with token
- [ ] Add lazy-loading for OAuth dependencies (only loaded when an OAuth provider is triggered)
- [ ] Write tests for `OAuthProvider` (mock redirect flow, mock device flow, token refresh)
- [ ] Write tests for GitHub and SharePoint URL resolution
- [ ] Manual testing with private GitHub repo + SharePoint-hosted IFC files

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
| End-to-end GitHub OAuth | Manual | Paste private repo URL, sign in with GitHub, verify load |
| End-to-end SharePoint | Manual | Paste SharePoint link, sign in with Microsoft, verify load |
| Query parameter | Manual | Open viewer with `?url=...`, verify confirmation + load |

---

---

# Save / Open Project

## Goal

Let users save the current viewer state as a portable `.ifcproject` JSON file, and reopen it later — even after working in a different project. This complements the "remember" toggle (which persists one session in IndexedDB) by enabling multiple named projects and cross-session workflows.

## How it relates to remote loading

Remote loading makes project files powerful. Without it, a project file can only say "you had a file called `building.ifc`" — the user has to re-upload. With remote loading, the project file stores URLs and the viewer can **automatically re-fetch everything** on open.

## Project file format

```json
{
  "version": 1,
  "name": "Office Tower Phase 2",
  "savedAt": "2026-04-17T14:30:00Z",
  "models": [
    {
      "name": "architecture.ifc",
      "source": {
        "type": "remote",
        "url": "https://raw.githubusercontent.com/team/project/main/architecture.ifc",
        "provider": "github"
      }
    },
    {
      "name": "structure.ifc",
      "source": {
        "type": "remote",
        "url": "https://company.sharepoint.com/sites/Project/Documents/structure.ifc",
        "provider": "sharepoint"
      }
    },
    {
      "name": "mep-local.ifc",
      "source": {
        "type": "local"
      }
    }
  ],
  "camera": {
    "position": [10.5, 8.2, 15.0],
    "target": [0, 0, 0],
    "up": [0, 1, 0]
  }
}
```

Key design decisions:
- **`source.type: "remote"`** — the viewer can re-fetch automatically. The URL is the source of truth.
- **`source.type: "local"`** — the file was uploaded from disk. The project file only stores the name as a hint. On open, the viewer prompts: *"mep-local.ifc was loaded from your computer — please re-upload it to restore."*
- **`source.provider`** — optional hint for which OAuth provider to use. The viewer can also detect this from the URL domain, but storing it makes the intent explicit.
- **`version`** — for future format changes.
- **No IFC data in the project file.** It stores references, not content. This keeps project files tiny (< 1KB) and avoids duplicating large binary data.

## User-facing flow

### Save Project

```
User clicks "Save Project" (toolbar or menu)
  → If no project name set, prompt for one
  → Serialize current state to JSON
  → Browser downloads `<project-name>.ifcproject`
```

### Open Project

```
User drops / browses a .ifcproject file
  → Parse JSON, validate version
  → For each model in models[]:
      → source.type === "remote": trigger RemoteLoader.fetch(url)
          → may trigger OAuth if provider requires it
          → show progress per model
      → source.type === "local": show "please re-upload <name>" in model tree
  → Restore camera state after all models loaded
  → Show status: "Loaded 2/3 models — 1 requires local re-upload"
```

### Open via query parameter

Extend the existing `?url=` parameter to also support project files:

```
?project=https://raw.githubusercontent.com/.../office-tower.ifcproject
```

This enables shareable "open this project" links. The viewer fetches the project file, then fetches all the models listed in it.

## Relationship to the "remember" toggle

| Feature | Remember toggle | Project file |
|---------|----------------|-------------|
| Storage | IndexedDB (browser-local) | JSON file (portable) |
| Scope | Last session only | Named, multiple projects |
| IFC data | Stores actual buffers | Stores URLs/references only |
| Shareable | No | Yes (if models are remote) |
| Survives browser clear | No | Yes (it's a file on disk) |
| Works offline | Yes (data is cached) | Only for local-source models |

They coexist: the remember toggle is for "pick up where I left off", project files are for "switch between projects" and "share a project setup with a colleague".

## Architecture

### New module: `src/project/ProjectFile.ts`

Handles serialization and deserialization of the project format:

```ts
interface ProjectFile {
  version: number;
  name: string;
  savedAt: string;
  models: ProjectModel[];
  camera?: CameraState;
}

interface ProjectModel {
  name: string;
  source: { type: 'remote'; url: string; provider?: string }
        | { type: 'local' };
}

function serializeProject(state: AppState): ProjectFile;
function deserializeProject(json: unknown): ProjectFile;  // validates + type-checks
```

### New UI: Save/Open buttons

- **Save**: button in toolbar or alongside the memory toggle. Downloads `.ifcproject` file via `<a download>` trick (no backend needed).
- **Open**: the existing drop zone and file input accept `.ifcproject` in addition to `.ifc`. Detected by extension.

### Integration in App.ts

- `saveProject()`: gathers current model list (with source URLs for remote models), camera state, and project name → `serializeProject()` → download
- `openProject()`: reads `.ifcproject` file → `deserializeProject()` → for each remote model, calls the same fetch pipeline → for local models, marks as "needs re-upload" in the model tree

The model tree panel gains a status indicator per model: loaded, loading, needs re-upload, failed.

## File structure (new/modified)

```
src/
├── project/
│   ├── ProjectFile.ts         (NEW — serialize/deserialize project JSON)
│   └── index.ts
├── core/
│   └── App.ts                 (add saveProject/openProject methods)
├── ui/
│   └── Toolbar.ts             (add Save Project button)
├── loader/
│   └── FileLoader.ts          (accept .ifcproject extension in drop zone + file input)

tests/
├── project/
│   └── ProjectFile.test.ts    (NEW — serialization, validation, edge cases)
```

## Implementation checklist

- [ ] Define `ProjectFile` interface and version 1 schema
- [ ] Create `ProjectFile.ts` with `serializeProject()` and `deserializeProject()` (with validation)
- [ ] Track model source (remote URL or local) in `App.ts` when models are loaded
- [ ] Add "Save Project" button — serialize state → download as `.ifcproject`
- [ ] Extend drop zone and file input to accept `.ifcproject` files
- [ ] Implement `openProject()` — parse JSON → fetch remote models → flag local models for re-upload
- [ ] Add per-model status in model tree (loading / loaded / needs re-upload / failed)
- [ ] Add `?project=` query parameter support
- [ ] Write tests for serialization/deserialization (valid, invalid, missing fields, version mismatch)
- [ ] Write tests for open flow (mix of remote + local sources)
- [ ] Manual testing: save project with remote models → close tab → open project file → verify re-fetch

## Security considerations

| Concern | Mitigation |
|---------|-----------|
| Malicious project file with crafted URLs | Same protections as direct URL input — HTTPS only, confirmation before fetching, `textContent` for display |
| Project file from untrusted source | Show models list and domains before fetching: "This project will load files from github.com and company.sharepoint.com. Continue?" |
| Storing auth tokens in project file | Never. Project files store URLs only. Auth is handled at fetch time by the OAuth/token flow. |
| Large model list (DoS) | Cap at a reasonable limit (e.g. 50 models). Show total count before loading. |

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
