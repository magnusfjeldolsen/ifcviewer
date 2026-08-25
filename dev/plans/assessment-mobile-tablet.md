# Assessment — Mobile & Tablet

**Status:** assessment only. Nothing here is approved; this document exists to let you choose.
**Branch:** `assess/mobile-tablet`
**Codebase assessed:** `origin/main` @ `d517f0c` (743 tests green, lint + typecheck clean)
**Goal in the user's words:** *"clients get a verified link to our cloud storage where we can put one or more IFC models. Then they can easily navigate and see how things are put together."* — where "cloud storage" means **share links from Google Drive, SharePoint, OneDrive, or a NAS**, i.e. services you already pay for. No new hosting, no auth backend.

---

## TL;DR — every decision you need to make

Read this table, answer the right-hand column, and the rest of the document is just the reasoning.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Which share-link providers do we support?** A browser can only read a file cross-origin if the host sends CORS headers. **This was tested live against real links — and the answer is better than expected.** | (a) Google Drive only. (b) Drive + SharePoint/OneDrive-for-Business. (c) Add NAS. (d) Add OneDrive personal. | **(b) now — and it needs no backend at all.** **Google Drive works, proven with a real file. SharePoint / OneDrive-for-Business works, proven with a real link from your own tenant.** Both need nothing but a URL rewrite rule in `urlNormalizer.ts` — roughly 20 lines, no infrastructure. NAS (c) is possible but is genuinely sysadmin work, not one header; do it only where a client asks. Dropbox, despite being the one provider we already have a rule for, is effectively **unusable** by paste-a-link — see the table below. |
| **D2** | **What does "verified" actually mean?** With plain share links it means *unguessable URL*, not *per-recipient access control*. These are different products. | (a) Unguessable "anyone with the link" URL, optionally expiring. (b) Per-recipient access control — named people must sign in. | **(a) — and note that the rewritten URL is exactly as sensitive as the original share link.** Anyone holding either can download the file; the rewrite grants no new access and removes none. That *is* the capability-URL model, and it is what "verified" will mean in practice. (b) would require the recipient to authenticate with Google/Microsoft *and* the viewer to hold an OAuth client — a sign-in wall in front of a client who just wants to look at their building. Choose (a) consciously; read the capability-URL caveats below first. |
| **D3** | **Can a phone even open our models?** The other hard constraint, and unchanged. | (a) Assume yes, ship the UI work, find out later. (b) **Measure first** on real hardware. | **(b), this week, half a day.** Our own profiling says a two-model federated scene costs ~340 MB of heap. iPhones before the 15 sit around 200–450 MB per tab. There is a real chance the answer is "no" for the models you want to show. Do not plan around a guess. |
| **D4** | **How do phone-sized models get made** (if D3 says they don't fit)? | (a) Ship raw IFC, accept small models only. (b) Server-side conversion (the Autodesk/Dalux answer). (c) **Publish-once from the desktop viewer** into a compact file the phone loads directly. (d) Adopt xeokit XKT or That Open Fragments. | **(c).** We already have 90 % of it: `GeometryCache.serializeMeshes` already turns parsed geometry into a compact typed-array `ArrayBuffer`. A "Publish for mobile" button writing that buffer to a `.ifcview` file needs no new dependency, no server, and no licence question. xeokit is **AGPL-or-pay**; Fragments is MIT and the honest fallback. |
| **D5** | **What do we cut on small screens?** | (a) Nothing — shrink everything. (b) **A distinct read-only "presentation" layout**: navigate, tap to identify, browse the tree, section. Everything else hidden. | **(b), auto-detected, with a "show all tools" escape hatch.** Marquee select, measurement, clipping placement, the basket and the inspector's deep tables are all mouse-and-large-screen features. This is the highest-value UI decision in the document. |
| **D6** | **Touch gestures — keep or change?** | (a) Keep one-finger orbit (today). (b) Switch to one-finger pan, map-style. | **(a) keep.** One-finger orbit matches Sketchfab, BIMx, `<model-viewer>` and the three.js default. Add double-tap-to-fit and a visible reset button. |
| **D7** | **Tap-to-select tolerance** | (a) Leave the 3 px click/drag threshold. (b) Raise it for `pointerType === 'touch'`. | **(b), ~10 px.** Verified: `CLICK_THRESHOLD = 3` CSS px with no touch branch. A finger jitters more than 3 px on almost every tap. One-line change, probably the biggest "it feels broken" fix available. |
| **D8** | **First thing a client sees on a shared link** | (a) Today: a raw `window.confirm()` showing the URL, then an analytics-consent prompt, then a ~60 s parse with no progress bar — and if the fetch fails, **nothing at all**. (b) Model first, consent deferred, real errors. | **(b).** Three interruptions before any building appears is the opposite of a "wow". |
| **D9** | **Fallback when a rewrite doesn't work** | (a) CORS proxy. (b) "Download it, then open it" — a plain link, then the existing file picker. (c) Re-host that one file on a CORS-friendly static host. (d) OAuth picker (Google Picker / MS Graph). | **(b) as the always-visible fallback, (c) for the occasional stubborn file. Not (a), ever.** (b) is exempt from CORS entirely, works on every provider and every device with zero configuration, and already works today — it costs two taps. A proxy means client model bytes transit a third party (likely disqualifying for project data) and both major public proxies **failed when I tested them live**. |
| **D10** | **Native app?** | (a) Web only. (b) PWA (installable, home-screen icon). (c) Native iOS/Android. | **(a) now, (b) in phase 2, never (c).** Dalux, Revizto and Trimble all went native — we cannot match that. But (b) is cheap and buys the home-screen icon that makes it *feel* like an app. |
| **D11** | **Who do we promise this works for?** | (a) Phones and tablets equally. (b) **Tablets first-class, phones best-effort with an honest size guard.** | **(b).** Tablets are where the industry actually does this (Dalux, StreamBIM, Revizto V5 are all tablet-first) and where the memory budget is realistic. |
| **D12** | **Sequencing** | (a) Wait for the storage answer. (b) **Ship phase 1 now.** | **(b).** Phase 1 needs no backend, no format work and no money. It is the demo. |

**If you only answer two questions, answer D1 and D3.**

**And one piece of good news up front:** the tension I expected to find between this feature and the `CLAUDE.md` "no backend" goal **does not exist**. Both providers that matter serve anonymous share links to a browser cross-origin, so nothing here requires a server we operate — the models live in storage you already own. The goal survives intact, and the expensive parts of this assessment turned out to be unnecessary.

---

## Headline finding 1 — the link works, with no backend at all

This is the crux: a browser can only read a cross-origin file if the host sends `Access-Control-Allow-Origin`. If it doesn't, the whole mobile-sharing story fails regardless of how good the touch UX is.

I expected this to be the section where the feature died. **It isn't.** Both providers that matter — Google Drive and SharePoint/OneDrive-for-Business — serve anonymous share links to a browser cross-origin, provided you rewrite the URL to the right endpoint. **No backend, no proxy, no OAuth, no sign-in.**

All probes below were run on **2026-08-25** with an `Origin: https://…github.io` header, against real endpoints and, where noted, real files.

### Per-provider verdict

| Provider / endpoint | Browser `fetch()` from github.io | Evidence |
|---|---|---|
| **Google Drive** — `drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`, **GET** | ✅ **YES — proven with a real file, reproduced** | Live probes against a real public 1.44 GB Drive file: `HTTP 206 Partial Content`, **`Access-Control-Allow-Origin: *`**, `Content-Type: application/octet-stream`, `Content-Range: bytes 0-31/1443490838`. Real bytes returned. Reproduced on separate attempts minutes apart. |
| **Google Drive — same URL, `HEAD`** | ❌ **NO — and this bites us** | `HTTP 200` but `Content-Type: text/html`, `Content-Length: 0`, **no `Access-Control-Allow-Origin`**, and a `Set-Cookie: NID=…; HttpOnly` on `.google.com`. Reproduced three times consecutively. **See the note below — `RemoteLoader` does a HEAD pre-check.** |
| **Google Drive without `confirm=t`** | ❌ NO — virus-scan interstitial | Same file, `confirm=t` removed: `HTTP 200` but `Content-Type: text/html`. Google documents a **100 MB virus-scan limit** ([Drive Help](https://support.google.com/drive/answer/141702)), so essentially every real IFC over 100 MB hits this. **`confirm=t` is the whole trick.** |
| **Google Drive — invalid / non-public ID** | ❌ NO | `HTTP 404`, `text/html`, no ACAO. **This is why the internet says Drive has no CORS** — see the reconciliation note below. |
| **Google Drive legacy** — `drive.google.com/uc?export=download` | ❌ NO | `HTTP 403`, no `Access-Control-Allow-Origin`. Same for `docs.google.com/uc?export=download`. |
| **Google Drive API v3** — `www.googleapis.com/drive/v3/files/<id>?alt=media` | ⚠️ CORS-enabled, but needs an API key or OAuth | `HTTP 403` **with `Access-Control-Allow-Origin: https://magnusfjeldolsen.github.io`** — it reflects the caller's origin, so the API is CORS-aware. Not needed if the `confirm=t` path works. |
| **SharePoint / OneDrive for Business** — `<tenant>.sharepoint.com/personal/<user>/_layouts/15/download.aspx?share=<shareId>` | ✅ **YES — proven with a real link from the user's own tenant** | Live test against an "anyone with the link" share of a Revit-exported IFC: **`HTTP 200 OK`, `Access-Control-Allow-Origin: *`, `Content-Type: application/octet-stream`, body begins `ISO-10303-21;`** — real IFC bytes. Preflight `OPTIONS` → `200` with `ACAO: *`, `Access-Control-Allow-Methods: GET, HEAD, …`, `Access-Control-Max-Age: 2592000`. **`Access-Control-Expose-Headers` includes `Accept-Ranges` and `Content-Length`** — so HTTP range requests are genuinely available, which matters for any future progressive loading. |
| **SharePoint** — raw share link `/:u:/g/personal/<user>/<id>?e=<tok>` | ❌ NO | 302 → the `onedrive.aspx` web viewer. No ACAO. |
| **SharePoint** — `…?e=<tok>&download=1` | ❌ NO | 302 → a direct file path, then **403** — the redirect drops the share token, so the second hop is unauthenticated. |
| **SharePoint / OneDrive for Business** — Graph `/v1.0/shares/u!<b64>/driveItem/content` | ❌ NO without OAuth — but **no longer needed** | `HTTP 401`, `{"code":"InvalidAuthenticationToken","message":"Access token is empty."}`, `WWW-Authenticate: Bearer …`. CORS is fine (`ACAO: *`); authentication is the blocker. Superseded by the `download.aspx` route above. |
| **OneDrive personal** — legacy `api.onedrive.com/v1.0/shares/u!<b64>/root/content` | ⚠️ **Plausible for consumer OneDrive; unproven** | Against a *business* share it returned `308 "User migrated"` — this endpoint serves **consumer** OneDrive only. Against a malformed argument it returned `400 {"code":"invalidRequest","message":"Bad Argument"}` — **not** `401` — with **`Access-Control-Allow-Origin`** reflecting the caller's origin, i.e. it rejected the *argument*, not the *absence of a token*. Suggestive that anonymous consumer links resolve here, but **not tested with a real `1drv.ms` link.** Also a legacy endpoint Microsoft has been winding down. |
| **Dropbox** — `dl.dropboxusercontent.com` | ✅ YES | `Access-Control-Allow-Origin: *` plus a long `Access-Control-Expose-Headers` list including `Content-Length` and `Content-Disposition`. |
| **Dropbox** — `www.dropbox.com/…?dl=1` | ❌ **NO — the redirect strips CORS** | `www.dropbox.com` sends no ACAO; only the final CDN hop does. [msbit/dropbox-cors-redirect](https://github.com/msbit/dropbox-cors-redirect/blob/master/README.md) documents exactly this: through the intermediate redirects "there are no `access-control-*` headers being returned; only for the final request is this the case." Corroborated in [Dropbox Community](https://community.dropbox.com/en/discussion/720329/cors-error-on-forced-download-links). **The share UI does not hand out `dl.dropboxusercontent.com` URLs**, so Dropbox is effectively unusable by paste-a-link. |
| **Synology / QNAP NAS** | ⚠️ **Conditional — sysadmin-grade, not one header** | Not probed (no host available). Synology's default share link serves an **HTML download screen, not the file** ([Synology KB](https://kb.synology.com/en-us/DSM/help/FileStation/sharing?version=7)), and DSM sends no ACAO by default. An admin *can* add one — Control Panel → Login Portal → Advanced → Reverse Proxy → Custom Header, since DSM 6.2.1 ([Synology KB](https://kb.synology.com/en-af/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7)) — but you must **also** serve the file as a static asset (Web Station) rather than as a File Station share, and hand-edited nginx config is [overwritten by DSM updates](https://www.synoforum.com/resources/synology-reverse-proxy-under-the-hood.135/). QNAP: structurally the same, **undocumented** in anything I could source. |
| **`raw.githubusercontent.com`** *(control)* | ✅ YES | `Access-Control-Allow-Origin: *`, even on a 404. |
| **GitHub Pages itself** *(control)* | ✅ YES | `Access-Control-Allow-Origin: *` by default. **Netlify does not** — it sends no ACAO unless you add a `_headers` file. "Any static host works" is false; check each one. |

### Reconciliation — why the internet says this doesn't work

**Both positive results above contradict the widely-documented consensus, so treat them with appropriate suspicion and re-test before building.** Here is the honest reconciliation:

- **On Google Drive**, the received wisdom — and a parallel research pass done for this assessment — is that `drive.usercontent.google.com` sends no CORS headers at all. That conclusion comes from probing **invalid file IDs** (which 404 without CORS middleware) or using **HEAD** (which returns an empty HTML body without ACAO). Against a **real, publicly-shared file with a GET**, the header is there: I saw `Access-Control-Allow-Origin: *` with real bytes and working range requests, reproduced on separate attempts. The two findings are compatible: **Drive emits ACAO on successful GETs of public files and on nothing else.**
- **On SharePoint**, Microsoft states plainly that "SharePoint Online does not allow cross-origin fetch requests by default" ([Microsoft Q&A](https://learn.microsoft.com/en-my/answers/questions/5427312/how-to-allow-direct-download-of-sharepoint-files-f)), and Graph's docs say the Shares API "always requires authentication and can't be used to access anonymously shared content without a user context" ([Graph shares-get](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0)). Both are true — **and both are about different endpoints** than the one that works. The Q&A discusses `?download=1` and `download.aspx?SourceUrl=`; the working route is `download.aspx?share=<shareId>`, the anonymous-share redemption endpoint. **Caveat worth stating: this was verified on one tenant. SharePoint Online behaviour varies with tenant configuration, and a client with stricter settings may not get the same result.** Test against each client's tenant before promising it.

The general rule that makes all of this coherent, and worth writing into the code comments: **every hop of a redirect chain must carry ACAO**, and a preflighted request may not follow a cross-origin redirect at all ([MDN — CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [CORSExternalRedirectNotAllowed](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSExternalRedirectNotAllowed)). That single fact is why raw share links fail and why the rewrites work: the rewrite's whole job is to skip the redirect chain and hit the byte-serving endpoint directly.

### One concrete consequence for our code

**`RemoteLoader.fetch()` opens with a HEAD pre-check — and HEAD does not work against Google Drive.** The HEAD returns `text/html`, `Content-Length: 0` and no ACAO, so a browser will block it and `fetch` will throw.

The good news is that this degrades safely *by accident*: the HEAD is wrapped in `try { … } catch { /* fall through to GET */ }`, so the load still succeeds via the GET. The bad news is what silently stops working:
- **The 500 MB size guard never fires for Drive links**, because it only reads `content-length` from the HEAD.
- The user gets no early "this file is too big" warning — they find out when the phone's tab reloads.

So the Drive rule needs a companion change: **skip the HEAD for providers known not to support it, and enforce the size cap from the GET response headers instead** (`Content-Length` is CORS-safelisted, so it is readable on the GET). Small change, but it is the difference between the size guard working and merely appearing to.

### What this means, concretely

1. **Both of your main channels work today, with nothing but a URL rewrite.** Drop an IFC in Drive or SharePoint, set "anyone with the link", send the link. That is exactly the workflow the brief describes, with no infrastructure at all.
2. **The `CLAUDE.md` "no backend" goal is not in tension with this feature — it survives completely intact.** I had expected to write a section weighing signed URLs against serverless functions against third-party hosting. None of that is necessary. This is the single most important thing in the document after headline finding 2.
3. **`dev/plans/phase-remote-loading.md` is now partly obsolete in a good way.** Its Phase 2 assumed SharePoint required an Azure AD app registration and OAuth2/PKCE, because it only considered the Graph `/shares/` route (and correctly noted Graph "supports CORS but requires an OAuth2 access token"). The `_layouts/15/download.aspx?share=` route sidesteps that entirely for *anonymous* share links. **That plan's SharePoint OAuth section should be demoted to "only for links that aren't anonymously shared."**
4. **A NAS remains the best privacy answer** and the least work per file, at the cost of one reverse-proxy header and keeping the NAS reachable.

### The one caveat on the SharePoint route

**`_layouts/15/download.aspx` is an internal SharePoint endpoint, not a documented public API.** It works today and is widely used, but Microsoft has made no compatibility commitment about it. The same is true of Google's `confirm=t` parameter — an undocumented query flag that tools like `gdown` depend on, on an endpoint Google has changed before.

The engineering consequence is a design constraint, not a reason to avoid them: **the rewrite must fail loudly and legibly if it stops working.** If `download.aspx` starts returning an HTML error page, the user should see *"SharePoint didn't return the file — the link may have expired, or Microsoft may have changed this endpoint"*, not the current *"This doesn't appear to be an IFC file."* And the "download it and open it from your device" fallback must stay permanently available, because it is the only route that depends on nothing.

### The gap in our code — and how small it is

**Verified by running the shipped `normalizeUrl` rules against real share-link shapes:** none of the four providers the user named is handled.

| Share link shape | Today |
|---|---|
| `https://drive.google.com/file/d/<ID>/view?usp=sharing` | **no rule — passes through unchanged** |
| `https://<tenant>.sharepoint.com/:u:/g/personal/…?e=…` | **no rule** |
| `https://1drv.ms/u/s!…` | **no rule** |
| `https://nas.example.com/d/f/<token>` | **no rule** (correct — a NAS needs no rewrite) |
| `https://www.dropbox.com/scl/fi/<id>/m.ifc?rlkey=…&dl=0` | **no rule** — see below |

`src/loader/urlNormalizer.ts` has exactly three rules: GitHub, GitLab, Dropbox. And **the Dropbox rule doesn't match modern Dropbox links**: its pattern is `/^(https:\/\/www\.dropbox\.com\/.+)(\?dl=0)$/i`, which requires a literal `?dl=0` at the very end. Current Dropbox share links look like `…?rlkey=<key>&st=<…>&dl=0`, where `dl=0` is `&`-prefixed and often not last. The tests in `tests/url-normalizer.test.ts` only cover the legacy `/s/<id>/<name>?dl=0` shape, so this passes CI. *(Verified by executing the rules; the consequence for a live Dropbox link is unverified.)*

**So the highest-value change in this entire assessment is about twenty lines of `urlNormalizer.ts` — two rules, in exactly the shape the three existing ones already take:**

```
# Google Drive
https://drive.google.com/file/d/<ID>/…
  →  https://drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t

# SharePoint / OneDrive for Business
https://<tenant>.sharepoint.com/:u:/g/personal/<user>/<shareId>?e=<anything>
  →  https://<tenant>.sharepoint.com/personal/<user>/_layouts/15/download.aspx?share=<shareId>
```

The SharePoint rule preserves the host, drops the `:u:/g/` segment, drops the `?e=` token, and moves the share id into `?share=`.

Most of what's downstream already works: `Content-Length` is CORS-safelisted so the progress bar works; SharePoint additionally exposes `Accept-Ranges` and `Content-Length` explicitly (verified); the `ISO-10303-21` header validation works. The one thing that needs adjusting alongside the rules is the **HEAD pre-check and the size cap** described above.

Two smaller Drive-specific gotchas to handle in the rule itself:
- **`resourcekey`.** Files uploaded before 2017 and link-shared may require a `resourcekey` parameter since Google's [September 2021 security update](https://9to5google.com/2021/07/28/google-drive-security-update/) (see also [googledrive #371](https://github.com/tidyverse/googledrive/issues/371)). The rewrite must carry it through from the pasted URL.
- **Download quota.** Heavily-shared Drive files hit a ~24-hour "Sorry, you can't view or download this file at this time" lockout. It is real and widely reported; **Google publishes no numeric threshold**, so treat it as an availability risk on a popular model, not something you can design around.

**This is a ready-to-build change with the evidence already gathered — it is deliberately not implemented here, so the measurement-tooling track stays clear.**

Two small follow-ons worth knowing:
- **`Content-Disposition` is not in Drive's `Access-Control-Expose-Headers`**, so JS cannot read the real filename. `RemoteLoader.extractFilename` falls back to the URL path — which for Drive is literally `download`. Models would be named "download" until we either read a name from the IFC header or let the user rename.
- **The error taxonomy has no "provider returned a web page" case.** A Drive link without `confirm=t` returns HTML, which trips the `ISO-10303-21` check and surfaces as *"This doesn't appear to be an IFC file"* — technically true, actively misleading.

### On "verified", honestly (D2)

With plain share links, "verified" means **an unguessable URL**, not per-recipient access control.

State this plainly to yourselves before you state it to a client: **the rewritten URL is exactly as sensitive as the share link it came from.** Anyone holding either can download the file. The rewrite grants no access the share link didn't already grant, and revokes none — it just points at the endpoint that returns bytes instead of the one that returns a web page. Revocation still happens where it always did: in Drive's or SharePoint's own sharing UI.

That is a real, named pattern with real, named risks. The W3C TAG finding [**Good Practices for Capability URLs**](https://www.w3.org/TR/capability-urls/) documents them: leakage via browser history, `Referer` headers to third-party links, third-party scripts reading `location.href`, email and ISP logging, URL shorteners, and search-engine indexing. Critically, **once leaked you cannot tell legitimate from illegitimate use**, and revoking revokes it for everyone.

Their recommended mitigations map onto what Drive already gives you: HTTPS only, long random identifiers (Drive IDs qualify), expiry where the plan supports it, and an authenticated channel (Drive's own sharing UI) to revoke. Our part is to avoid leaking: **don't put the model URL in a page that loads third-party scripts, and be careful that the analytics integration never sees it.** That is a concrete review item, not a theoretical one — the viewer currently runs Google Analytics.

The alternative, per-recipient access control, means the recipient signs in to Google or Microsoft and the viewer holds an OAuth client. That is a sign-in wall in front of a client who wants to look at their building. Choose (a) knowingly.

### If a provider won't serve CORS — the fallback ladder (D9)

Ranked by how well each preserves *"client sends a link, client opens it on a phone, no accounts, no threshold"*:

1. **Use a provider that works.** Google Drive and SharePoint/OneDrive-for-Business, both proven. This is the whole answer most of the time.
2. **"Download it, then open it"** — the universal escape hatch. A plain link hands the file to the OS (navigation is exempt from CORS), and the user re-selects it with the existing file picker. **This works for every provider, on every device, with zero configuration and zero infrastructure, forever.** It costs two extra taps and is the only path that depends on nothing. It already works today. Keep it permanently and make it the visible fallback whenever a rewrite fails.
3. **A NAS**, if the client's IT will do the work. Best privacy — bytes never leave infrastructure they control — but as the table above shows this is a sysadmin task (reverse-proxy header **plus** serving the file statically rather than as a File Station share), not a checkbox.
4. **Re-host that one file on a CORS-friendly static host.** GitHub Pages and `raw.githubusercontent.com` send `ACAO: *` out of the box; **Netlify does not** without a `_headers` file; S3/R2/B2/Azure all need an explicit CORS policy ([R2](https://developers.cloudflare.com/r2/buckets/cors/), [B2 denies preflight by default](https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules), [Azure](https://learn.microsoft.com/en-us/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services)). Note carefully: **a static file host is not an auth backend** — no server to run, no secret to hold — so this does not break the no-backend goal. It does make us a GDPR processor for anything personal in the IFC; see below.
5. **Google Drive API v3 + an API key**, as insurance if `confirm=t` ever breaks. `www.googleapis.com/drive/v3/files/<id>?alt=media&key=<KEY>` is unambiguously CORS-enabled — a live preflight returns `ACAO` echoing the caller's origin and explicitly allows `range` and `authorization` — and an API key alone suffices for "anyone with the link" files ([Google](https://support.google.com/cloud/answer/13807380)). Cost: a GCP project and a referrer-restricted key. No OAuth, no consent screen. Worth keeping in the back pocket precisely because `confirm=t` is undocumented.
6. **OAuth picker** (Google Picker with the non-sensitive `drive.file` scope; OneDrive File Picker; MS Graph via `@microsoft.graph.downloadUrl` — never `/content`, whose 302 Microsoft [documents as breaking CORS](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/working-with-cors?view=odsp-graph-online)). Only needed for links that are *not* anonymously shared. Changes the UX from "paste a link" to "sign in and browse" — the exact threshold this feature exists to remove.
7. **A CORS proxy — recommended against, and now unnecessary.** Every byte of a client's proprietary model would transit a third party; for project work that is likely disqualifying on its own. It isn't reliable either: I probed the two most-cited public proxies live and **both failed** — `corsproxy.io` returned `HTTP 403` (its free tier is development-only; production starts at $5/mo) and `api.allorigins.win` returned `HTTP 522`. Self-hosting one via a Cloudflare Worker removes the third-party problem but re-introduces exactly the backend this architecture avoids, and would proxy hundreds of megabytes per view. **With the two rewrites working, there is no remaining reason to consider this.**

**There is no way around CORS.** A browser can *navigate* to a cross-origin file or download it via `<a download>`, but JavaScript cannot read the bytes without the server's permission: with `mode: "no-cors"` the response is opaque, "meaning that its headers and body are not available to JavaScript" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Request/mode)). No client-side trick exists — which is exactly why fallback 2 above matters.

### A brief GDPR note

Today we hold nothing — files never leave the user's device, which is the claim `index.html` makes in its meta description. Using **client-owned** share links keeps that true: we are not a controller or processor, because the bytes go from the client's Drive to the client's browser and we never store them.

That changes only if we take fallback 4 and re-host files ourselves. Then we become a **processor** for whatever personal data sits in IFC property sets (names, contacts, responsible-party fields are common), triggering Article 28 obligations — a data processing agreement, defined retention and deletion, breach notification ([GDPR EU](https://www.gdpreu.org/the-regulation/key-concepts/data-controllers-and-processors/)). This is general principles, **not legal advice**. The practical guidance: keep re-hosting for the occasional stubborn file, never as the default channel.

---

## Headline finding 2 — the models may not fit on the phone

The other hard constraint, and the one no amount of CSS fixes.

- **Our own numbers.** `dev/profiling.md`, quoted in the roadmap: RIB.ifc is 773 meshes and +88 MB of heap; **Snowdon Towers + RIB together are 18,027 meshes and ~340 MB total heap**. The roadmap also records that **a 191 MB IFC takes ~60 s to load**.
- **iOS per-tab ceilings.** No Apple-published figure exists, but a measured third-party breakdown puts it at roughly **200–250 MB on an iPhone 6s/SE, ~350–400 MB on an 11/12, ~400–450 MB on a 13/14, and only ~1 GB+ from the 15 onward** ([Catch Metrics — RAM internals in WebKit](https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit)). WebKit's response is a cliff, not degradation: at 100 % it deletes all JS state and reloads the page — the familiar *"This webpage was reloaded because it was using significant memory."* Apple's forums confirm there is no documented way to raise it ([Apple Developer Forums](https://developer.apple.com/forums/thread/766309)).
- **Put together:** our ~340 MB federated-scene figure is at or over the ceiling for every iPhone before the 15, before counting WASM heap, GPU buffers and the IndexedDB cache.
- **web-ifc breaks at scale, in the open.** [`engine_web-ifc` #538](https://github.com/ThatOpen/engine_web-ifc/issues/538) — a 300 000-component model aborts, with the reporter placing the empirical threshold between 100 000 and 150 000 components. [`#1999`](https://github.com/ThatOpen/engine_web-ifc/issues/1999) — `memory access out of bounds` on 400 MB+ Revit-exported IFC4 MEP models, **specifically during geometry extraction**. [`#1774`](https://github.com/ThatOpen/engine_web-ifc/issues/1774) — the same during IFC→fragments conversion.
- **WASM fails earlier than the spec suggests on iOS.** The wasm32 ceiling is 4 GB, and browsers allow 2 GB by default ([V8](https://v8.dev/blog/4gb-wasm-memory)), but reserving a large `WebAssembly.Memory` *maximum* can fail outright on iOS Safari even when usage is small — Godot hit this and fixed it by dropping their max to 256 MB ([godotengine/godot #70621](https://github.com/godotengine/godot/issues/70621)).
- **Competitors say so publicly.** BIMcollab's own system requirements state that "large models require more memory than most mobile phones can provide," which "could cause large models to load slowly or even cause the application to crash" ([BIMcollab](https://helpcenter.bimcollab.com/en/articles/340227-system-requirements-bimcollab)).
- **Safari misreports its own limits.** It advertises generous WebGL limits via `getParameter`, but allocating up to them "can cause your page to crash" ([webgl2fundamentals](https://webgl2fundamentals.org/webgl/lessons/webgl-cross-platform-issues.html)). You cannot feature-detect a safe budget.
- **Draw calls, not triangles, are the mobile killer.** Community rules of thumb (blogs, not vendor specs): under ~500 000 triangles and **under ~50 draw calls** on mobile ([threejsroadmap](https://threejsroadmap.com/blog/draw-calls-the-silent-killer), [low-poly.com](https://low-poly.com/blog/polygon-budgets-by-platform-2026)). We are at 18 027 meshes for two models — that is 18 027 draw calls.

**Corollary worth stating plainly: every queued performance card in the roadmap is now also a mobile card.** `instanced-meshes`, `render-perf-orbit-lag` and `frustum-cull-audit` move from "nice on desktop" to "necessary on a tablet."

---

## What the field does

### Dalux — what's actually behind the reputation

**Documented:**
- Claims **"1 million+ objects visible at the same time on desktop and mobile devices"** ([2D and 3D viewer functionality](https://www.dalux.com/solutions/2d-and-3d-viewer-functionality/)).
- **Models are processed server-side before viewing** — you upload IFC (or Revit/Navisworks/Tekla/ArchiCAD via free plugins) and Dalux "will process and import the data from the IFC model" ([Upload IFC model files](https://support.dalux.com/hc/en-us/articles/360003051733-Upload-IFC-model-files-and-2D-drawings)).
- **The mobile client is a native app** — iOS 16+/Android 11+, with device storage requirements and offline downloads ([App Store](https://apps.apple.com/us/app/dalux/id504561520)).
- **Offline is opt-in, not automatic** ([Dalux Mobile](https://support.dalux.com/hc/en-us/articles/18358635138204-Dalux-Mobile)). Capterra reviewers flag exactly this as friction, and one thread reports data loss at the edge of connectivity ([Capterra](https://www.capterra.com/p/154695/Dalux-Field/reviews/)).
- **A 2D-drawing/3D split view is a first-class navigation mode** — "3D", "Drawing", and "Split", where you move around in 3D by touching the 2D plan. QR codes jump straight to a zone, room or object.
- Documented touch gestures exist, but **only for the 2D plan navigator**: pinch to zoom, one-finger drag to pan ([Navigate in Locations on mobile](https://support.dalux.com/hc/en-us/articles/360010386193-Navigate-in-Locations-on-mobile)).

**Not documented anywhere, despite searching hard:** the mobile geometry format, the streaming or tiling scheme, any LOD system, any numeric size ceiling, the full 3D gesture map, or any independent benchmark. Architosh confirms a full federated hotel model running live on iPads but explains nothing about how ([Architosh](https://architosh.com/2025/01/tooltalk-looking-at-dalux-the-worlds-fastest-bim-model-viewer/)).

**And the finding that should reassure you: Dalux does not have anonymous share links either.** Every documented path requires a Dalux identity — a project invite (which creates the account via an "Accept invitation" email) or free self-signup for BIM Viewer / Field Basic ([login docs](https://support.dalux.com/hc/en-us/articles/10923308125084-How-to-create-a-profile-and-log-in-to-Dalux), [BIM Viewer signup](https://www.dalux.com/sign-up-free-bim-viewer/)). What Dalux sells is *frictionless signup plus unlimited free viewer seats*, not zero-account access.

**Our `?url=` + a Drive share link is genuinely lower-friction than Dalux.** No account, no signup, no install. That is a real differentiator we have already shipped and are not using.

**Three lessons, none of them a trick we can copy:**
1. **They convert server-side.** The phone never parses IFC. That is the structural answer to headline finding 2 — and D4 is the cheap version of it.
2. **Their moat is the free tier, not the link.** Ours is better on that axis; say so.
3. **2D plan ↔ 3D linkage is the navigation idea worth stealing.** Orbiting a building on a 6-inch screen is hard; tapping a floor plan to fly there is not. Highest-value *new* touch feature, and we don't have it.

### The rest of the field, compressed

| Product | Mobile client | Server-side preprocessing | No-account link |
|---|---|---|---|
| **Autodesk ACC / APS** | Native app + web viewer | **Yes — SVF/SVF2**, documented, via the Model Derivative API; SVF2 shares meshes across viewables to shrink and speed loading ([SVF2](https://aps.autodesk.com/blog/update-svf2-ga-new-streaming-web-format-forge-viewer-now-production-ready), [Model Derivative](https://aps.autodesk.com/en/docs/model-derivative/v2)) | Not found. Free Autodesk Viewer caps uploads at **1 GB/file** ([source](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/File-size-limits-of-Autodesk-Viewer.html)) |
| **BIMcollab** | No app; browser **WebViewer** | Streaming — "downloads only what you are looking at" ([source](https://www.bimcollab.com/en/products/bimcollab-twin/model-webviewer/)) | Not found. Publishes **explicit device requirements and a crash warning** — a good model for our own honesty |
| **Trimble Connect** | Native iOS + Android + browser | An import/"assimilation" step; format not named | **Yes** — "Any users with the link" ([Sharing Views](https://help.trimble.com/en/trimble-connect/trimble-connect/connect-for-browser/views/sharing-views)) |
| **StreamBIM** (Rendra, NO) | Native, tablet-first | Yes; format not published | Not found. Generates **2D navigation maps from the model** — same plan↔3D idea |
| **Revizto** | **Two apps** — *Revizto Site* (phone) and *Revizto V5* (tablet, near-desktop parity) ([source](https://help.revizto.com/hc/en-us/articles/13338537854479-Revizto-mobile-apps)) | Not documented | Public dashboards yes; model viewer unconfirmed |
| **Speckle** | Web viewer, mobile supported | Own format | **Yes**, documented. States **"Open IFC files of up to 1 GB in Speckle's web viewer"** ([source](https://speckle.systems/integrations/ifc/)) |
| **Catenda Hub** | Web, "cross-device" | Not documented | Could not find. Auto-generates 2D floor plans — again plan↔3D |
| **usBIM (ACCA)** | Web; claims PC/Mac/tablet/phone ([source](https://www.accasoftware.com/en/ifc-viewer-on-line)) | Not documented | Unconfirmed |
| **Solibri Anywhere** | None found — now a **legacy, no-longer-developed product** ([source](https://help.solibri.com/hc/en-us/articles/39899281429911-Solibri-Anywhere-Availability-and-Next-Steps)) | — | — |

**The pattern: every product that succeeds on mobile converts server-side, and most ship a native app.** We can afford neither. D4 gets the first benefit without the cost.

**Revizto's two-app split is the strongest argument for D5:** they didn't shrink the desktop UI for phones, they built a different one.

### Candidate compact formats, if we don't build our own

| | **That Open "Fragments"** | **xeokit XKT** |
|---|---|---|
| Licence | **MIT** ([LICENSE](https://github.com/ThatOpen/engine_components/blob/main/LICENSE.md)) | **AGPLv3 or paid commercial** ([npm](https://www.npmjs.com/package/@xeokit/xeokit-sdk)) |
| Conversion | **In-browser**, Web Worker ([IfcLoader](https://docs.thatopen.com/Tutorials/Components/Core/IfcLoader)) | **Node.js CLI only** (`convert2xkt`) ([source](https://xeokit.io/blog/converting-models-to-xkt-with-convert2xkt/)) |
| Published ratios | "Over 10× faster" to load than re-parsing IFC ([FragmentsManager](https://docs.thatopen.com/Tutorials/Components/Core/FragmentsManager)) | **45 MB IFC → 1.8 MB XKT (25.5×)**, loading in 3–4 s; other runs at 21.6× and 16.7× |
| Catch | Same web-ifc underneath — [`#1774`](https://github.com/ThatOpen/engine_web-ifc/issues/1774) is an out-of-bounds error *during* conversion | AGPL is a real problem for a commercial deliverable; the best pipeline (`ifc2gltfcxconverter`) is closed-source |

**Do not adopt xeokit.** Best published numbers, worst licence fit. Fragments is the MIT fallback — but note its conversion runs on the same web-ifc that produces the abort reports above, so it solves the *repeat*-load problem, not the *big model* problem.

### Touch conventions — what people expect

| Product | One finger | Two fingers | Extra |
|---|---|---|---|
| **three.js `OrbitControls`** (ours) | Rotate | Dolly + pan (`TOUCH.DOLLY_PAN`) | [docs](https://threejs.org/docs/pages/OrbitControls.html) |
| **three.js `MapControls`** | Pan | Dolly + rotate | [docs](https://threejs.org/docs/pages/MapControls.html) |
| **BIMx** (closest BIM analogue) | Orbit / turn-in-place | Pan | Pinch zoom; **double-tap fits the building**; auto-switches walk vs. orbit by whether the camera is inside the model ([Graphisoft](https://community.graphisoft.com/t5/BIMx/Navigation-in-BIMx/ta-p/303642)) |
| **Sketchfab** | Rotate | Pinch zoom | Help panel + **camera-reset button** ([source](https://sketchfab.com/blogs/community/photogrammetry-and-3d-model-viewer-advances-gesture-based-interactives)) |
| **Google Maps** | **Pan** | Tilt / rotate / pinch | Double-tap zooms in ([Maps SDK](https://developers.google.com/maps/documentation/android-sdk/controls)) |
| **`<model-viewer>`** | Orbit | Pan | `touch-action` attribute (default `pan-y`) decides whether the page still scrolls ([#3622](https://github.com/google/model-viewer/issues/3622)) |
| **AR Quick Look** | Drag to place | Rotate | Pinch scales; **double-tap resets** ([Kodeco](https://www.kodeco.com/books/apple-augmented-reality-by-tutorials/v1.0/chapters/2-ar-quick-look)) |

**The split is by category, not taste:** "inspect an object" viewers use one-finger orbit; "navigate a space" products use one-finger pan. An IFC viewer is the former. **Our mapping is already correct** — keep it (D6).

Two borrowed ideas, both nearly free: **double-tap to fit** (BIMx, AR Quick Look) and **a visible camera-reset button** (Sketchfab). Getting lost is far easier with a finger than a mouse.

One instructive negative: the Autodesk Forge viewer's *default* pinch does unconstrained orbit with no zoom, which Autodesk's own ecosystem calls the mode that "makes the least sense" for BIM, expecting every developer to override it ([Kean Walmsley](https://www.keanw.com/2017/04/fixing-pinch-zoom-in-forge-viewer-applications.html)). And a landmine already flagged in our dependency family: [`engine_components` #531](https://github.com/ThatOpen/engine_components/issues/531) — pinch-to-zoom in orthographic mode doesn't zoom on *any* mobile browser, it front-clips the model.

### Touch target sizes

- **WCAG 2.5.8 (AA, WCAG 2.2): 24 × 24 CSS px minimum** ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)) — the accessibility floor.
- **WCAG 2.5.5 (AAA): 44 × 44** ([CSS-Tricks](https://css-tricks.com/looking-at-wcag-2-5-5-for-better-target-sizes/)).
- **Apple HIG: 44 pt. Material: 48 dp.** Platform convention.

Our toolbar buttons are **36 × 36** and context-menu rows roughly **28 px**. Legal, below every platform convention.

---

## Gap analysis — what the code actually does today

Everything below was verified by reading `origin/main` @ `d517f0c`, running the shipped code, or probing live endpoints. **Nothing was run on a physical phone or tablet.** Items I could not confirm are marked **unverified**.

### Layout

| Finding | Evidence |
|---|---|
| **`src/styles.css` on `main` contains zero `@media` queries** in 1461 lines. There is no responsive layout at all. | `git show origin/main:src/styles.css \| grep -c "@media"` → `0`. (An in-flight cookie-banner branch adds the first one, for the consent dialog only.) |
| Every panel is anchored with fixed pixel offsets and fixed widths | Model tree `left:12 top:60 width:240`; inspector `left:12 bottom:48 width:280`; basket `left:12 top:320 width:240`; toolbar centred `top:12`; help button `top:12 left:12`; memory toggle `top:12 right:12`; contextual tray `bottom:40 right:12`; footer `position:fixed bottom:0` |
| **On a 390 × 844 iPhone viewport these collide.** The inspector alone is 280 px of 390 (72 %). The basket sits at `top:320`; the inspector's top edge lands near `y≈374` — they overlap. Tree, inspector and basket all stack in the same left gutter. | Arithmetic from the CSS above |
| The landing screen's URL input is likely **clipped off-screen** on a phone | `.url-input-container { width:100%; max-width:420px }` inside `#upload-prompt { padding: 40px 60px }` → intrinsic width ≈ 540 px, wider than a 390 px viewport, and `html, body { overflow: hidden }` clips rather than scrolls. **Expected from the CSS; unverified on a device.** |
| No `viewport-fit=cover`, no `theme-color`, no `apple-mobile-web-app-*`, no manifest | `index.html` — only `<meta name="viewport" content="width=device-width, initial-scale=1.0">` |
| **No device or pointer-capability detection anywhere** | `grep -rn "matchMedia\|maxTouchPoints\|userAgent\|coarse" src/` → no matches |

### Touch and gestures — better than expected

The touch story is genuinely half-built and the existing work is sound.

| Finding | Evidence |
|---|---|
| **One-finger orbit is hand-rolled and pivot-aware.** `enableRotate = false` closes three's own rotate on every path (mouse, modifier-drag, touch), and `Viewer.onPointerDown/Move` implements one-finger rotate about the same resolved pivot as the mouse. | `Viewer.ts:141`, `:426–517` |
| **Pinch-to-zoom is hand-rolled and aimed at the finger midpoint.** `enableZoom = false` kills three's wheel *and* pinch together, so `updatePinch()` reimplements it. | `Viewer.ts:146`, `:556–573` |
| **Two-finger drag pans, via OrbitControls.** With `touches.TWO = DOLLY_PAN` (three's default, unchanged) and `enableZoom` off, `_handleTouchMoveDollyPan` runs only the pan half. Correct and intentional. | `OrbitControls.js:1430–1436`, `:1827` |
| **Three or more fingers do nothing.** `onTouchStart`'s `default:` sets `state = NONE`. | `OrbitControls.js:1793`, `:1858` |
| **`touch-action: none` is applied — but by OrbitControls, not us.** `connect()` sets `domElement.style.touchAction = 'none'`; `disconnect()` resets it. Browser scroll/pinch over the canvas *is* suppressed today — via an implicit dependency on a library internal, not a decision of ours. | `OrbitControls.js:508`, `:527` |
| **The click/drag threshold is mouse-calibrated: `CLICK_THRESHOLD = 3` CSS px, no `pointerType` branch.** A finger routinely moves more than 3 px during a tap, so taps are often misread as drags and fail to select. | `SelectionManager.ts:72`, `:615`; same constant in `MeasurementTool.ts:45` |
| **Raycasting has zero tolerance** — one infinitely thin ray, no pick radius. Tapping a pipe with a fingertip is pixel-exact. | `utils/raycast.ts` |
| **`updatePinch()` runs a full-scene raycast on every pinch-move event.** `pivotFor()` → `raycastVisible()` → `scene.traverseVisible` collecting *every* mesh, then `intersectObjects`. At 18 027 meshes that is a per-frame full-scene traversal during a gesture, on the weakest hardware we target. | `Viewer.ts:556–573` → `:394–414` → `utils/raycast.ts` |

### Unreachable without a mouse or keyboard

| Feature | Why |
|---|---|
| **Marquee selection** | Requires `e.altKey` — `MarqueeSelector.ts:150` |
| **All keyboard shortcuts** — `C`, `M`, `V`, `F`, `Esc`, `?`, `Ctrl+Z`/`Ctrl+Y` | `App.ts:353–411`, `HistoryShortcuts.ts` |
| **Every tooltip** | Labels live in `title=`, which never appears on touch. Buttons are bare emoji (`✂ 📏 ⊡ ◻ ↺`) — unlabelled on a phone |
| **Right-click context menu** | Bound to `contextmenu` (`App.ts:529`). Android Chrome fires this on long-press; **iOS Safari behaviour over a canvas is unverified.** Hide/Isolate/Transparent may be unreachable on iPhone |

### The onboarding path a client would actually experience

| Finding | Evidence |
|---|---|
| **`?url=` deep-linking works.** Remote loading (`RemoteLoader`, `urlNormalizer`, bearer-token retry) is **shipped**, with a 500 MB cap and IFC-header validation. `phase-remote-loading.md` Phases 1 and 1.5 are done. | `main.ts`, `loader/RemoteLoader.ts` |
| **The confirmation is a raw `window.confirm()`** showing the full URL. On a phone that is a system dialog with a naked URL — it reads as a warning, not a welcome. | `main.ts:16–19` |
| **A failed remote load shows the user nothing at all.** `handleRemoteLoad` calls `showUploadPrompt(false)`, setting `#upload-prompt` to `display:none`. On failure it writes the message into `urlInput`, mounted *inside* `#upload-prompt`. `showUploadPrompt(true)` is called exactly once, at startup. **Verified by reading; not reproduced in a browser.** | `App.ts:1182–1224`, `:551`; `index.html` |
| **The parse stage has no progress UI.** `LoadingOverlay.ts` exists, is fully written, and is imported by nothing. Download progress goes to a model-tree row; the ~60 s parse shows a plain text status line. | `grep -rn "LoadingOverlay" src/` → only its own definition |
| **No WebGL availability check.** `new THREE.WebGLRenderer()` throws if WebGL2 is missing and `main.ts` doesn't guard `new App(canvas)`. Unsupported devices get a blank page. three r183 is WebGL2-only; iOS has had WebGL2 since Safari 15 ([Khronos](https://www.khronos.org/blog/webgl-2-achieves-pervasive-support-from-all-major-web-browsers)), so it's an edge case — but a silent one | `main.ts`, `Viewer.ts:110` |
| **Analytics consent is a full-screen modal over a dimmed backdrop** on the in-flight branch (a corner banner on `main`). A client opening a share link meets a consent dialog before they see anything | `styles.css` `.cookie-banner-open { inset: 0; z-index: 3000 }` |
| **Session memory defaults ON**, so a visitor's model is written to IndexedDB unasked | `SessionStore.ts:96` — `if (val === null) return true` |

### Rendering budget

| Finding | Evidence |
|---|---|
| **`setPixelRatio(window.devicePixelRatio)` is unclamped.** On a DPR-3 phone that renders **9× the pixels** of a DPR-1 screen. Standard practice is `Math.min(devicePixelRatio, 2)`. Almost certainly the cheapest frame-rate win available | `Viewer.ts:112` |
| **`antialias: true` unconditionally.** MSAA is expensive on mobile GPUs | `Viewer.ts:110` |
| **Canvas sized from `window.innerWidth/innerHeight`**, not `visualViewport`, not a `ResizeObserver`. On iOS the URL bar collapsing changes `innerHeight` mid-gesture, firing `resize` and reallocating the framebuffer | `Viewer.ts:111`, `:375–380` |
| **Bundle:** main JS 4.02 MB raw / **496 kB gzip**, worker chunk 3.56 MB, CSS 19.7 kB / 4.1 kB gzip, plus `web-ifc.wasm` at **1.3 MB**. Vite already warns about chunk size | `npm run build` on this branch |
| The parse does **two** `StreamAllMeshes` passes — one to count products for the progress total, one to extract geometry. The comment says the count pass is "cheap: no GetGeometry", which is plausible, but on mobile it is **worth profiling** rather than assuming. A lead, **not** a claim | `parser/ifcWorker.ts:174–204` |

### The asset that changes the economics

**`src/services/GeometryCache.ts` already contains a working IFC→compact-binary codec.** `serializeMeshes` / `deserializeMeshes` turn `ParsedMesh[]` into a single `ArrayBuffer` of typed arrays and back, with SHA-256 content hashing and LRU eviction at a 500 MB cap. Today it only makes session restore instant.

That is the hard half of a publishable mobile format, already written and already tested (`tests/geometry-cache.test.ts`). D4 option (c) is mostly plumbing on top: write the buffer to a file instead of IndexedDB, and teach the loader to accept one. **No new dependency, no server, no licence question, and the no-backend goal stays intact.**

---

## Proposal, in phases

### Phase 0 — Measure. Half a day. Before anything else.

No code. Take an iPad, a recent iPhone, an older iPhone and one Android phone, open the live site, and load three models: small, typical, and the 191 MB one. Record for each: does it load, how long, does the tab reload, how the frame rate feels, what breaks in the UI.

**Deliverable:** a table appended to `dev/profiling.md`. **This decides whether phase 3 is worth building.**

### Phase 1 — Make the link work, and make it work on a tablet. No backend, no money. `M`

Two strands. The first is astonishingly cheap for what it unlocks.

**1a — Share links (roughly a day, and the highest-value work in this document):**
1. **Add a Google Drive rewrite rule** to `urlNormalizer.ts` → `drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`, carrying `resourcekey` through when present.
2. **Add a SharePoint / OneDrive-for-Business rewrite rule** → `<tenant>.sharepoint.com/personal/<user>/_layouts/15/download.aspx?share=<shareId>`.
3. **Skip the HEAD pre-check for providers that don't support it, and enforce the 500 MB cap from the GET response instead.** Without this the size guard silently stops protecting Drive links.
4. **Make rewrites fail loudly.** Both endpoints are undocumented and can change. Add a "the provider returned a web page, not a file" error case so a broken rewrite says something true instead of *"This doesn't appear to be an IFC file."*
5. **Fix the invisible-error bug** — a failed remote load currently shows the user nothing at all.
6. **Make "download it and open it" a visible, offered fallback**, not just a thing that happens to work. It is the only path that depends on nothing.
7. **Fix or retire the Dropbox rule.** It doesn't match modern link shapes, and even when it does it rewrites to a host that strips CORS on the redirect. Retiring it honestly is better than a rule that appears to work.
8. **Name models from the IFC header**, not the URL path — Drive URLs carry no filename and `Content-Disposition` isn't CORS-exposed.
9. **Test each new rule against a real link from a real client tenant** before promising the capability. SharePoint behaviour varies by tenant configuration.

**1b — Tablet UX**, in rough order of value per hour:
1. **Clamp the pixel ratio** to `Math.min(devicePixelRatio, 2)`; drop `antialias` on coarse-pointer devices. *(One line each.)*
2. **Raise the click/drag threshold for touch** — `pointerType === 'touch' ? 10 : 3`. *(D7.)*
3. **A responsive layout.** Real breakpoints. On narrow screens the tree and inspector become bottom sheets, not floating gutter panels; the toolbar becomes a bottom bar; buttons go to 44 px; the URL input stops overflowing.
4. **Presentation mode** (D5) — on coarse-pointer/small screens hide marquee, measurement, clipping placement, the basket and the inspector's deep tables behind one "Tools" affordance. Give the inspector a short summary card instead of a property tree.
5. **Touch affordances**: double-tap to fit; a visible reset-view button; visible labels instead of `title=` tooltips.
6. **A touch section in the help overlay**, and **fix the stale entry** — it lists "Right drag → Pan" while `Viewer.ts:154` sets `mouseButtons.RIGHT = null`.
7. **Set `touch-action: none` on the canvas in our own CSS** so we stop depending on an OrbitControls internal. Add `overscroll-behavior-y: contain` ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)); consider suppressing the iOS edge-swipe-back on drags starting near the edge ([Pqina](https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/)).
8. **Hoist the pinch raycast out of the move handler** — resolve the pivot once when the second finger lands.
9. **Wire up `LoadingOverlay`** (already written).
10. **Deep-link polish**: replace `window.confirm()` with an in-page card showing model name and domain; defer the analytics prompt until after first render.
11. **Audit that the model URL never reaches Google Analytics** — a capability URL in an analytics payload is a leak.

### Phase 2 — Make the link feel like a product. Still no backend. `S`

- **QR code generation** — already specified in `phase-remote-loading.md`. This is the actual "get an IFC viewer on their phone" moment: point a phone camera at a screen or a drawing, and the building appears.
- **Embed mode** (`?embed=true`) — also already specified. Puts a live model in a client's SharePoint page.
- **PWA manifest + icons** (D10b) so the viewer installs to a home screen. Low effort, disproportionate polish.
- **`?project=` multi-model links**, per the existing plan — this delivers "one *or more* IFC models" from the brief.

### Phase 3 — Make big models openable on a phone. `L` — **only if phase 0 says they aren't**

Build **`.ifcview`**, a published phone-ready model file, on top of the existing `GeometryCache` codec (D4c).

- **Publish** — a desktop-only "Publish for mobile" action: take the parsed `ParsedMesh[]`, run the existing `serializeMeshes`, download an `.ifcview`. Optionally a properties sidecar so the inspector still works.
- **Consume** — `FileLoader` and `RemoteLoader` accept `.ifcview` and hydrate the scene via `deserializeMeshes`. **web-ifc never runs on the phone**, which removes the WASM ceiling, the ~60 s parse, and [`#538`](https://github.com/ThatOpen/engine_web-ifc/issues/538) / [`#1999`](https://github.com/ThatOpen/engine_web-ifc/issues/1999) from the mobile path entirely.
- **Then shrink what's in it** — `instanced-meshes` (already queued) pays off twice here, and quantisation plus [Draco](https://github.com/google/draco) or [`EXT_meshopt_compression`](https://github.com/KhronosGroup/glTF/pull/1702) become worth considering. xeokit publishes 16–25× IFC→XKT ratios; that's the bar.
- **Honest guard rails** — measure the device budget and say plainly when a model is too big. BIMcollab does exactly this, and it beats a silent tab reload.

The conversion happens in *a* browser — just a desktop one. No server, no pipeline, no vendor.

### Phase 4 — OAuth, for links that are *not* anonymously shared. `M` — **probably never**

This was going to be the expensive phase. The `download.aspx?share=` result mostly deletes it.

It survives only for one case: a client whose models are shared to **named people** rather than "anyone with the link". Then you need an Entra app registration, OAuth2/PKCE, and Graph — reading `@microsoft.graph.downloadUrl` rather than `/content`, because Microsoft [documents that `/content`'s 302 breaks CORS for preflighted requests](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/working-with-cors?view=odsp-graph-online). The design already exists in `phase-remote-loading.md` Phase 2.

It also requires the *viewer's user* to have an account in that tenant, which means it does not even solve "send a link to an outside client". **Do it reactively, if ever.** For Google, the equivalent escape hatch is the cheaper Drive API + API key (fallback 5 above), not OAuth.

---

## What is not worth doing

- **A CORS proxy.** Client model bytes transiting a third party is likely disqualifying on its own, and both major public proxies failed live when I tested them. Self-hosting one re-introduces the backend we're avoiding and would proxy hundreds of MB per view.
- **Building the SharePoint OAuth flow speculatively.** `phase-remote-loading.md` Phase 2 budgets an Azure AD app registration and an OAuth2/PKCE implementation for SharePoint. **That is no longer the cheapest route for anonymous share links**, and that plan should be amended to say so before someone picks the card up and builds it. It survives only for named-recipient shares, which don't work for outside clients anyway.
- **Building our own hosted storage.** The user already pays for Drive/SharePoint/OneDrive/NAS. Adding our own makes us a GDPR processor and costs us the "no data leaves your device" line, in exchange for nothing the client needs.
- **A native app.** Dalux, Revizto and Trimble each ship one or two. Our advantage is that we need no install — lean into it.
- **Adopting xeokit.** Best published numbers, AGPL-or-pay licence. Use MIT Fragments if our own format underperforms.
- **A server-side conversion pipeline.** Correct at Autodesk's scale, ruinous at ours. Phase 3 gets most of the benefit.
- **Shrinking the desktop UI to fit a phone.** Revizto built a second app rather than do this. Presentation mode is the cheap version of that instinct.
- **2D-plan ↔ 3D navigation in phase 1.** It is the best idea in this document, and it is a large feature depending on storey/plan extraction we don't have. Note it as a future headline; don't let it block the tablet demo.

---

## What I could not verify

**About our own code — I read `origin/main` @ `d517f0c` and ran the shipped modules; I ran nothing on a phone or tablet.**
- No behaviour claim here has been observed on real mobile hardware. Phase 0 exists to close this.
- Whether the landing-screen URL input actually clips on a narrow viewport. The CSS arithmetic says it should; I did not render it.
- Whether the invisible-error path reproduces in a browser. The code path is unambiguous; the observation is not.
- Whether iOS Safari dispatches `contextmenu` on long-press over a `<canvas>`, and therefore whether the context menu is reachable at all on iPhone.
- Whether the hand-rolled pinch and OrbitControls' two-finger pan feel right together — correct by construction, but "correct" and "good" are different tests.
- Whether the parser's first `StreamAllMeshes` counting pass is genuinely cheap on mobile. A profiling lead only.
- The live consequence of the Dropbox rule's narrow pattern. I verified by execution that modern Dropbox share-link *shapes* don't match; I did not test a real Dropbox link.

**About the providers — probes run 2026-08-25 with `curl`, from a server, not from a browser.** `curl` with an `Origin` header shows exactly which CORS headers a server returns, which is what determines whether a browser will permit the read — but it is not the same as watching a real `fetch()` succeed in Safari on an iPhone. **Every positive result below should be confirmed once, by hand, in a browser, before anything is built on it.**

Being explicit about this, because it is the part of the document most likely to be wrong:

- **Both positive results contradict the documented consensus.** Microsoft states SharePoint Online "does not allow cross-origin fetch requests by default"; the widely-repeated position on Google Drive is that it sends no CORS headers at all. I believe both statements are true of the endpoints they describe and false of the two endpoints that actually work — but "I found an undocumented endpoint that behaves better than the vendor says" is a claim that deserves scepticism, not celebration. Re-test before promising anything to a client.
- **Google Drive: GET works, HEAD does not.** Reproduced both ways. A GET returns `206`/`200` with `ACAO: *` and real bytes; a HEAD on the identical URL returns `200 text/html`, `Content-Length: 0` and no ACAO. My *first* probe of this endpoint appeared to show a working HEAD; it did not reproduce, and the GET result did. **Where those two disagree, trust the GET result and the reproduction, not the first probe.**
- **Both working endpoints are undocumented.** Google's `confirm=t` is an undocumented query parameter that tools like `gdown` depend on, on a host Google has changed before. SharePoint's `_layouts/15/download.aspx` is an internal endpoint with no compatibility commitment. **Treat both as dependencies that can break without notice.** This is the reason the "download it and open it" fallback must stay permanently visible.
- **SharePoint was verified on exactly one tenant.** Behaviour varies with tenant configuration, and a client with stricter settings may get a different answer. Test per tenant.
- **OneDrive personal is suggestive only.** The `400 "Bad Argument"`-not-`401` response from `api.onedrive.com`, with ACAO present, is good evidence that no token is demanded — but **I had no real `1drv.ms` link to test**, and the same endpoint returned `308 "User migrated"` for a business link, confirming it serves consumer OneDrive only. One real link would settle it in five minutes. It is also a legacy endpoint Microsoft is winding down.
- **Synology / QNAP were not tested at all** — no host available. Everything in the NAS row is documentation and community reports, not measurement. The QNAP half is barely even that: I could find no QNAP documentation on CORS headers for share links.
- **Dropbox's redirect behaviour was inferred, not measured end-to-end.** I confirmed `dl.dropboxusercontent.com` sends `ACAO: *` and that `www.dropbox.com` does not; the claim that the redirect chain between them strips CORS comes from a third-party project's documentation, not from my own test with a real link.
- **Google Drive download quotas** ("Sorry, you can't view or download this file at this time") are real and widely reported, but **Google publishes no numeric threshold** and I established none. Treat it as an availability risk on a popular model.

**About the field:**
- **Dalux publishes nothing** about its mobile format, streaming architecture, LOD scheme, or size limits. The conversion-happens-server-side conclusion is inference from their documented upload/process step plus universal industry practice.
- No documented 3D touch-gesture map for the Dalux mobile viewer (only the 2D plan navigator's).
- Named preprocessing formats for **StreamBIM** and **Catenda Hub** — not published.
- Whether **Catenda**, **usBIM**, or **Revizto's model viewer** support true no-account links.
- Any independent, methodology-transparent mobile benchmark of any of these products. Every performance claim in the field is vendor-authored.

---

## Appendix — decision-to-phase map

| Decision | Answer needed before | Blocks |
|---|---|---|
| D1 (which providers) | Phase 1a | Phase 4 |
| D2 (what "verified" means) | Phase 1a | Phase 4 |
| D3 (measure the phone) | Phase 0 | Phase 3 |
| D4 (compact format) | Phase 3 | Phase 3 |
| D5 (what to cut) | Phase 1b | Phase 1b |
| D6, D7 (gestures, tolerance) | Phase 1b | Phase 1b |
| D8 (first-run flow) | Phase 1 | Phase 1 |
| D9 (CORS fallback) | Phase 1a | — |
| D10 (native / PWA) | Phase 2 | — |
| D11 (target devices) | Phase 0 | Phase 0 |
| D12 (sequencing) | Now | Everything |
