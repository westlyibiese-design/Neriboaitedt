# Phase 2 Handoff — Storage Foundation (carries forward Phase 1's Foundation & Navigation Renaming content)

**Phase 3: read this before touching anything.** Sections 1–7 below are Phase 1's original handoff, unedited except where noted. Section 8 is new in Phase 2.

## 1. Final type values

```ts
// src/types.ts
export type ActiveNav =
  "chat" | "orders" | "live" | "showcase" | "settings" | "operations";
// was: "chat" | "projects" | "code" | "artifacts" | "settings" | "operations"

export type OperationsSection =
  | "dashboard" | "users" | "conversations" | "feedback" | "events"
  | "actions" | "appSettings" | "aiModel" | "systemConsole"
  | "deviceSettings" | "deleted"
  | "showcaseManagement";          // NEW in Phase 1
```

Nav → component mapping (all in `src/components/Workspaces.tsx`):

| Nav (`ActiveNav`) | Sidebar label | Component | Was |
|---|---|---|---|
| `"orders"` | Orders | `OrdersView` | `ProjectsView` |
| `"live"` | Live | `LiveView` | `CodeView` |
| `"showcase"` | Showcase | `ShowcaseView` | `ArtifactsView` |

Sidebar icons were left as they were (Box / Code2 / Shapes).

## 2. `ArtifactItem` was RENAMED to `ShowcaseItem`

The blast radius was small — only `types.ts`, `App.tsx`, `mockData.ts` and
`Workspaces.tsx` actually referenced the type (the other files named in the
brief only had the word "artifact" in comments/labels). `ProjectItem` was
**not** renamed (the brief only asked for the component rename).

The old chat-snippet fields (`type`, `content`, `language`, `size`) were
**dropped**: the only thing that produced them was the auto-extraction that
this phase removes, and no screen displays them anymore. `description`,
`createdAt` and `updatedAt` were **added** beyond the fields the brief listed,
because the management form needs a description and a persisted item needs
real timestamps (ISO strings, same convention as `ChatThread`).
`INITIAL_ARTIFACTS` in `mockData.ts` was deleted (nothing seeds Showcase).

```ts
export interface ShowcaseItem {
  id: string;                 // Firestore doc id — NOT stored in the doc body
  title: string;
  description: string;
  priceCode?: number | null;  // Naira, raw-code download. null = not offered
  priceUrl?: number | null;   // Naira, custom URL/clone service. null = not offered
  active: boolean;            // visible to regular users; new items default true
  fileRef?: string | null;    // Phase 2 placeholder — unused in Phase 1
  liveUrl?: string | null;    // deployed preview link — used by the Live page
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
}
```

## 3. Firestore: `showcaseItems/{itemId}`

Top-level collection. Doc id = Firestore auto-id (`newShowcaseItemId()` in
`src/lib/showcasePersistence.ts`). Exactly these nine fields are allowed —
`firestore.rules` rejects any other key:

| Field | Type | Rules |
|---|---|---|
| `title` | string | required, 1–200 chars |
| `description` | string | required, ≤ 5000 chars (may be empty) |
| `priceCode` | number \| null | if not null: > 0. UI accepts whole Naira only |
| `priceUrl` | number \| null | same |
| `active` | boolean | required |
| `fileRef` | string \| null | ≤ 500 chars. Free text in Phase 1 |
| `liveUrl` | string \| null | if not null: ≤ 2000 chars, must match `https?://.+` |
| `createdAt` | string (ISO) | required |
| `updatedAt` | string (ISO) | required |

The client always writes all nine, with an explicit `null` for an empty
optional field (never `undefined`, never omitted).

**Access (firestore.rules `showcaseItems` block):**
- Read: Supervisor → everything. Any other signed-in account → only docs where
  `active == true`. Rules aren't filters, so a regular account's query must
  carry `where("active", "==", true)` (`loadActiveShowcaseItems` does).
- Create / update / delete: Supervisor only, and only with a valid shape.
- No client anywhere can write as a non-Supervisor.

**Heads-up for Phase 2 (addressed — see Section 8):** because active items are
readable by any signed-in account, `fileRef` is too. It's only a path (bucket
stays private, access only via signed URLs), but if you want the path hidden
from regular users, put it in a Supervisor-only document instead of trying to
hide one field with rules. Phase 2 left `fileRef` on the existing document as
originally designed (a bucket path alone grants no access without a signed
URL, which only a backend holding `SUPABASE_SERVICE_ROLE_KEY` can mint) — if
Phase 5's download-gating needs it hidden from non-purchasers entirely, that's
this note's suggested fix, still unapplied.

## 4. Other Firestore doc added: `appConfig/showcase-enabled`

`{ value: boolean, updatedAt: string (ISO), updatedByUid: string }`.
Client-read-only (existing `appConfig` rule); written only by
`functions/api/admin/set-showcase-enabled.js` (Supervisor-gated, mirrors
`set-app-version.js`). Read via `useShowcaseEnabled()` →
`{ enabled, loading }`. Missing doc or read error ⇒ **enabled**. Only an
explicit `false` pauses Showcase. It gates what *regular users see* in
Showcase and Live; it is **not** a data-access control (rules on
`showcaseItems` don't consult it), and `ShowcaseManagementPanel` ignores it.

## 5. How the pieces connect

- `src/lib/showcasePersistence.ts` — `loadActiveShowcaseItems()`,
  `loadAllShowcaseItems()` (Supervisor only), `saveShowcaseItem(item)`,
  `deleteShowcaseItemDoc(id)`, `newShowcaseItemId()`, `isValidHttpUrl()`.
  It is `.ts`, not `.js` as the brief wrote, to match `chatPersistence.ts`
  (which is also TypeScript). Loading normalizes docs (`active` fails closed;
  a non-http(s) `liveUrl` is dropped so it can never reach a link `href`).
- `App.tsx` owns `showcaseItems` (`null` = not loaded) + `showcaseLoadError`.
  Loaded lazily: regular account → active items when Showcase or Live opens;
  Supervisor → all items when Operations → Showcase Management opens.
  Cleared on account change. Passed to `ShowcaseView`/`LiveView`, and to
  `OperationsView` → `ShowcaseManagementPanel` (with `onShowcaseItemSaved`).
- Nothing in Phase 1's UI calls `deleteShowcaseItemDoc` — items are paused
  (`active: false`), not deleted, since later Orders will reference item ids.
- The chat → Artifacts auto-extraction in `handleSendMessage` is removed
  (comment left in place). Nothing a chat reply contains can create a Showcase
  item.
- Orders: `OrdersView` no longer takes `onOpenProjectChat`; cards expand in
  place (title, description, placeholder status). The local, in-memory
  "New Project" form on that page was **kept** (removing it wasn't in scope,
  and it's the only way to get an Order card on screen before Phase 4). It
  still creates a `ProjectItem` that vanishes on refresh. Phase 4 should
  replace it.

## 6. Left alone / known leftovers

- Paystack, `chatPersistence.ts`, `checkSupervisorRole.js` (read, not
  modified — `isSupervisor()` reused as-is), `useIsOperations()`,
  `functions/api/payments/*`, `supabaseStorage.js`: untouched. (Supabase
  itself is no longer untouched as of Phase 2 — see Section 8 and
  `docs/SUPABASE_CONTRACT.md`.)
- `src/components/MarkdownRenderer.tsx` has a stale comment mentioning
  "Workspaces' markdown artifact" (Workspaces no longer renders markdown).
  Comment only; not edited to keep this phase's diff minimal.
- Old usage-analytics `screen_view` events still contain `projects` / `code` /
  `artifacts`; `SCREEN_LABELS` in `useUsageAnalytics.ts` keeps those keys so
  history still reads correctly.
- `AppSettingsPanel.tsx` and `operationsActions.ts` were edited (one new
  setting entry / one new function) — required by brief item 7.

## 7. Verification status (as delivered)

Done: syntax check of every changed/new TS/TSX/JS file, and a type-check of the
whole `src/` tree with `react`, `firebase/*` and `lucide-react` stubbed as
loosely-typed modules (no new errors in touched files — Firebase call types
were not actually checked).

**Not done — could not be run in the environment this was written in (no
dependencies installed, no network, no Firebase project):** `pnpm build`,
`pnpm lint` (`tsc --noEmit`), the app itself, the Firestore rules in the
emulator/Rules Playground, and the deployed Pages Function. The manual test
checklist from the brief is therefore still to be run against the real app.

## 8. Phase 2 additions — Supabase Storage Foundation

Full binding contract: **`docs/SUPABASE_CONTRACT.md`** — read it before
touching Supabase in Phase 3+. Summary of what changed:

### New files
- `functions/_shared/supabaseFiles.js` — Storage client for the new
  `neribo-showcase-files` bucket (sibling to `supabaseStorage.js`,
  which is untouched). Exports `uploadShowcaseFile`,
  `getSignedDownloadUrl`, `extensionForShowcaseMimeType`.
- `functions/api/showcase/upload-file.js` — `POST
  /api/showcase/upload-file`. Supervisor-only. Accepts one file
  (JSON + base64 body, same convention as `functions/api/images/store.js`)
  for a given `showcaseItemId`, validates it (shape, MIME allow-list,
  size ≤ 40 MB, best-effort magic-byte check), uploads it via
  `supabaseFiles.js`, and returns `{ path, url }`.
- `src/lib/showcaseFilesApi.ts` — frontend client for the endpoint
  above (`uploadShowcaseFile(showcaseItemId, file, previousPath?)`,
  `validateShowcaseFile`, `resolveShowcaseMimeType`,
  `SHOWCASE_FILE_INPUT_ACCEPT`, `MAX_SHOWCASE_FILE_BYTES`).
- `docs/SUPABASE_CONTRACT.md` — the full contract (bucket name, path
  convention, function signatures, env vars, the "storage only, no
  tables/RLS/Realtime" rule restated explicitly).

### Changed files
- `src/components/operations/ShowcaseManagementPanel.tsx` — the
  placeholder `fileRef` text input is replaced with a real file-upload
  control. The form now pre-generates (for a new item) or reuses (for
  an edit) a `formItemId`, used as the Supabase path's `showcaseItemId`
  segment so an upload can happen before the item is first saved;
  `handleSave` was changed to reuse that same id (previously it called
  `newShowcaseItemId()` a second time at save, which would have
  produced a Firestore doc id that didn't match whatever id an earlier
  upload in the same session had already used). On a successful upload
  the returned `path` is written into `form.fileRef` — same Firestore
  field Phase 1 already defined, same 500-char limit, same
  `saveShowcaseItem` write path. No Firestore schema change.

### Supabase-side (via the Supabase connector, no SQL migrations file —
### this project has none, per the storage-only rule)
- Created bucket `neribo-showcase-files`: `public: false`, no
  bucket-level file-size/MIME restrictions (same shape as the existing
  `neribo-images` bucket). Verified before and after: zero tables in
  the `public` schema, zero custom RLS policies, zero Realtime
  publications, zero functions/triggers. Nothing else in the Supabase
  project was touched.

### Explicitly NOT done in Phase 2 (see the brief's Out of Scope /
### Dependencies)
- No download-gating ("has this user paid") — `getSignedDownloadUrl`
  exists in `supabaseFiles.js` for Phase 5 to call, but nothing calls
  it yet, and there's no customer-facing download endpoint.
- No Paystack, no `orders` collection, no payment/status logic.
- Chat Neribo and Domains (Phases 7–8) untouched.

### Known limitation to carry forward honestly (not a bug — a
### documented boundary)
`upload-file.js`'s server-side file-type check is real signature
verification for zip/PNG/JPEG/GIF/WebP, but only a weak plain-text
sanity check for `text/html` (HTML has no reliable magic bytes). A
determined Supervisor account could get non-HTML text content past this
endpoint under an `"text/html"` label. Since the Supervisor role is
already a fully-trusted, hand-granted role (see
`checkSupervisorRole.js`'s own file header) and nothing server-side ever
executes uploaded content, the residual risk is confined to what a
browser does when a customer later opens a signed download link
directly — worth knowing about, not worth over-engineering against in
this phase.

### Verification status (as delivered)
Done: syntax/bracket-balance check of every changed/new file; read
`functions/_shared/supabaseStorage.js`, `checkSupervisorRole.js`,
`functions/api/admin/set-flag.js`, `functions/api/images/store.js`,
`ShowcaseManagementPanel.tsx`, `showcasePersistence.ts`, and this
handoff doc in full before writing anything, per the brief's Critical
Architecture Rule and Supabase Continuity Requirement; created and
verified the `neribo-showcase-files` bucket directly against the live
Supabase project (`ligtjlobeetgdidqwuyb`), confirmed empty `public`
schema before and after.

**Not done — could not be run in the environment this was written in
(no dependencies installed, no network to Cloudflare/Firebase, no
Replit shell):** `pnpm build`, `pnpm lint`, the actual app, and the four
manual Testing Requirements from the brief (Supervisor upload
round-trip against the real deployed function; non-Supervisor rejection
of `upload-file.js` called directly; confirming existing chat-image
upload/generation still works unaffected; confirming no Postgres/SQL/
RLS artifacts exist — the last of these WAS verified directly against
Supabase itself in this phase, see above, but should be re-checked after
your own deploy too). Run the commands in the delivery message, then
work through those four checks against the real app before starting
Phase 3.

## 9. Addendum — orphaned-file cleanup on replace (post-delivery fix)

Real-world testing surfaced a gap: replacing a Showcase item's file with
one under a DIFFERENT filename (e.g. swapping `index.html` for
`site.zip`) uploaded the new object correctly but left the old one
sitting in the bucket — `x-upsert` only overwrites when the filename is
identical, so a different filename just adds a second object instead of
replacing.

Fixed by:
- `functions/_shared/supabaseFiles.js` — added `deleteShowcaseFile(env,
  { showcaseItemId, filename })`.
- `functions/api/showcase/upload-file.js` — accepts an optional
  `previousPath` field (the item's current `fileRef`, sent by the
  client), validates it belongs to the same `showcaseItemId`, and — only
  once the NEW file is already safely uploaded — deletes the old object
  if its filename differs from the new one. The delete is non-fatal: a
  failure here never turns a successful upload into a failed response,
  it just leaves an orphan to clean up by hand and logs an
  `operationsEvents` record (category `showcase`, severity `low`) so
  it's visible in Operations → Events.
- `src/lib/showcaseFilesApi.ts` — `uploadShowcaseFile` now takes an
  optional third argument, `previousPath`.
- `ShowcaseManagementPanel.tsx` — passes `form.fileRef` (the item's
  file path BEFORE this upload) as `previousPath` on every upload call.

One orphaned object from testing (`TYKypM7bUMggCBCfkmaN/index.html` in
`neribo-showcase-files`) was removed directly from Supabase as part of
this fix — see `docs/SUPABASE_CONTRACT.md` if a future phase needs to
know this happened. No other bucket contents were touched.
