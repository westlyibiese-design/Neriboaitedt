# Phase 6 Handoff — Custom-URL Clone-Details Intake (carries forward Phases 1–5's content)

**Phase 7: read this before touching anything.** Everything through Section 12 (Phase 5's delivery notes and its two post-delivery addenda) is carried forward from Phases 1–5 **unedited** — where Phase 6 changed something those sections describe, Section 13 says so explicitly rather than rewriting history. **Section 13 is new in Phase 6** and is the part to read first. (One thing to know when reading Section 10.2 and 10.7: they say `in_progress` is "Supervisor override only" and that the rules "do not let an owner change `status`". Both are now out of date in exactly one narrow way — see 13.3.)

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

- `chatPersistence.ts`, `checkSupervisorRole.js` (read, not modified —
  `isSupervisor()` reused as-is), `useIsOperations()`,
  `supabaseStorage.js`: untouched. (Supabase itself is no longer
  untouched as of Phase 2 — see Section 8 and
  `docs/SUPABASE_CONTRACT.md`. Paystack/`functions/api/payments/*` is no
  longer untouched as of Phase 3 — see Section 9 and
  `docs/PAYSTACK_CONTRACT.md`.)
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

## 9. Phase 3 additions — Paystack One-Time Payment Foundation

Full binding contract: **`docs/PAYSTACK_CONTRACT.md`** — read it before
touching `functions/api/payments/*` or Paystack in Phase 4+. Summary of
what changed:

### Changed files
- `functions/api/payments/initialize.js` — now accepts an optional
  `purpose` (defaults to `"subscription"` — every existing caller,
  including the current frontend which sends no body, is unaffected)
  and, for the three new one-time purposes, an `amount` (kobo) plus
  optional `metadata.orderId` / `metadata.domainRequestId` pass-through
  fields. The `purpose === "subscription"` branch runs the identical
  Phase 1 code (same Plan, same `metadata: { uid }` shape, now with
  `purpose: "subscription"` added alongside it). See
  `docs/PAYSTACK_CONTRACT.md` §3 for the request contract and the
  **unresolved server-side amount-validation gap** — read that before
  wiring any real "Buy" button to this endpoint.
- `functions/api/payments/webhook.js` — `charge.success` now reads
  `data.metadata.purpose` and dispatches on it. The `"subscription"`
  path (including every event with no `purpose` at all) is the exact
  Phase 1 code, unchanged, just moved one indent level in — see the
  diff-verified block marked `UNCHANGED from Phase 1` in the file
  itself. `showcase_code` / `showcase_url` and `domain` currently only
  `console.log` the parsed event; each has a comment marked
  `// TODO(Phase 4):` or `// TODO(Phase 8):` directly above the log
  call, at the exact spot the real Firestore write belongs. No
  Firestore write was added for any new purpose — `orders` and
  `domainRequests` are Phase 4's and Phase 8's collections to design.
  Signature verification (`verifyPaystackSignature`) still runs
  unconditionally, before the body is parsed, for every event
  regardless of purpose.

### New files
- `docs/PAYSTACK_CONTRACT.md` — the full contract: `purpose` values,
  `initialize.js` request shape, exactly where in `webhook.js` each
  later phase plugs in, amount/currency conventions (kobo vs. Naira),
  and a plain-English Paystack-dashboard checklist for Westly
  (test-vs-live key, webhook URL registration, confirming test mode is
  active).

### Explicitly NOT done in Phase 3 (see the brief's Out of Scope)
- No `orders` or `domainRequests` Firestore collections — Phase 4 and
  Phase 8 own those.
- No Supabase file work (Phase 2, already done — untouched here).
- Chat Neribo (Phase 7) untouched.
- No frontend changes — `src/lib/paymentsApi.ts` still only calls
  `/api/payments/initialize` with no body, which is exactly the
  `purpose: "subscription"` default path. Phase 4/8 will need to add a
  way for the frontend to actually send `purpose`/`amount`/`metadata`
  for a real one-time purchase.
- Server-side amount validation against a Supervisor-set Firestore
  price — **not enforced yet, by design** (the price source doesn't
  exist until Phase 4/8). See `docs/PAYSTACK_CONTRACT.md` §3's
  "⚠️ Server-side amount validation" callout — Phase 4/8 MUST close this
  gap before any real purchase button calls this endpoint.
- `functions/api/payments/cancel.js` and
  `functions/_shared/paystackSignature.js`'s core HMAC algorithm: both
  read in full, neither modified. No bug found in
  `paystackSignature.js` worth flagging.

### Verification status (as delivered)
Done: read `initialize.js`, `webhook.js`, `cancel.js`, and
`paystackSignature.js` in full before changing anything, per the
brief's In Scope item 1; syntax-checked both changed files as ES
modules (`node --check`, with `"type": "module"`); diffed the new
`webhook.js` against the original to confirm the `"subscription"`
branch's logic is byte-for-byte unchanged (only re-indented) and that
`cancel.js` / `paystackSignature.js` were not touched at all.

**Not done — could not be run in the environment this was written in
(no Cloudflare Pages deploy, no live Paystack test-mode account, no
Firebase project, no Replit shell):** the actual Testing Requirements
from the brief — an end-to-end subscription purchase in Paystack test
mode, initializing a transaction for each new `purpose` value and
confirming the webhook fires and TODO-logs correctly, and confirming
signature verification rejects a tampered/forged payload. Run the
delivery commands below, then work through those three checks against
the real app (in Paystack **test mode**) before starting Phase 4. Phase
4 should also treat the `docs/PAYSTACK_CONTRACT.md` §3 amount-validation
gap as a blocking prerequisite, not an optional cleanup.

## 10. Phase 4 additions — Orders Data Model & Payment Confirmation

Binding payment contract: **`docs/PAYSTACK_CONTRACT.md`** (updated in
Phase 4 — the amount-validation gap is closed for the two Showcase
purposes). Supabase was **not touched** in this phase.

### 10.1 Firestore: `orders/{orderId}` — final document shape

Top-level collection. Doc id = Firestore auto-id (`newOrderId()` in
`src/lib/ordersPersistence.ts`). Exactly these **ten** fields are allowed —
`firestore.rules` rejects any other key on create:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Equals the document id (rules enforce it). Stored in the body too, as the brief listed it. |
| `uid` | string | Owner. Equals the creator's `request.auth.uid` (rules enforce). |
| `showcaseItemId` | string | The `showcaseItems` doc id. |
| `showcaseItemTitle` | string | **Not in the brief — added.** Snapshot of the item's title at creation (rules check it equals the item's real title). Needed because once the Supervisor hides an item, regular users can no longer read its document, so an order (esp. a paid one) would otherwise have no name to show. Never edited after creation. |
| `type` | `"code" \| "url" \| null` | `null` when first added (free bookmark). Set when the user clicks a checkout button. |
| `status` | see 10.2 | |
| `amount` | number \| null | **Whole Naira, not kobo** (same unit as `showcaseItems.priceCode/priceUrl`). `null` until `type` is chosen. Rewritten server-side by `initialize.js` from the item's current price right before Paystack is called. |
| `paystackReference` | string \| null | `null` until paid. Set by the webhook (or a Supervisor). |
| `createdAt` | string (ISO) | |
| `updatedAt` | string (ISO) | |

TypeScript: `Order`, `OrderType`, `OrderStatus` in `src/types.ts`.

### 10.2 `status` values and exactly what triggers each transition

Exactly five values exist:

| Status | Set by | Trigger |
|---|---|---|
| `pending_payment` | **Client** (`createOrder`) | User taps "Add to Orders" — free, no charge, `type`/`amount`/`paystackReference` all `null`. Also what an order stays at while the user has chosen a path (`type` set) but not yet paid. |
| `paid` | **Webhook** (`fulfillShowcaseOrder`), or Supervisor override | `charge.success` with `purpose: "showcase_code"` for a matching, still-`pending_payment` order. |
| `awaiting_details` | **Webhook**, or Supervisor override | `charge.success` with `purpose: "showcase_url"` (a URL order still needs Phase 6's intake form). |
| `in_progress` | **Nothing automatic yet** — Supervisor override only | Owned by Phase 6 (intake form submitted -> work begins). |
| `delivered` | **Nothing automatic yet** — Supervisor override only | Owned by Phase 5 (raw-code download) / Phase 6 (custom site handed over). Phase 5 decides whether a code order moves `paid -> delivered` on first download or stays `paid`. |

The UI pill (`getOrderPill`) splits `pending_payment` in two: **"Added"**
(`type === null`) and **"Payment pending"** (`type` set); the rest map
1:1 — "Paid", "Awaiting your details", "In progress", "Delivered".

**Who can write what (firestore.rules `orders` block):**
- Owner **create**: only a free bookmark (always `pending_payment`, nulls),
  for an existing **active** item with a matching title, and only while
  checkout isn't paused.
- Owner **update**: only while `pending_payment`, only `type` + `amount` +
  `updatedAt`; a non-null `amount` must equal the item's real
  `priceCode` (for `code`) / `priceUrl` (for `url`) — read by the rules
  themselves. Or both null (= "choose a different option").
- Supervisor **update**: only `status` + `paystackReference` + `updatedAt`,
  status one of the five values.
- **Read:** the owner (a query must carry `where("uid","==",uid)`) or a
  Supervisor. **Delete: nobody.**
- **No client can ever write `status: "paid"` (or anything past
  `pending_payment`) as an order's owner.** The webhook writes with the
  service account, which bypasses rules.

### 10.3 The payment round trip

1. **Add to Orders** (`ShowcaseView`) -> `createOrder` -> live listener in
   `App.tsx` -> button becomes "In your Orders". One order per item per
   user is enforced in the UI only (auto-ids; the rules don't stop a
   second doc for the same item).
2. **Orders** (`OrdersView`) shows "Get raw code · ₦X" / "Get custom URL ·
   ₦Y" (only the offered ones). Click -> `updateOrderChoice` (`type` +
   `amount`) -> `startShowcaseCheckout(orderId, type)` -> `POST
   /api/payments/initialize` with `{ purpose, metadata: { orderId } }` and
   **no amount** -> redirect to Paystack.
3. **`initialize.js`** -> `resolveShowcaseCheckout` (`functions/_shared/
   showcaseCheckout.js`): checks checkout isn't paused, the order is the
   caller's own, `pending_payment`, `type` matches the purpose, the item is
   active and offers that price; computes `amount = price × 100` from the
   `showcaseItems` doc; writes that price onto the order; Paystack
   `metadata = { uid, purpose, orderId }`, `callback_url = /?orders=complete`.
4. **`webhook.js`** -> `fulfillShowcaseOrder` (transaction): verifies uid /
   type / amount×100 / NGN, then `paid` or `awaiting_details` +
   `paystackReference`. The browser lands on `/?orders=complete`; `App.tsx`
   opens Orders and the live listener shows the new status.
5. Mismatches, duplicate payments and missing orders are reported to
   Operations -> Events (`paystack-order-mismatch`,
   `paystack-duplicate-payment`, `paystack-order-unresolved`, all `high`)
   and the order is left as it was, for a Supervisor to fix in Operations
   -> Orders Management.

Signature verification in the webhook is unchanged and still runs first,
unconditionally. The `"subscription"` branch (and every event with no
`purpose`) is unchanged from Phase 1 — diff-verified: the only lines
removed from `webhook.js` are the Phase 4 TODO block/its comments.

### 10.4 Checkout-enabled switch

`appConfig/checkout-enabled` (`{ value, updatedAt, updatedByUid }`), same
pattern as `showcase-enabled`: `functions/api/admin/set-checkout-enabled.js`
(Supervisor-gated, only writer), `useCheckoutEnabled()` (`{ enabled,
loading }`, missing/erroring doc => enabled), a `CheckoutEnabledSetting`
entry in `AppSettingsPanel` (`id: "checkout-enabled"`), and
`setCheckoutEnabled()` in `operationsActions.ts`. When off: "Add to Orders"
and every pay button are disabled with "Checkout is temporarily paused";
Orders stays visible. It is **enforced server-side**, not just in the UI:
`initialize.js` returns `403 CHECKOUT_PAUSED`, and the `orders` create/update
rules refuse writes. The **webhook is deliberately not gated** — a payment
already in flight still gets fulfilled.

### 10.5 Files

**New:** `src/lib/ordersPersistence.ts`, `src/hooks/useCheckoutEnabled.ts`,
`src/components/operations/OrdersManagementPanel.tsx`,
`functions/_shared/showcaseCheckout.js`,
`functions/api/admin/set-checkout-enabled.js`, `docs/PHASE_4_HANDOFF.md`.

**Changed:** `src/types.ts` (Order types; `"ordersManagement"` section),
`src/components/Workspaces.tsx` (new `OrdersView`; "Add to Orders" in
`ShowcaseView`), `src/App.tsx` (orders state + live subscription;
`?orders=complete` landing; Orders now also loads the active Showcase
items; old local `projects` state removed), `src/lib/paymentsApi.ts`
(`startShowcaseCheckout`), `src/lib/operationsActions.ts`
(`setCheckoutEnabled`), `src/components/OperationsView.tsx`,
`src/components/OperationsSidebar.tsx`,
`src/components/operations/AppSettingsPanel.tsx`,
`functions/api/payments/initialize.js`, `functions/api/payments/webhook.js`,
`firestore.rules`, `docs/PAYSTACK_CONTRACT.md`.

**Deliberately untouched:** `functions/_shared/supabaseFiles.js`,
`supabaseStorage.js`, `cancel.js`, `paystackSignature.js`, the subscription
webhook branch, `chatPersistence.ts`, `showcasePersistence.ts`.
`ProjectItem` (types.ts) and `INITIAL_PROJECTS` (mockData.ts) are now
unused but were left in place to keep this diff small — safe to delete later.

### 10.6 Where this differs from the brief (and why)

- **Extra field `showcaseItemTitle`** on orders (10.1).
- **`ordersPersistence.ts`, not `.js`** — `.ts`, matching
  `chatPersistence.ts` (same call Phase 1 made for `showcasePersistence`).
- **`orders.amount` is written twice**: by the client (as the brief says;
  the rules verify it equals the real price) and again by `initialize.js`
  from the item's current price. The charged amount and the webhook's
  comparison use only the server's value. The client cannot influence
  what is charged even if the rules had a bug.
- **Supervisor override writes straight to Firestore** through the rules
  (same as Showcase Management) rather than through a new admin endpoint.
  Consequence: no `operationsAuditLog` entry is written for overrides.
- **Callback URL** for Showcase purchases is `/?orders=complete` (was
  `/?upgrade=complete`, which nothing reads) so the user lands on Orders.
- **The Phase 1 local "New Project" form is gone.** An order now only comes
  from "Add to Orders".

### 10.7 Notes for Phase 5 and Phase 6

- **Phase 5 (download):** gate on `orders/{id}` having `type === "code"`
  and `status` in `paid` / `in_progress` / `delivered`, `uid` equal to the
  verified token uid — read server-side (service account), never trust the
  client. `showcaseItems.fileRef` is still readable by any signed-in user
  for **active** items (see §3) — if Phase 5 wants it hidden from
  non-purchasers, that section's suggested fix (Supervisor-only doc)
  still applies. `OrdersView` currently shows a placeholder line for `paid`
  ("Your raw code download will be available here soon") — replace it with
  the real download control.
- **Phase 6 (intake form):** an order sits at `awaiting_details` after a
  successful URL payment. The intake form should move it to `in_progress`
  **server-side** (the rules do not let an owner change `status`) — needs
  either a new endpoint or a rules extension you design deliberately.
  `OrdersView` currently shows a placeholder line for `awaiting_details`.
- **Phase 8** must still close the client-supplied-`amount` gap for
  `purpose: "domain"` in `initialize.js` (unchanged, documented in
  `PAYSTACK_CONTRACT.md` §3).

### 10.8 Known limitations (honest list)

- A user who changes their chosen option **after** starting checkout (e.g.
  opens Paystack, goes back, switches path, and then pays the first tab)
  will produce a `type-mismatch` / `amount-mismatch` event; the order stays
  `pending_payment` and the Supervisor must fix it manually. Rare, safe
  (never mis-fulfils), visible in Events.
- Two open checkout tabs paid twice => second payment reported as
  `paystack-duplicate-payment` for a manual refund; not automated.
- If a Supervisor hides an item, unpaid orders for it show "no longer
  available to buy"; paid orders keep displaying (via the title snapshot).
- The server's write of the checked price onto the order (`initialize.js`)
  is a Firestore PATCH; orders are never deleted (rules forbid it), so it
  can't recreate a missing doc in practice.
- Free re-adding: one bookmark per item per user is a UI rule only.

### 10.9 Verification status (as delivered)

Done: read `docs/PHASE_1_HANDOFF.md`, `PHASE_2_HANDOFF.md`,
`PHASE_3_HANDOFF.md`, `PAYSTACK_CONTRACT.md`, `SUPABASE_CONTRACT.md`
context, and `initialize.js`, `webhook.js`, `firestoreClient.js`,
`firestore.rules`, `chatPersistence.ts`, `showcasePersistence.ts`,
`Workspaces.tsx`, `App.tsx`, the Operations panels and the
`set-showcase-enabled` pattern before writing anything. Syntax-checked
every changed/new JS file as an ES module (`node --check`). Type-checked
`src/` with React/Firebase/lucide stubbed as loosely-typed modules: the
error set is identical to the pre-change baseline apart from stub-only
`key`-prop noise. Diffed `webhook.js` against the Phase 3 original to
confirm only the TODO block and comments changed in the subscription/
signature paths.

**Not done — could not be run in the environment this was written in (no
dependencies installed, no network, no Firebase project, no Paystack
account, no Replit shell):** `pnpm build`, `pnpm lint`, the app itself, the
**Firestore rules (never run in the emulator/Rules Playground — the new
`orders` block is the highest-risk untested piece)**, the deployed
functions, and all four Testing Requirements from the brief (raw-code round
trip, custom-URL round trip, Supervisor panel + override, subscription
still works). Run them in Paystack **test mode** and paste back results
before Phase 5.

## 11. Phase 5 additions — Paid Order → File Delivery

This is where Firestore (entitlement) and Supabase (bytes) finally meet
for a customer download. Both binding contracts —
**`docs/SUPABASE_CONTRACT.md`** and this file's own Section 10 — were
read in full before writing anything in this phase; neither was
violated: no Postgres table, RLS policy, or Realtime channel was added,
the exact bucket name and path convention were reused as documented, and
`functions/_shared/supabaseFiles.js`'s upload logic was left untouched.

### 11.1 The download endpoint

**`functions/api/orders/get-download.js`** — `POST /api/orders/get-download`,
body `{ "orderId": "string" }`. Regular-user endpoint (any signed-in
account may call it for their OWN orders — not Supervisor-gated), auth
pattern copied from `functions/api/payments/initialize.js` (Bearer
Firebase ID token via `verifyFirebaseIdToken`; no `checkOriginIntegrity`
call, matching every other non-admin, non-device endpoint rather than
the admin/device pattern that does use it).

Checks, all server-side against the service-account Firestore client
(bypasses `firestore.rules` — see `firestoreClient.js`'s own header):

1. Token verifies -> `uid`.
2. `orderId` matches the same no-`/` id shape `showcaseCheckout.js`
   already validates orderIds with (`isValidOrderId`, reused from there
   rather than duplicated).
3. `orders/{orderId}` exists, `uid` matches the caller, `type === "code"`,
   and `status` is one of `paid` / `in_progress` / `delivered` (see 11.2
   for why this is broader than this phase's brief text, which named
   only `"paid"`).
4. The order's `showcaseItemId` is shape-valid, then
   `showcaseItems/{id}`'s `fileRef` is read and split on its first `/`
   into `showcaseItemId`/`filename` (both segments are already validated
   at upload time — see `docs/SUPABASE_CONTRACT.md`). `active` is
   deliberately **not** re-checked here — a paid order's download must
   keep working even after the Supervisor hides the item from new
   buyers (Section 10.8's existing rule for display applies the same way
   to delivery).
5. `getSignedDownloadUrl` (from `functions/_shared/supabaseFiles.js`,
   Phase 2's function — untouched beyond the Section 11.3 extension
   below) mints a fresh signed URL. Nothing is ever stored or reused —
   every call re-signs, which is the actual "has this user paid" gate.
6. Response: `{ "url": "...", "expiresInSeconds": 600 }`. No other
   detail is ever returned.

Every failure — no such order, someone else's order, a `"url"`-type
order, an unpaid order, a missing file — returns the **identical**
generic `404 { error: { code: "NOT_FOUND", message: "We couldn't find
that download." } }`, so this endpoint can never be used to probe which
order ids exist or whose they are (same "never leak" rule
`docs/SUPABASE_CONTRACT.md` already states for Showcase generally, now
applied to orders too). A malformed `orderId` (fails the shape check
before any Firestore read) gets its own `400 INVALID_REQUEST` instead —
that's a format complaint, not an existence leak, since a malformed id
can never correspond to a real document.

### 11.2 Why the status gate is broader than the brief's literal text

The Phase 5 brief's In Scope item 1 says to check `order.status ===
"paid"`. This phase's own Section 10.7 (written by Phase 4, for Phase 5
to read) already anticipated exactly this decision and recommended
gating on `status in paid / in_progress / delivered` instead, so a
Supervisor's manual override to `"in_progress"` or `"delivered"` (e.g.
for bookkeeping, or because Westly delivered something by hand outside
this flow) can never accidentally cut off a customer's own re-download
of code they already paid for. That reasoning is sound and this phase
follows it: `functions/api/orders/get-download.js`'s
`DOWNLOADABLE_STATUSES` is `{"paid", "in_progress", "delivered"}`, not
just `{"paid"}`. The frontend Download button (11.4) still only ever
*appears* on a `status === "paid"` order, per the brief's literal UI
instruction — the broader gate only matters for a Supervisor-overridden
order accessed some other way (e.g. a future support tool), and costs
nothing in the common case since a code order's `status` is never
automatically moved away from `"paid"` in the first place (11.3).

### 11.3 How delivery is marked (the brief's item 4 decision)

The brief offered two options and asked this phase to choose and
document one: flip `status` to `"delivered"` on first download, or keep
`status: "paid"` and add a separate `downloadedAt` timestamp. **This
phase chose the second.** `orders/{orderId}.downloadedAt` (ISO string) is
stamped by `get-download.js`, once, the first time a download for that
order succeeds (never overwritten after that) — a history field only,
read by nothing and checked by nothing. `status` itself is never touched
by this endpoint. Reasoning:

- It keeps this phase's literal status check (`"paid"`) meaningful and
  stable rather than immediately stale after the very first download —
  the 11.2 broadening exists for defense-in-depth against a Supervisor
  override, not because downloading is expected to change status on its
  own.
- `"delivered"` remains what Section 10.2 already defined it as for
  every other order type: a Supervisor-only manual signal ("nothing
  automatic yet"), not something a click quietly triggers. A code buyer
  re-downloading their file later (lost the first copy, switched
  devices) shouldn't need a Supervisor to intervene, which an
  auto-transition to a terminal-feeling status could otherwise invite
  confusion around.
- `downloadedAt` not being one of the ten fields `firestore.rules`
  enumerates for the `orders` document is fine and intentional: that
  list constrains **client** writes only (owner create/update,
  Supervisor override); this field is written exclusively by the service
  account, which bypasses `firestore.rules` entirely, the same way
  `webhook.js` already writes `status`/`paystackReference` outside that
  enumerated client surface. `firestore.rules` was **not** changed in
  this phase to formally list `downloadedAt` — it's a server-internal
  history field, not something any client ever reads, writes, or
  validates the shape of, so there was nothing for the rules to gate.
- The write is best-effort and non-fatal by design: if it fails, the
  customer still gets their already-minted, already-usable URL. Losing a
  "first downloaded at" timestamp is an acceptable loss; failing an
  already-successful download over a logging write is not.

`OrdersManagementPanel.tsx` (Phase 4's Supervisor override panel)
already supports setting any order — including a `"code"` order — to
`"delivered"` by hand, with no code change needed in this phase: its
status dropdown already iterates `ORDER_STATUSES`, which includes
`"delivered"`, and `updateOrderStatusAsSupervisor` already accepts it.
This is exactly the escape hatch the brief's item 4 asked this phase to
confirm exists ("for cases where Westly delivers something outside the
automated flow") — it was already built in Phase 4 and needed no
touching here.

### 11.4 Frontend: `OrdersView` (`src/components/Workspaces.tsx`)

A `"paid"` order with `type === "code"` now renders a new
`CodeDownloadSection` (same file, new component) instead of the old
"will be available here soon" placeholder line:

- **Download** button — calls `getOrderDownload` (new file, 11.5), opens
  the returned URL with `window.open(url, "_blank", "noopener,noreferrer")`,
  and reveals the deploy guide (11.6) on success. Its own
  loading/error state, scoped to this section only, so a failed or slow
  download never disturbs the rest of the order card (same isolation
  principle `OrderCard`'s own checkout handling already uses).
- **"How do I deploy this?"** toggle — shows/hides the static deploy
  guide without needing a download first (a buyer who already has the
  file from an earlier click can still read the instructions).

A `"paid"` order with `type !== "code"` (the `"url"` path never reaches
`"paid"` in the normal flow — see Section 10.2's status table — but a
Supervisor override could theoretically force it there by mistake) keeps
the old generic "will be available here soon" message rather than
showing a Download button it has no file for. Defensive, matches this
codebase's existing habit of failing toward the least-surprising display
(e.g. `ordersPersistence.ts`'s own `asOrderStatus`/`asOrderType` "fail
closed" comments).

Every other status branch (`awaiting_details`, `in_progress`,
`delivered`) is **unchanged** — Phase 5's Out of Scope explicitly
excludes `type: "url"` orders (Phase 6's), and this phase's brief did
not ask for a Download control on `in_progress`/`delivered` orders even
though `get-download.js` itself would serve one (11.2) if a future phase
wants to add that UI.

### 11.5 New file: `src/lib/ordersDownloadApi.ts`

Frontend client for the endpoint above. `getOrderDownload(orderId):
Promise<{ url, expiresInSeconds }>`, `OrdersApiError` (code + safe
message), modeled directly on `src/lib/paymentsApi.ts`'s
`startShowcaseCheckout` — same Bearer-token-from-`auth.currentUser`
pattern, same `{ error: { code, message } }` parsing — except this
resolves with the URL instead of redirecting the browser, since
`get-download.js` isn't starting an external checkout.

### 11.6 New file: `src/data/deployGuide.ts`

Plain, static content (no dynamic generation, per the brief) — two
`DeployGuideSection` entries (`title` + ordered `steps: string[]`) for
Cloudflare Pages and Netlify, both platforms Westly already uses for his
own Neribo deploys. Nothing in this file reads the purchased file, the
Showcase item, or anything else dynamic — it's the same two lists
rendered for every `"code"` order, exactly as the brief asked ("a small
markdown/text block ... plain content, no dynamic generation").

### 11.7 Extension to `functions/_shared/supabaseFiles.js`

Per the Supabase Continuity Requirement's own item 4 ("if you find the
Phase 2 contract is missing something you genuinely need ... extend
`supabaseFiles.js` consistently with its existing pattern ... do not
build a parallel file"): `getSignedDownloadUrl(env, { showcaseItemId,
filename })` gained one new, optional destructured field —
`expiresInSeconds`. When omitted (every call site that existed before
this phase — `uploadShowcaseFile`'s internal call), behavior is
byte-for-byte unchanged: it falls back to the module's existing
`SIGNED_URL_EXPIRES_IN_SECONDS` (10-year) constant. `get-download.js` is
the only caller that passes it explicitly, at 600 seconds (10 minutes) —
see the "Security Requirements" note in 11.1's file header comment for
why: long enough for a slow connection to finish fetching a multi-MB
zip after the button is pressed, short enough that a URL sitting in
browser history or a shared screenshot doesn't stay usable indefinitely,
unlike the 10-year default that makes sense for the always-visible
chat-image case this module originally served. This is additive only —
no existing behavior, signature requirement, or call site was changed,
and the function's upload logic (`uploadShowcaseFile`) was not touched
at all, honoring this phase's "Do Not Touch" instruction.

### 11.8 Files

**New:** `functions/api/orders/get-download.js`,
`src/lib/ordersDownloadApi.ts`, `src/data/deployGuide.ts`,
`docs/PHASE_5_HANDOFF.md`.

**Changed:** `functions/_shared/supabaseFiles.js` (11.7 extension only —
upload/delete logic untouched), `src/components/Workspaces.tsx` (new
`CodeDownloadSection`; the `"paid"` branch of `OrderCard`'s render, 11.4).

**Deliberately untouched:** `firestore.rules` (no client-facing surface
changed — see 11.3's rules note), `src/lib/ordersPersistence.ts` (the
Supervisor override path Section 10 already built needed nothing new,
11.3), `src/components/operations/OrdersManagementPanel.tsx` (same
reason), `functions/api/payments/*`, `functions/api/showcase/upload-file.js`,
`functions/_shared/checkSupervisorRole.js`, everything under Phase 6–9's
territory (Domains, Chat Neribo, `type: "url"` orders' intake flow).

### 11.9 Known limitations (honest list)

- `downloadedAt` exists only in Firestore, unexposed anywhere in the UI
  (Supervisor panel included) — it's pure audit history for now. A later
  phase that wants to surface "last downloaded" to the Supervisor can
  read it straight off the order document; no migration needed, since
  every order either has it (downloaded at least once) or doesn't
  (never downloaded).
- The signed URL's 600-second expiry is a judgment call, not a value
  from the brief or either contract doc — reasonable for a click-then-
  download flow on an ordinary connection, but a customer who leaves the
  tab open past that window and then clicks a stale link will hit a
  Supabase-side expired-signature error, not a friendly Neribo message
  (the frontend doesn't currently distinguish "URL expired" from any
  other download failure — the "Download" button's own error text is the
  same generic message either way, and simply pressing it again mints a
  fresh URL, which is an acceptable resolution but not an explained one).
- `get-download.js` does not itself rate-limit repeated calls for the
  same order — every click mints a brand-new signed URL (cheap, a single
  Supabase Storage sign request), so a customer double-clicking Download
  just gets two valid links to the same object rather than any error.

### 11.10 Verification status (as delivered)

Done: read `docs/SUPABASE_CONTRACT.md` and this file's own Section 10 in
full before writing anything, per the brief's Role/Architecture Reminder
and Supabase Continuity Requirement; read
`functions/_shared/verifyIdToken.js`, `functions/api/payments/initialize.js`
(the authenticated-endpoint example this phase's auth code follows),
`functions/_shared/showcaseCheckout.js` (the `isValidOrderId`/
`batchGetDocuments`/`patchDocumentFields` patterns this phase reuses),
`functions/_shared/firestoreClient.js`, `functions/_shared/supabaseFiles.js`
in full, `src/lib/ordersPersistence.ts`, `src/types.ts`'s `Order`/
`OrderStatus` types, `src/components/Workspaces.tsx`'s existing
`OrderCard`, `src/components/operations/OrdersManagementPanel.tsx`
(confirmed the Supervisor "mark delivered" override already exists and
needed no changes), and `firestore.rules`' `orders` block (confirmed it
only constrains client writes and needed no changes for a
service-account-only field) before writing anything. Syntax-checked
`functions/api/orders/get-download.js` and the changed
`functions/_shared/supabaseFiles.js` as ES modules (`node --check`, with
`"type": "module"`). Loosely type-checked the changed/new
TS/TSX files with `react`/`firebase/*` stubbed as loosely-typed modules,
same convention every prior phase's handoff describes (no new,
change-specific errors — only the same baseline "implicit any" /
"cannot find module" noise the stub setup itself produces, matching
Section 4/9/10's own verification notes).

**Not done — could not be run in the environment this was written in (no
dependencies installed, no network, no Firebase/Supabase project, no
Replit shell):** `pnpm build`, `pnpm lint`, the actual app, and all four
Testing Requirements from the brief (real Download round trip as a paid
user; direct-Function access with someone else's order id, confirming
denial; confirming `pending_payment`/`awaiting_details` orders can't
download; confirming a Supervisor override to `"delivered"` persists and
displays). Run the delivery commands below, then work through those four
checks against the real app before starting Phase 6.

## 12. Addendum — forced download instead of inline render (post-delivery fix)

Real-world testing surfaced a gap: the Download button (`Workspaces.tsx`'s
`CodeDownloadSection`, §11.4 above) opens the signed URL via
`window.open`, but the signed URL was minted with no
`Content-Disposition` header at all. For a `.html` deliverable
specifically, this meant the browser rendered the file's raw source
inline in the new tab instead of saving it to the customer's device —
exactly wrong for a "Download" button on a paid deliverable.

Fixed by extending `getSignedDownloadUrl` (in
`functions/_shared/supabaseFiles.js`) with a second optional parameter,
`download` — see `docs/SUPABASE_CONTRACT.md`'s updated entry for the
full contract. `get-download.js` now passes `download: filename` so
Supabase adds `Content-Disposition: attachment; filename="..."` to its
response. Both `expiresInSeconds` and `download` are optional and
additive; `uploadShowcaseFile`'s own internal call (inline chat-image-
style URLs) and any other pre-existing caller is unaffected.

**Not re-verified in this environment** (same no-network/no-Replit
limitation as the rest of this phase) — confirm in your own testing that
opening the Download button now actually prompts a file save (or lands
directly in Downloads, depending on browser/OS) rather than opening a
new tab showing the file's contents.

### 12.1 Correction — the fix above was itself broken; here's the real one

Real-device testing (an actual `.html` deliverable, downloaded as a paid
customer) showed §12's fix didn't work: the file still rendered inline.
Root cause — confirmed against Supabase's own docs (Storage → Serving
assets → Downloading) — `download` is a **query parameter on the final
signed URL** (`?download` / `&download=filename`), never a field
Supabase's `/object/sign/{bucket}/{path}` endpoint accepts in its
request body. §12's fix put it in the body; Supabase silently ignored
it, so no `Content-Disposition` header was ever actually produced.

**Why the earlier "it works!" screenshot (a `.zip` file, §12 above) was
a false positive:** browsers never try to render a `.zip` inline
regardless of any header — they trigger a save unconditionally, since
zip isn't a browser-renderable type. That test could never have caught
this bug; only a browser-renderable type (`.html`, an image) actually
exercises whether `Content-Disposition: attachment` is present. Worth
remembering for Phase 6+: **testing a download flow with a zip alone is
not sufficient** — test with an `.html` or image deliverable too.

The real fix, applied directly in `functions/_shared/supabaseFiles.js`'s
`getSignedDownloadUrl`: the `download` field is removed from the sign
request's JSON body entirely; instead, after Supabase returns
`signedURL` (which already has its own `?token=...` query string), this
function appends `&download` or `&download=<encoded filename>` onto
that URL directly, before returning it. `get-download.js` needed no
change — it already just calls `getSignedDownloadUrl(..., { download:
filename })`; only where that parameter got used inside
`supabaseFiles.js` was wrong. `docs/SUPABASE_CONTRACT.md`'s
`getSignedDownloadUrl` entry has been corrected to match.

**Still not verified against your live deploy** — this correction was
made and syntax-checked in the same no-network environment as before.
Please re-test the same `.html` order download after deploying this and
confirm it actually saves now.

## 13. Phase 6 additions — Custom-URL clone-details intake

Firestore only. No Supabase, no Paystack/webhook change, no new Cloudflare Function, nothing under Phase 5's `type: "code"` flow. Read in full before writing anything: this file's Sections 10–12, `firestore.rules`, `src/lib/ordersPersistence.ts`, `src/components/Workspaces.tsx`, `src/components/operations/OrdersManagementPanel.tsx`. Read for the visual pattern only (not in full): `ChatView.tsx`'s assistant-message styling and `SettingsModals.tsx`' `ModalWrapper`.

### 13.1 The two decisions the brief left to this phase

**Where the answers live: an object on the order — `orders/{orderId}.cloneDetails` — not a subcollection.**
- It is small and bounded (worst case ≈ 7,400 characters in total), nowhere near the 1 MiB document limit.
- It has to be written in the *same* write that flips `status` to `in_progress`. One `updateDoc` on one document is atomic and needs one rules evaluation. A subcollection would need a batch across two paths and cross-document rules (`getAfter`/`exists`) to keep "details exist ⇔ status moved" true.
- It is read for free: the customer's live orders listener (`App.tsx`) and the Supervisor's `useRealtimeFeed` already load the order document, so neither needed a new query, listener, index or collection-group rule.

**How the write is authorised: `firestore.rules`, straight from the client — no new Function.** The brief allowed either. Rules were chosen because they are the established pattern for owner writes on `orders` (Phase 4), they keep the write atomic with the details, and they add no endpoint or deploy surface. The trade-off is that every validation lives in rules *and* in the client (kept in sync by hand; see 13.4) and that the rules are, again, **not yet exercised in the emulator** (13.9).

**Form style: a guided, one-question-at-a-time flow in Neribo message bubbles** (same mark + bubble look as ChatView's assistant messages, same field/button classes as the Operations panels), ending in a review step. It is **not** wired to the AI model — the questions are fixed, so there is no quota spend, no failure mode when the AI is down, and no user text ever reaches a prompt.

### 13.2 The exact `cloneDetails` shape (Phase 7: this is what you read)

```ts
// src/types.ts
export interface CloneDetails {
  siteName: string;        // required, 1–120 chars
  purpose: string;         // required, 1–1500 chars  (what the site is for)
  sections: string;        // required, 1–1500 chars  (sections / pages wanted)
  branding: string;        // ALWAYS present; "" when skipped; ≤ 1500 chars (text / links, no files)
  exampleSites: string[];  // ALWAYS present; 0–5 entries; each an http(s) URL, 1–500 chars
  contact: string;         // required, 1–300 chars   (free text: email / phone / WhatsApp)
  submittedAt: string;     // ISO; always equals the order's `updatedAt` at submission
}
// Order (also in src/types.ts) gained:  cloneDetails?: CloneDetails | null;
```

In Firestore it is a **map field named `cloneDetails` on `orders/{orderId}`**, with exactly these seven keys (the rules reject any other key). It is **absent** until the customer submits. Every order document now has either the ten Phase 4 fields, or those plus `cloneDetails` (and, for a downloaded code order, the server-only `downloadedAt` from Phase 5). `toOrder()` (`src/lib/ordersPersistence.ts`) now returns `cloneDetails: CloneDetails | null`, normalized: missing/garbled ⇒ `null`; `exampleSites` is filtered to valid http(s) links only, so anything rendered as an `href` can never be a `javascript:` URL.

To show it: `CloneDetailsReadOnly` (`src/components/OrderIntake.tsx`) renders a `CloneDetails` read-only, as plain text plus validated links — reuse it in Phase 7 rather than re-rendering fields by hand. Treat every field as **untrusted customer input** (it is length-capped and stripped of control/bidi characters, but it is still whatever the customer typed); `contact` in particular is unverified free text.

### 13.3 Status lifecycle — what changed from Section 10.2

Only one row changes: **`in_progress` is now also set by the order's owner**, by submitting the intake form. Everything else in 10.2 stands.

| Status | Set by | Trigger |
|---|---|---|
| `awaiting_details` | Webhook (or Supervisor override) | unchanged — `charge.success` for `showcase_url` |
| `in_progress` | **Owner, via the intake form** (or Supervisor override) | `awaiting_details` → `in_progress` together with `cloneDetails`, one atomic write |
| `delivered` | Supervisor override only | unchanged — Phase 7 (Chat Neribo) is the natural place to automate it |

**Rules change (`orders` block, third `allow update` alternative, `isValidOwnerIntake` + `isValidCloneDetails`):** the owner may update an order only if **all** of these hold — old `type == 'url'`; old `status == 'awaiting_details'`; only `status`, `cloneDetails`, `updatedAt` change; new `status == 'in_progress'`; `cloneDetails` has exactly the seven keys with the type/length limits above, at most 5 example links each matching `https?://.+`; `cloneDetails.submittedAt == updatedAt`. Consequences worth knowing:
- It works **once**: after it lands, old `status` is `in_progress`, so the same write is refused — the owner can't resubmit or overwrite.
- It can't be used on a `code` order or an unpaid order, and can't set any status other than `in_progress`.
- It is **not** gated on `isCheckoutOn()`: payment is already confirmed, and pausing checkout must not strand a paying customer's intake. (Creating/choosing/paying still is gated, unchanged.)
- The Supervisor override (`status` + `paystackReference` + `updatedAt`) and the webhook are unchanged and don't touch `cloneDetails`. A Supervisor who sets an order back to `awaiting_details` re-opens the form for the customer, **pre-filled** with their earlier answers; resubmitting replaces `cloneDetails`.
- Delete is still nobody; read is still owner-or-Supervisor, so `cloneDetails` (including contact details) is visible only to the customer and Supervisors.

### 13.4 Sanitizing and limits (Security Requirements)

- **Limits** live in `CLONE_DETAILS_LIMITS` (`src/lib/ordersPersistence.ts`) and are mirrored literally in `isValidCloneDetails` in `firestore.rules` — change both together. The form's inputs also carry `maxLength` and a live character counter.
- **Cleaning** (`sanitizeCloneDetailsInput`, pure, runs before every Next and again on submit): normalizes newlines, strips control characters, C1 controls, zero-width and bidirectional-override characters (which can make text/links display as something they aren't), collapses whitespace in single-line fields, trims. Example-site input is split on whitespace/commas, `example.com` becomes `https://example.com`, anything with another scheme (`ftp://`, `javascript:` …) or without a dotted host is refused, duplicates are dropped, more than 5 or any over 500 chars is refused.
- **Rendering**: all values render as React text (escaped); the only anchors are validated http(s) example links with `rel="noopener noreferrer nofollow"`.
- **Ownership**: enforced by rules (`resource.data.uid == request.auth.uid`), mirroring Phase 4's per-uid pattern; the client cannot pick another uid because `uid` isn't writable and isn't in the diff.
- The rules count **characters**; the client's `.length` counts UTF-16 units, which is never smaller, so anything the client accepts, rules accept. (If rules ever turned out to count bytes, non-ASCII text near a limit would be refused — see 13.9.)

### 13.5 UI behaviour

**Customer (`OrdersView` → `OrderCard`, `src/components/Workspaces.tsx`; form in the new `src/components/OrderIntake.tsx`):**
- The form renders only when `order.type === "url"` **and** `status === "awaiting_details"`. A `code` order at `awaiting_details` (only reachable by a Supervisor override) keeps the old placeholder line.
- Six questions — site/business name, what the site is for, sections/pages, existing branding (optional, "links or describe it — files can't be uploaded here"), example sites (optional, one link per line), contact for follow-up — then a review step with per-answer Edit. Back/Next, Skip on the optional two, Enter advances on single-line fields.
- Submitting saves `cloneDetails` + `status: "in_progress"` in one write. On success the card shows, **once**: "Details received — thank you! Your deployment link will be ready within 1–3 hours, and you'll be notified." plus a collapsible read-only "Your submitted details".
- **Why the card has `intakeStarted` state:** the live listener flips `status` to `in_progress` the instant the write is applied *locally*, before the server confirms. Without it the form would unmount mid-submit — losing the confirmation, or (if the server then rejects) the typed answers. `intakeStarted` keeps the form mounted; on a rejection the SDK rolls the status back, the form shows a safe error with every answer intact.
- **After a reload / later visit** the confirmation is gone by design ("exactly once"); the `in_progress` card shows "We're working on your order." plus the collapsible read-only submitted details. The form never reappears and can't be resubmitted.

**Supervisor (`OrdersManagementPanel.tsx`, Phase 4's panel — no new section):** any order with `cloneDetails` shows a read-only "Submitted site details" block on its row — open by default while `In progress`, collapsed once it moves on. An `in_progress` URL order with no details (status set by hand) says so.

### 13.6 Files

**New:** `src/components/OrderIntake.tsx` (`OrderIntakeForm`, `CloneDetailsReadOnly`, `SubmittedDetailsToggle`), `docs/PHASE_6_HANDOFF.md`.

**Changed:** `src/types.ts` (`CloneDetails`; `Order.cloneDetails?`), `src/lib/ordersPersistence.ts` (`CLONE_DETAILS_LIMITS`, `sanitizeCloneDetailsInput`, `toCloneDetails`, `submitCloneDetails`; `toOrder` now carries `cloneDetails`; header comment), `src/components/Workspaces.tsx` (`OrderCard` wiring only), `src/components/operations/OrdersManagementPanel.tsx` (read-only block only), `firestore.rules` (`orders` block only — **must be published**, see 13.9).

**Deliberately untouched:** `functions/**` (payments, webhook, `get-download.js`, admin), `docs/PAYSTACK_CONTRACT.md`, all Supabase code, `App.tsx` (the existing orders listener already delivers `cloneDetails` via `toOrder`), `createOrder`/`updateOrderChoice`/`updateOrderStatusAsSupervisor`, `CodeDownloadSection` and the whole `"code"` path.

### 13.7 Notes for Phase 7 (Chat Neribo / Supervisor messaging)

- **The "you'll be notified" promise is not backed by anything yet.** The confirmation text and the 1–3 hour estimate are shown to the customer, but Phase 6 sends no notification (out of scope). Phase 7 has to deliver that, or the copy should be softened until it does.
- **Westly isn't alerted when details arrive.** Nothing writes a Supervisor notification/event on submission (a customer client can't call `notify()` — that collection is Supervisor-write-only). Today he finds them by filtering Operations → Orders Management to "In progress". A server-side hook (or Phase 7's messaging view surfacing new `in_progress` orders) is the fix; the rules would need no change if it is written by a Function/service account.
- To message the customer from an order, the order's `uid` is the account; `cloneDetails.contact` is only a free-text hint and may not match the account email.
- Moving an order to `delivered` is still a manual Supervisor override.

### 13.8 Known limitations (honest list)

- After submitting, the customer cannot edit their answers in the app (stated on the review step). A Supervisor can re-open the form by setting the order back to `Awaiting details` (pre-filled).
- Orders that were already `in_progress` before this phase have no `cloneDetails`; the panel says so rather than showing an empty block.
- The write is a normal Firestore write with no persistence layer: if the customer closes the tab before the server acknowledges it, it can be lost (the form stays on "Submitting…" and shows a "taking longer than usual" hint after 15 s). The order then simply remains `awaiting_details` and the form is still there on return.
- `contact` is unverified free text; example-site links are checked for shape, not reachability.
- Only one intake per order is enforced by rules; a Supervisor re-opening an order is the only way to a second.

### 13.9 Verification status (as delivered)

Done, in the environment this was written in:
- Whole-`src/` type-check with `react`, `firebase/*`, `lucide-react` stubbed: no errors attributable to the new/changed code (only the same stub-only noise as earlier phases — implicit-`any` event params, `key` prop, Firestore call types not actually checked).
- Unit run (Node, Firestore stubbed) of `sanitizeCloneDetailsInput` (trimming, newline collapsing, bidi/control stripping, required/too-long fields, URL normalization/dedupe, refusal of `javascript:`/`ftp:`/`data:`/bare words/6th link/over-long link), `toCloneDetails`/`toOrder`, and `submitCloneDetails` (exact write body — only `status`/`cloneDetails`/`updatedAt`, exactly seven `cloneDetails` keys, `submittedAt == updatedAt`; no retry after a first-attempt permission denial; a denied retry that actually landed is treated as success).
- Headless-Chromium run of the real `OrdersView` with a fake Firestore that reproduces the SDK's optimistic listener update: form only on the awaiting-details URL order (not on the code order, not on the in-progress one); validation messages; full submit → confirmation shown exactly once, form gone, a single write even on double-click; saved answers viewable read-only and rendered as text (an HTML-looking site name stays text); server rejection → error shown, answers kept, status back to "Awaiting your details", no false confirmation.

**Not done — not possible here (no dependencies installed, no network, no Firebase project, no Replit shell):** `pnpm build`, `pnpm lint`, the real app, **the new Firestore rules (never run in the emulator or Rules Playground — the new `isValidOwnerIntake` / `isValidCloneDetails` are the highest-risk untested piece, and they are not live until published)**, and the four Testing Requirements from the brief against real Firestore. Suggested Rules Playground cases for the owner of a `url` order at `awaiting_details` (all `update` on `orders/{id}`): valid payload → **allow**; same payload on a `code` order → deny; same payload after the order is already `in_progress` → deny; another user's uid → deny; an extra key such as `amount` in the same write → deny; `status: "delivered"` → deny; `siteName` of 121 characters → deny; an `exampleSites` entry of `javascript:alert(1)` → deny; six `exampleSites` → deny; `cloneDetails.submittedAt` different from `updatedAt` → deny.

### 13.10 Manual test checklist (against the real app, Paystack test mode)

1. Pay for a URL-type Showcase item → order shows "Awaiting your details" and the guided form; a code-type order never shows it.
2. Complete the form → confirmation appears once; pill becomes "In progress"; Firestore shows `status: "in_progress"` and the seven-key `cloneDetails` with `submittedAt == updatedAt`.
3. Reload → no form, no confirmation, "We're working on your order." with "Your submitted details" expandable.
4. Operations → Orders Management → the order shows "Submitted site details" open with the same answers.
5. Try the same write again from the console / Rules Playground → denied. Try to exceed a limit → denied.
