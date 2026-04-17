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
  "thumbnail": "data:image/png;base64,iVBOR...",
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
- **`thumbnail`** — small base64-encoded screenshot of the 3D view at save time. Used for the recent projects list and as a visual preview when opening shared project files.
- **`version`** — for future format changes.
- **No IFC data in the project file.** It stores references, not content. This keeps project files tiny (a few KB with thumbnail) and avoids duplicating large binary data.
- **Relative URLs** — if the project file lives alongside the IFCs (e.g. same GitHub repo or same SharePoint folder), model URLs can be relative. This means moving the entire folder doesn't break links. The viewer resolves relative URLs against the project file's own URL when loaded via `?project=`.

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

- [ ] Define `ProjectFile` interface and version 1 schema (including thumbnail + relative URL support)
- [ ] Create `ProjectFile.ts` with `serializeProject()` and `deserializeProject()` (with validation)
- [ ] Track model source (remote URL or local) in `App.ts` when models are loaded
- [ ] Capture canvas thumbnail on save (`canvas.toDataURL()`, resized to ~200px)
- [ ] Add "Save Project" button — serialize state → download as `.ifcproject`
- [ ] Extend drop zone and file input to accept `.ifcproject` files
- [ ] Implement `openProject()` — parse JSON → fetch remote models → flag local models for re-upload
- [ ] Add per-model status in model tree (loading / loaded / needs re-upload / failed)
- [ ] Add `?project=` query parameter support (resolve relative model URLs against project file URL)
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

# Project Sharing

## The vision

A user sets up a project (loads IFCs from various sources, positions the camera, names it). They should be able to share that exact setup with a colleague in one step — no instructions needed, no "download these 4 files and upload them in this order".

## Sharing models

### Scenario 1: All models are remote

The project file contains only URLs. Sharing is trivial:

**Option A: Share a link**
```
https://magnusfjeldolsen.github.io/ifcviewer/?project=https://raw.githubusercontent.com/team/repo/main/project.ifcproject
```
Colleague clicks the link → viewer opens → fetches the project file → fetches all models → restores camera. Done.

**Option B: Send the project file**
Email/Slack the `.ifcproject` file (a few KB). Colleague drops it on the viewer. Same result.

### Scenario 2: Mixed remote + local models

The project file contains some remote URLs and some local-only references. When a colleague opens it:
- Remote models load automatically
- Local models show in the model tree as "needs re-upload" with the filename as a hint
- The colleague uploads the missing files from their own disk

This is the realistic scenario for teams that keep some files on a shared network drive and some in the cloud.

### Scenario 3: Project file hosted alongside IFCs

The most seamless setup. The `.ifcproject` file lives in the same location as the IFC files (same GitHub repo, same SharePoint folder):

```
SharePoint: /sites/Project/BIM/
├── project.ifcproject
├── architecture.ifc
├── structure.ifc
└── mep.ifc
```

The project file uses **relative URLs**:
```json
{
  "models": [
    { "name": "architecture.ifc", "source": { "type": "remote", "url": "./architecture.ifc" } },
    { "name": "structure.ifc", "source": { "type": "remote", "url": "./structure.ifc" } },
    { "name": "mep.ifc", "source": { "type": "remote", "url": "./mep.ifc" } }
  ]
}
```

The viewer resolves relative URLs against the project file's own URL. Moving the entire folder to a different location doesn't break anything. This is the recommended setup for teams.

## "Copy shareable link" button

After loading models, the toolbar shows a share icon. Clicking it:

1. If the current state can be represented as a URL (all models are remote):
   - Generate a `?project=` link if a hosted project file exists
   - Or generate a `?url=` link if it's a single model
   - Copy to clipboard with a toast: "Link copied"

2. If some models are local (can't be represented as a URL):
   - Offer to download the `.ifcproject` file instead
   - Show a hint: "Some models are local — your colleague will need access to those files"

## Deep linking to specific views

Extend the URL to encode view state beyond just "which models":

```
?project=<url>&camera=10.5,8.2,15.0,0,0,0
```

This lets users share a link that opens a specific angle on the model. The camera parameter encodes `position.x,y,z,target.x,y,z`.

Future: encode active clipping planes, selected objects, visibility toggles. This turns a link into "look at exactly this" rather than "open this project".

## Security for shared projects

| Concern | Mitigation |
|---------|-----------|
| Crafted project link with malicious URLs | Confirmation dialog listing all domains before fetching |
| Phishing via `?project=` on a look-alike domain | Show the actual domains being fetched, not just the project name |
| Sharing exposes file locations | The project file reveals where IFCs are stored. This is inherent to the sharing model — users should be aware their file paths/URLs are visible to recipients |

---

---

# UX Improvements

## 1. Recent Projects (localStorage)

### What it does

Cache project metadata in localStorage whenever a project is opened or saved. Show a "Recent Projects" list on the landing page so returning users can reopen without finding the `.ifcproject` file on disk.

### Landing page with recent projects

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│     Drop an .ifc or .ifcproject file here                │
│                    or                                     │
│               [ Browse ]                                  │
│                    or                                     │
│   ┌────────────────────────────────┐  ┌──────┐           │
│   │ Paste a URL to an .ifc ...     │  │ Load │           │
│   └────────────────────────────────┘  └──────┘           │
│                                                          │
│   Recent projects                                        │
│   ┌────────────────────────────────────────────────────┐ │
│   │ ┌──────┐  Office Tower Phase 2                     │ │
│   │ │thumb │  3 models · github.com, sharepoint.com    │ │
│   │ │ nail │  Last opened 2 hours ago                  │ │
│   │ └──────┘                                           │ │
│   ├────────────────────────────────────────────────────┤ │
│   │ ┌──────┐  Hospital Wing B                          │ │
│   │ │thumb │  5 models · sharepoint.com                │ │
│   │ │ nail │  Last opened yesterday                    │ │
│   │ └──────┘                                           │ │
│   └────────────────────────────────────────────────────┘ │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### What's stored in localStorage

```ts
interface RecentProject {
  name: string;
  thumbnail?: string;          // base64, from project file or captured on save
  modelCount: number;
  domains: string[];           // unique domains of remote models, for context
  lastOpened: string;          // ISO date
  project: ProjectFile;        // the full project definition (tiny — just URLs)
}
```

Clicking a recent project = deserializing the stored `ProjectFile` and running the same `openProject()` flow. No file needed.

**Limit**: keep the 10 most recent. Prune on each open.

### Implementation checklist

- [ ] Create `RecentProjects` service (localStorage read/write, prune to 10)
- [ ] Record project in recent list on save and on open
- [ ] Create `RecentProjectsList` UI component for landing page
- [ ] Show thumbnail, name, model count, domains, relative time
- [ ] Click to reopen → `openProject()` with stored `ProjectFile`
- [ ] "Clear recent" option
- [ ] Graceful fallback if localStorage is unavailable (private browsing)

---

## 2. Multi-file drop and multi-select

### What it does

Accept multiple `.ifc` files in a single drop or browse action. Currently only `files[0]` is read.

### Changes

- Drop zone: iterate all `dataTransfer.files`, filter for `.ifc` and `.ifcproject`
- File input: add `multiple` attribute, iterate all `input.files`
- If a `.ifcproject` is included alongside `.ifc` files, the project file takes precedence (it defines the project structure)
- Show aggregate progress: "Loading 3 of 5 models..."

### Implementation checklist

- [ ] Update `FileLoader.setupDropZone()` to iterate all dropped files
- [ ] Update `FileLoader.setupFileInput()` — add `multiple` attribute, iterate all files
- [ ] Handle mixed `.ifc` + `.ifcproject` drops (project file wins)
- [ ] Update status display for multi-file progress
- [ ] Update file input `accept` attribute to include `.ifcproject`

---

## 3. Clipboard URL detection

### What it does

When the user presses `Ctrl+V` / `Cmd+V` anywhere on the page (and no text input is focused), check the clipboard for an HTTPS URL. If found, auto-populate the URL input field and focus it. The user just presses Enter or clicks Load.

### Flow

```
User copies a URL from Slack/email/browser
  → Switches to viewer tab
  → Ctrl+V
  → URL input auto-fills, cursor ready
  → Enter → fetch begins
```

### Implementation checklist

- [ ] Add global `paste` event listener (when no input element is focused)
- [ ] Check clipboard text against HTTPS URL pattern
- [ ] If match, populate URL input and focus it
- [ ] If URL input already has content, don't overwrite (avoid accidental replacement)

---

## 4. Canvas thumbnail

### What it does

Capture a screenshot of the current 3D view when saving a project. Stored as a small base64 PNG in the project file and in the recent projects list.

### Implementation

```ts
function captureThumb(canvas: HTMLCanvasElement, maxSize = 200): string {
  // Three.js requires preserveDrawingBuffer or render-then-capture in same frame
  // Create offscreen canvas, drawImage scaled down, toDataURL
}
```

Note: Three.js canvases need `preserveDrawingBuffer: true` on the renderer, OR the thumbnail must be captured in the same frame as a render call. The latter is better (no performance penalty from preserveDrawingBuffer).

### Implementation checklist

- [ ] Add `captureThumb()` utility — scale canvas to ~200px, return base64 PNG
- [ ] Capture in the render loop (after next frame) to avoid preserveDrawingBuffer
- [ ] Include thumbnail in `serializeProject()` output
- [ ] Display thumbnails in recent projects list

---

## 5. "Copy shareable link" button

(Detailed in the Project Sharing section above.)

### Implementation checklist

- [ ] Add share button to toolbar (shown when models are loaded)
- [ ] Generate `?url=` link for single remote model
- [ ] Generate `?project=` link if a hosted project file URL is known
- [ ] Copy to clipboard + toast notification
- [ ] Fallback: offer `.ifcproject` download if models include local sources
- [ ] Support `&camera=` parameter for deep linking to specific views

---

## 6. Parallel model fetching with progress overview

### What it does

When opening a project with multiple remote models, fetch them in parallel (not sequentially). Show a per-model progress view:

```
┌────────────────────────────────────────┐
│  Opening "Office Tower Phase 2"        │
│                                        │
│  ✓ architecture.ifc     (42 MB)        │
│  ◻ structure.ifc        (18 MB) 67%    │
│  ◻ mep.ifc              (95 MB) 12%    │
│  ⚠ electrical.ifc       needs upload   │
│                                        │
│              [ Cancel ]                │
└────────────────────────────────────────┘
```

### Implementation

- Use `Promise.allSettled()` to fetch all remote models in parallel
- Track per-model progress via `ReadableStream` from `fetch` response
- Render a loading overlay with per-model status
- Parse and render models as they arrive (don't wait for all to finish)
- Cancel button aborts all in-flight fetches via `AbortController`

### Implementation checklist

- [ ] Parallel fetch with `Promise.allSettled()` + per-model `AbortController`
- [ ] Track download progress per model via response stream
- [ ] Create loading overlay UI with per-model status (done / progress % / needs upload / failed)
- [ ] Parse and add models to scene incrementally as they complete
- [ ] Cancel button to abort all fetches
- [ ] Camera fit after all models loaded (or after timeout)

---

---

# Additional UX ideas (for review — not yet in plan)

These are higher-effort or more speculative ideas. Including them here for consideration before committing to the plan.

## A. Embed mode (iframe-friendly)

Add a `?embed=true` parameter that strips the toolbar, upload prompt, and footer — leaving just the 3D viewport with orbit controls. This lets teams embed a live model view in:
- SharePoint wiki pages
- Confluence/Notion docs
- Project dashboards
- Internal portals

Combined with `?project=` and `&camera=`, an iframe embed becomes:
```html
<iframe src="https://magnusfjeldolsen.github.io/ifcviewer/?project=...&embed=true&camera=10,8,15,0,0,0"
        width="800" height="600"></iframe>
```

Relatively simple to implement (conditionally hide UI), high shareability impact.

## B. QR code generation for on-site use

Construction sites. People have tablets. Generate a QR code for the project/model link that can be printed on drawings or displayed on signage. Workers scan it → viewer opens on their device with the model loaded.

This is just a QR encoding of the shareable link — a small library (`qrcode` npm, ~10KB) renders it in a modal. Low effort, high value for the construction use case.

## C. "Watch for changes" on remote models

If the project references remote IFCs that may be updated (e.g. a designer pushes a new version), the viewer can periodically check if the file has changed:
- `HEAD` request to compare `ETag` or `Last-Modified` header
- If changed, show a notification: "architecture.ifc has been updated. Reload?"
- User clicks reload → re-fetch just that model, keep everything else

Useful for teams where models are actively being revised. Polling interval configurable (e.g. every 5 minutes), only while the tab is active.

## D. Offline project caching (Service Worker)

Register a service worker that caches fetched IFC files. When a project is opened and all models are fetched, cache them. Next time the same project is opened — even offline — the cached versions load instantly.

This bridges the gap between "remember toggle" (IndexedDB, one session) and "project file" (portable, no data). The service worker cache gives you: portable project definition + fast/offline reopening.

More complex to implement, but makes the "reopen a project" flow instant rather than re-downloading hundreds of MB.

## E. Model version pinning

Project files can reference specific versions of IFC files, not just "latest":
- GitHub: `https://raw.githubusercontent.com/team/repo/<commit-sha>/model.ifc` instead of `main`
- SharePoint: version history API
- S3: object versioning

This is critical for audit/compliance contexts where you need to know exactly which model version was reviewed. The project file becomes a snapshot of a point in time.

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
