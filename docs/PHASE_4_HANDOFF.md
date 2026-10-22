# Phase 4 Handoff — Orders Data Model & Payment Confirmation (carries forward Phases 1–3's content)

**Phase 5: read this before touching anything.** Everything through the second "Section 9" (Phase 3's Paystack addendum) is carried forward from Phases 1–3 **unedited** — where Phase 4 changed something those sections describe, Section 10 says so explicitly rather than rewriting history. **Section 10 is new in Phase 4** and is the part to read first.

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
