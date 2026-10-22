# Supabase Contract — READ THIS BEFORE TOUCHING SUPABASE IN ANY LATER PHASE

This is the single source of truth for how Neribo uses Supabase. Every
phase from here on (3–9) must read this file before writing any code
that touches Supabase, and must not deviate from it. If something you
need isn't described here, that's a signal to stop and ask, not to
improvise a new table/policy/convention.

## The one rule that matters most

**Supabase in this project exists for exactly one purpose: storing raw
files in private buckets and handing back signed URLs. Nothing else.**

- Firebase/Firestore is the source of truth for **all** structured and
  relational data — every record, status, price, order, message, and
  relationship. Never in Supabase, ever, in any phase.
- There are **no Postgres tables, columns, foreign keys, Row Level
  Security policies, Realtime channels, database functions, or
  triggers** in this project's Supabase instance, and none should ever
  be created. The `public` schema is empty — verified empty as of this
  phase.
- Access control is enforced entirely in server-side Cloudflare
  Functions, which authenticate to Supabase with
  `SUPABASE_SERVICE_ROLE_KEY`. That key bypasses Row Level Security
  entirely, by design — the trusted authority here is the Cloudflare
  Function itself, not anything Supabase-side. If you find yourself
  about to write SQL, create a table, or configure RLS: stop. That is
  not this project's architecture, in this phase or any later one.

## Buckets (the only Supabase objects that exist)

Two private Storage buckets exist. Both have `public: false` and no
bucket-level file-size or MIME-type restriction — validation happens in
application code, not at the bucket.

| Bucket | Owner module | Path convention | Contents |
|---|---|---|---|
| `neribo-images` | `functions/_shared/supabaseStorage.js` | `${uid}/${requestId}.${ext}` | Generated chat images (existing feature — untouched by Phase 2) |
| `neribo-showcase-files` | `functions/_shared/supabaseFiles.js` | `${showcaseItemId}/${filename}` | Showcase deliverables: zips, HTML bundles, preview images |

**Use these exact bucket name strings. Never guess, abbreviate, or
introduce a variant.** A later phase that needs a Showcase file always
goes through `supabaseFiles.js` (below) — never re-implements a
Supabase Storage call, and never invents a third bucket.

## `functions/_shared/supabaseFiles.js` — the only API surface for `neribo-showcase-files`

A sibling to `supabaseStorage.js`, same plain-`fetch`-only style (no
`@supabase/supabase-js` — this runs on Cloudflare Workers), same
service-role trust model. Exports:

### `uploadShowcaseFile(env, { showcaseItemId, filename, bytes, mimeType })`
Uploads `bytes` to `neribo-showcase-files` at
`${showcaseItemId}/${filename}` (overwriting if that exact path already
has an object) and returns a long-expiry (10 year) signed URL as a
ready-to-use string. Throws on any failure — the caller must catch it
and translate it into a safe, generic client-facing message; this
function never talks to Firestore.

### `deleteShowcaseFile(env, { showcaseItemId, filename })`
Deletes the object at that path, if it exists (no error if it doesn't —
Supabase's delete endpoint is idempotent that way). Used by
`upload-file.js` to remove an item's PREVIOUS file when it's replaced by
one with a different filename (same filename = already overwritten via
upload's `x-upsert`, no delete needed). Throws on a genuine failure;
`upload-file.js` treats that as non-fatal since it only ever runs after
the new file is already safely uploaded.

### `getSignedDownloadUrl(env, { showcaseItemId, filename, expiresInSeconds?, download? })`
Re-signs a URL for an object that is already sitting in the bucket,
without re-uploading anything. **This is what Phase 5 calls** to mint a
fresh download link on demand for a customer who has paid — don't store
a permanent public URL anywhere; store the path (see below) and re-sign
when a download is actually needed.

Two optional, additive parameters (Phase 5 extensions — every pre-Phase-5
caller omits both and is unaffected):
- `expiresInSeconds` — overrides this module's long-lived default. Phase
  5 passes 600 (10 minutes) for a one-time customer download; the
  10-year default stays correct for the always-visible chat-image case.
- `download` — pass `true`, or a filename string, to append a
  `?download` (or `&download`, joined correctly with the signed URL's
  existing `?token=...` query string) query parameter to the final
  signed URL — **not** a field in the sign request's own body, which
  Supabase's sign endpoint doesn't recognize and silently ignores (an
  earlier version of this function got this wrong; see the inline
  comment on the fetch call in `supabaseFiles.js` for the correction).
  That query parameter is what makes Supabase respond with a
  `Content-Disposition: attachment` header. Omit `download` for inline
  display (the pre-Phase-5 behavior). **Always pass this for anything a
  "Download" button opens directly** (e.g. via `window.open`) — without
  it, a browser is free to render the content inline instead of saving
  it, which is exactly wrong for a paid deliverable (a customer clicking
  Download on an `.html` file would otherwise get a tab full of raw
  source instead of a saved file — this is exactly what happened before
  the fix, and testing with a `.zip` alone won't catch it, since
  browsers already refuse to render zip files inline regardless of any
  header). `functions/api/orders/get-download.js` passes the real
  `filename` here so the saved file also gets a sensible name instead of
  Supabase's default.

### `extensionForShowcaseMimeType(mimeType)`
Returns the file extension for a MIME type this bucket accepts, or
`null` if the type isn't supported. Currently accepts: `application/zip`,
`application/x-zip-compressed`, `text/html`, and the same image types
`supabaseStorage.js` accepts (`image/png`, `image/jpeg`, `image/jpg`,
`image/webp`, `image/gif`). If a later phase needs a new file type
accepted into this bucket, add it to this map (and to
`upload-file.js`'s server-side magic-byte check, and to
`showcaseFilesApi.ts`'s `ACCEPTED_MIME_TYPES`/`EXTENSION_TO_MIME` on the
frontend) — never bypass this module to upload some other way.

**Do not modify `functions/_shared/supabaseStorage.js`.** It stays
owned exclusively by the existing chat-image feature. If a later phase
needs Showcase-file behavior that doesn't exist yet, add it to
`supabaseFiles.js`, not there.

## What gets stored in Firestore

`ShowcaseItem.fileRef` (a plain string field on the existing
`showcaseItems/{itemId}` Firestore document — see
`docs/PHASE_2_HANDOFF.md` for the full field table) holds the **storage
path**, not a URL:

```
fileRef = "${showcaseItemId}/${filename}"
```

e.g. `"aB3xQ...itemId.../restaurant-site.zip"`. A later phase that needs
to let a customer download this file calls
`getSignedDownloadUrl(env, { showcaseItemId, filename })` — parse
`fileRef` on `/` to get the two parts — rather than storing or reusing
any URL. Storing the path instead of a URL is deliberate: URLs expire
conceptually (even though today's signed-URL expiry is long), and
minting fresh ones on demand is the actual gate Phase 5 needs ("has this
user paid") — a stored URL would bypass that gate entirely.

## The upload endpoint

`functions/api/showcase/upload-file.js` — `POST /api/showcase/upload-file`,
Supervisor-only (verified server-side via
`functions/_shared/checkSupervisorRole.js`'s `isSupervisor()`, same
auth contract as every endpoint under `functions/api/admin/`).

Request body (JSON — same base64 convention as the existing
`functions/api/images/store.js`, no new upload mechanism introduced):

```json
{
  "showcaseItemId": "string, must match ^[A-Za-z0-9_-]{1,128}$",
  "filename": "string, must match ^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$",
  "mimeType": "one of the types supabaseFiles.js accepts",
  "fileBase64": "base64-encoded file bytes, no data: prefix",
  "previousPath": "optional — the item's CURRENT fileRef, if it has one"
}
```

`previousPath`, when present and different from the new
`${showcaseItemId}/${filename}` path, triggers a cleanup delete of the
old object AFTER the new one is safely uploaded (see
`deleteShowcaseFile` above) — this is how a Supervisor replacing a
`.html` file with a `.zip` (or any differently-named file) doesn't leave
the old object orphaned in the bucket. It's validated server-side
(must actually belong to the same `showcaseItemId`) and ignored rather
than erroring the request if it doesn't look right — it only ever
narrows what gets deleted, never widens it.

Response: `{ "path": "...", "url": "..." }` — `path` is what the client
should persist as `fileRef`; `url` is a freshly signed URL for immediate
use (e.g. confirming the upload succeeded) and is not itself persisted
anywhere.

Validates, in order: Supervisor auth, `showcaseItemId`/`filename` shape
(path-traversal guard), MIME type against `supabaseFiles.js`'s map, size
(≤ 40 MB decoded — `MAX_SHOWCASE_FILE_BYTES`, adjust in one place if a
later phase needs more headroom), and finally a **best-effort magic-byte
check** that the file's actual bytes match its declared type (real
signature verification for zip/PNG/JPEG/GIF/WebP; a much weaker
plain-text sanity check for HTML, since HTML has no reliable binary
signature — see that function's own comment for the honest limitation).

The frontend client is `src/lib/showcaseFilesApi.ts`
(`uploadShowcaseFile(showcaseItemId, file, previousPath?)`), used from
`ShowcaseManagementPanel.tsx`. A later phase adding its own upload
surface should call this same client function, not re-implement the
fetch/base64 dance.

## Environment variables

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — **already configured**
in this project's Cloudflare Pages environment (the existing chat-image
feature has depended on them since before Phase 2). Do not invent new
env var names for Supabase in any later phase; both `supabaseStorage.js`
and `supabaseFiles.js` read these exact two names. Never return
`SUPABASE_SERVICE_ROLE_KEY` to the client in any response, log, or error
message — every existing call site (and both new functions added in
Phase 2) already follows this; keep it that way.

## Realtime, RLS, and everything else: still absent, intentionally

To be maximally explicit for whoever reads this in Phase 3+: as of this
phase, the Supabase project has **zero** rows in `storage.buckets`
beyond the two listed above, **zero** tables in the `public` schema,
**zero** custom RLS policies, **zero** Realtime publications/channels
configured for application use, and **zero** database functions or
triggers. If a future phase's brief seems to ask for something
Supabase-native beyond "store this file, get a signed URL back" —
double-check against the actual brief and this file before building it;
it is far more likely the brief means "build this in Firestore" than
"this is the phase where Supabase's architecture changes."
