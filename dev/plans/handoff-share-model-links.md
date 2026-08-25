# Share a link that opens the viewer with your models in it

> ## ⚠ Re-verify before implementing
>
> Written 2026-08-25 against `main` at `07a6b9b`. Claims about existing code
> were checked then and are cited inline. Re-check them before starting — and
> if one is wrong, fix this document and say so rather than implementing
> around it. A previous plan in this repo was built on an unverified claim and
> had to be reverted.

---

## TL;DR — decisions needed

| # | Decision | Options | Recommended |
|---|---|---|---|
| **S1** | Where the share UI lives | **(a)** a "Share…" button in the model-tree header opening a checklist dialog · **(b)** right-click context menu on model-tree rows · **(c)** the contextual-action tray | **(a)** — the tree already lists models with checkboxes; see *Where it lives* |
| **S2** | Link format | **(a)** repeated `?url=A&url=B` · **(b)** one packed+compressed param | **(a)** — backward compatible with the `?url=` that already ships |
| **S3** | Recipient lacks access to some models | **(a)** load what works, name what failed · **(b)** all-or-nothing | **(a)** — this is the user's "warned which ones they don't have access to" |
| **S4** | Replace the `window.confirm()` the recipient currently gets | **(a)** yes, one in-page dialog listing every model · **(b)** keep confirm | **(a)** — N models currently means N blocking native dialogs |
| **S5** | Cap models per link | **(a)** soft cap ~8 with a warning · **(b)** hard cap · **(c)** none | **(a)** |
| **S6** | Does the link also carry the **camera view**? | **(a)** no · **(b)** yes, optional "include current view" tick | **(b)** — cheap, and it is most of the "wow"; see *Carrying the view* |
| **S7** | Which URL goes in the link — what the user pasted, or the rewritten direct-download form | **(a)** store what they pasted, rewrite at load · **(b)** store the rewritten form | **(a)** — old links keep working when rewrite rules improve |

**Prerequisite, not part of this PR:** the provider rewrite rules
(SharePoint/OneDrive, Google Drive) and the `RemoteLoader` size-guard fix.
Without the rewrite rules a pasted OneDrive share link cannot be loaded at
all, so this feature has nothing to share. See *Prerequisite* below.

---

## What already exists (verified 2026-08-25)

Much more than expected. This feature is mostly **assembly**, not new capability.

- **`?url=` deep-linking already ships.** `src/main.ts` reads
  `URLSearchParams`, takes a single `url` param, shows a `window.confirm()`
  naming the host, and calls `app.loadFromUrl(url)`.
- **Provenance is already recorded.** `ModelSource` in
  `src/services/SessionStore.ts` is
  `{ type: 'local'; fileName } | { type: 'remote'; url; fileName }`.
  **The grey-out rule the user described falls straight out of this** — a model
  is shareable if and only if its source is `remote`.
- **Remote loading is real.** `src/loader/RemoteLoader.ts` fetches, validates
  the `ISO-10303-21` header, tracks progress, and classifies failures.
- **URL rewriting has a home.** `src/loader/urlNormalizer.ts` already rewrites
  GitHub, GitLab and Dropbox links to direct-download form.
- **The model tree already lists models** with per-model checkboxes and
  visibility controls (`src/ui/ModelTreePanel.ts`).

**Proven end-to-end 2026-08-25**: a real browser `fetch()` from the page
origin to a SharePoint share link rewritten to
`_layouts/15/download.aspx?share=<id>` returned `status: 200`,
`type: "cors"`, 102 672 bytes, body beginning `ISO-10303-21;`. And a
hand-built `?url=<that>` deep link loaded it. **The mechanism works today.**

---

## The shape of the feature

### Only remote models can be shared

A model loaded from the user's own disk has no URL — there is nothing to put
in a link, and no amount of UI can invent one. So:

- `source.type === 'remote'` → tickable.
- `source.type === 'local'` → greyed, with a reason on the row, not just a
  disabled checkbox: *"Loaded from your computer — upload it and load it by
  link to share it."* A disabled control with no explanation reads as a bug.

This is exactly the rule the user intuited, and it needs no new data.

### Where it lives (S1)

**Recommended: a "Share…" button in the model-tree header**, opening a dialog
that lists every loaded model with a tick, greying the local ones.

The tree is already the place where models are listed, checked and toggled, so
this is where a user looking to *do something with a set of models* will go.
A right-click menu on tree rows is less discoverable, and this app's existing
context menu is **selection-scoped** — it is built from `SelectionState` and
acts on elements. Overloading it with model-level actions would blur a
distinction that is currently clean.

The user asked for "its own context menu"; recommending (a) is a deliberate
counter-proposal, and (b) remains a reasonable choice if they prefer it.

### The dialog

- One row per loaded model: name, tick, and — for remote models — the host it
  came from, because "which OneDrive is this?" is a real question when several
  are open.
- Local models greyed with the reason above.
- A generated link in a read-only field with a **Copy** button.
- **A plain-language warning, not fine print:** anyone with this link can
  download these models. The link carries the share tokens, so it is exactly
  as sensitive as the OneDrive/Drive links themselves, and it stops working
  when those do (expiry, revocation, moved file).
- If nothing tickable is loaded, say so plainly instead of showing an empty
  dialog with a dead Copy button.

### Carrying the view (S6)

Optional tick: **"Open at this view."** Adds the camera position and target to
the link; the recipient lands looking at what the sender was looking at.

`Viewer.getCameraState()` / `restoreCameraState()` already exist and already
round-trip position+target — this is small. It is also most of the emotional
payload of the feature: "here is the clash I am talking about" is worth far
more to a client than "here is the model, go find it". Six numbers, rounded,
in one param.

Keep it optional and off by default: a link that yanks you to someone else's
viewpoint is occasionally exactly wrong.

### What the recipient sees (S3, S4)

Today: one blocking `window.confirm()` per URL. With several models that is
several native dialogs in a row — unusable, and on mobile, awful.

Replace with **one in-page dialog** (same visual language as the analytics
dialog that just shipped): "This link wants to open 3 models from
`tommerdal-my.sharepoint.com`" with the list, and Load / Cancel. One decision,
one dialog, and the host shown so the recipient can judge it.

Then **load each model independently and report per-model outcomes.** A 403 on
the second model must not stop the first and third from loading. Distinguish
the cases honestly, because "failed to load" tells the recipient nothing about
what to do:

| what happened | what the recipient is told |
|---|---|
| 401 / 403 | "You do not have access to this model. Ask the sender to share it with you." |
| CORS / network failure | "This model could not be opened from a browser." |
| 404 | "This model is no longer available at that link." |
| over the size guard | "This model is too large to open here." |

The **partial-success** case is the interesting one and the user called it out
explicitly. Load what works, show what did not, keep the viewer usable.

### Link format (S2, S5)

Repeated params, extending what already ships:

```
https://magnusfjeldolsen.github.io/ifcviewer/?url=<enc A>&url=<enc B>&view=<...>
```

A single `?url=` — the current form — keeps working untouched, so every link
already in the wild survives.

**Length is the constraint.** A rewritten SharePoint URL is ~150 characters,
~200 encoded. Three models is fine; ten is ~2 000 and pushing what is
comfortable to paste into an email or a chat client that may linkify and
truncate. Hence the soft cap (S5): allow it, but warn above ~8 that the link is
getting unwieldy. Do not silently truncate.

Compression (S2b) is a real option if links get long in practice — but it
makes links opaque and un-inspectable, which is a genuine loss when the whole
point is that a recipient can see where the model is coming from before
loading it. Start uncompressed.

### Which URL goes in (S7)

**Store what the user pasted, rewrite at load time.** If we bake today's
`download.aspx` rewrite into the link and Microsoft changes that endpoint,
every link ever generated breaks. If the link carries the original share URL,
improving the rewrite rule fixes old links for free.

This also keeps the link legible: a recipient hovering it sees a normal
SharePoint URL, not an internal `_layouts` path.

---

## Prerequisite (separate, smaller PR)

This feature is pointless until a pasted OneDrive or Drive share link can
actually be loaded. That work is small and independent:

1. **Rewrite rules in `urlNormalizer.ts`** for SharePoint/OneDrive-for-Business
   (`/:u:/g/personal/<user>/<id>` → `personal/<user>/_layouts/15/download.aspx?share=<id>`)
   and Google Drive. Both endpoints are **undocumented**; the rewrite must fail
   loudly and legibly if it stops working.
2. **Repair the Dropbox rule** — its regex requires `?dl=0` at the very end of
   the URL, and modern Dropbox links are `...?rlkey=…&dl=0`. It cannot match.
3. **Fix the `RemoteLoader` size guard.** The 500 MB check lives only in a HEAD
   pre-check wrapped in `try/catch` with a fall-through to GET; the GET path
   reads `content-length` for progress only and never re-checks it. Google
   Drive serves GET but rejects HEAD, so on exactly the provider we care about
   the guard silently stops guarding. Re-check on the GET response before
   reading the body.

---

## Risks

- **Undocumented endpoints.** Both provider rewrites depend on URLs neither
  vendor documents. They work today; they are not contracts. Fail loudly.
- **Link sensitivity.** The generated link is a bearer credential for the
  models. Anyone who forwards it grants access. This must be stated in the UI,
  in plain words.
- **Silent partial failure.** The failure mode that would most damage trust is
  a link that quietly opens two of three models. Per-model reporting is not a
  nicety here.
- **Long links.** Chat clients and email may wrap or truncate. Watch it in
  real use before adding compression.
- **Mobile memory.** A link that opens three large models on a phone will
  reload the tab. See `assessment-mobile-tablet.md`; a per-link model count is
  not the same guard as a per-device memory budget.

---

## Checklist

- [ ] Re-verify the ⚠ banner's claims
- [ ] Decisions S1–S7 answered
- [ ] Prerequisite PR merged (rewrite rules, Dropbox repair, size-guard fix)
- [ ] Branch `feature/share-model-links`
- [ ] Run existing tests (baseline)
- [ ] Link building + parsing as a pure, tested module (multi-`url`, optional
      `view`, malformed input, the single-`url` legacy form)
- [ ] Share dialog: tick list, local models greyed **with a reason**, copy
      button, sensitivity warning, empty state
- [ ] Optional "open at this view"
- [ ] Recipient dialog replacing `window.confirm`, one for all models
- [ ] Per-model load outcomes with the four distinct messages
- [ ] Manual test: share 2 remote + 1 local; open the link in a **different
      browser profile** with access to only one of them; confirm partial load
      and the right message for the other; confirm a legacy single-`url` link
      still works
- [ ] PR
