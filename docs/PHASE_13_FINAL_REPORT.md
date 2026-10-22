# Phase 13 Final Report — Migration Defaults & Full Re-Verification

> **Superseded (Phase 8 provider-masking sweep).** This report's "Provider
> outage fails gracefully" section below describes `functions/_shared/groqChat.js`,
> which was later replaced by the fully masked `functions/_shared/intakeChat.js`
> (`IntakeCallError`, `callIntakeJson`) and removed from the codebase — it was
> unused dead code by the time of the masking sweep. This page is kept
> as-written for historical accuracy.

**Method and limits.** Same posture as Phase 9: this was a static read of the
real Phases 10–12 code (every handoff, `firestore.rules`, both new
Functions, the shared logic files, every component and lib file they touch)
against the actual final codebase — not a rebuild of any prior phase's
claims. I had no network access and no installed dependencies, so **nothing
was executed against Firebase, Groq, Paystack or Telegram**, and I did not
run `pnpm build` myself. One thing this sandbox *did* let me check
mechanically: `node --check` against every `.js` Function file (no syntax
errors) and a cross-reference of every `import { ... }` in the Phase 11/12
files against the real `export`s in the modules they come from (all
resolve — see the table below). Everything else marked "Verified" below
means "confirmed by reading the real code", not "seen running". The manual
walkthroughs at the bottom still need Westly to run them.

One artifact worth noting up front: the `dist/` folder included in this zip
already contains Phase 12 strings (`telegramMessageId`, "Awaiting your
images", the Orders Management image checklist text) and is newer than the
`.tsx` source files it was built from. That means a real `pnpm build`
**has** succeeded on this exact codebase at some point since Phase 12 — it
wasn't run by me in this pass, but it did happen, which answers part of
Phase 11 and 12's "NOT verified — pnpm build" item. It doesn't confirm
`pnpm lint` or a *fresh* build after any change in this report (there were
no code changes in this report — see below), so still re-run both after any
future edit.

## Item 1 — Backfill defaults for pre-Phase-10 Showcase items

Verified by reading, on both the brief and the image-slot side:

- `src/lib/showcasePersistence.ts`'s `toShowcaseItem` reads `detailsBrief`
  and `imageSlots` tolerantly and returns `null` for either when absent —
  an old item never crashes the loader.
- `functions/_shared/orderIntake.js`'s `resolveBrief()` treats a `null`,
  empty, whitespace-only, or marker-only brief identically: it falls back to
  the built-in `DEFAULT_BRIEF` (four generic checklist items). An old item
  therefore still gets a working intake conversation, not an empty
  checklist or a crash.
- `functions/_shared/cloneImages.js`'s `usableImageSlots()` returns `[]` for
  an absent/null/non-array `imageSlots`, and `functions/api/orders/
  intake-chat.js`'s `countImageSlots()` (the function that decides
  `awaiting_images` vs `in_progress` on completion) uses the exact same
  three-part test (object, string label, non-blank after `trim()`) — the two
  never disagree on what counts as a "real" slot. An old item with no
  `imageSlots` therefore completes straight to `in_progress`, exactly like
  the original Phase 6 behaviour, with no `awaiting_images` detour and no
  dead-end image-upload screen.

Confirmed true in the code's actual branching, not just its stated intent.
No gap found; nothing changed.

## Item 2 — Old and new orders coexisting forever

Verified by reading the renderer, not just the handoff's description:

- `src/lib/ordersPersistence.ts` has three independent, tolerant readers —
  `toCloneDetails`, `toCloneDetailsV2`, `toCloneImages` — each returning
  `null`/`[]` on anything malformed rather than throwing, so a hand-edited
  or legacy document degrades to "nothing usable" instead of crashing the
  page.
- `OrdersManagementPanel.tsx`'s `OrderRow` renders **both** blocks
  independently and correctly: `order.cloneDetailsV2 && <CloneDetailsV2ReadOnly>`
  and `order.cloneDetails ? <CloneDetailsReadOnly> : …`. An old order (only
  `cloneDetails`) shows the old block; a new order (only `cloneDetailsV2`)
  shows the new block; an order with neither and `status === "in_progress"`
  shows the "status was set by hand" note. There is no code path where
  having one shape suppresses correct display of the other, and no path
  where an order with neither shape is silently blank.
- `Workspaces.tsx` (the customer-facing side) keys off `order.type`,
  `order.status`, and its own `intakeStarted`/`imagesStarted` flags — never
  off which clone-details shape is present — so old and new orders take the
  same code path there; only the Supervisor panel branches on the shape.

No coexistence bug found.

## Item 3 — Full end-to-end walkthrough (Paystack test mode)

**Not run** — no network access in this sandbox, so this is a code trace,
not an observed run. Traced the full chain instead:
`OrderIntakeChat` (start → message loop → `done` handling) →
`intake-chat.js` (auth → lock → model turn → self-claim check → independent
audit → `writeCompletion`) → order flips to `awaiting_images` (item has
slots) → `OrderImageUpload` mounts (`Workspaces.tsx`'s status-gated JSX) →
`cloneImagesApi.ts` GET then per-slot POST → `upload-clone-image.js` (auth →
order/slot checks → Telegram `sendDocument` → transactional record + last-
slot completeness check) → order flips to `in_progress` → both the chat and
the upload component's "finished" branches render off the **live** order
status (`Workspaces.tsx` keeps them mounted via `intakeStarted`/
`imagesStarted`) → `OrdersManagementPanel.tsx` shows the Q&A block and the
per-slot received/missing checklist. Every step of that chain checked out
in isolation (see the file-by-file notes above and below); the chain as a
whole still needs a real run. **Please do the five-step walkthrough from
the Phase 13 brief in Paystack test mode** — pay for a custom URL on an
item with a multi-item brief and 2+ slots, finish the chat, upload every
slot, confirm the Telegram messages, confirm `in_progress`, confirm
Orders Management.

## Item 4 — Telegram credentials never in client code

Grepped the **built** `dist/` output (not just `src/`), the way Phase 9
checked other secrets:

- `grep -r "TELEGRAM_BOT_TOKEN\|TELEGRAM_CHAT_ID"` across `dist/assets/*.js`
  and `dist/server.cjs` → no hits.
- A pattern search for Telegram's own token shape
  (`\d{6,12}:[A-Za-z0-9_-]{30,}`) across the same files → no hits.
- The only "telegram" text in the built bundle is UI copy ("Customer images
  (in Telegram)", "…not in the app. Search Telegram for…") and the
  `CloneImageEntry` field names (`telegramMessageId`, `telegramFileId`) —
  never a value.
- In the source, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are read only in
  `functions/api/orders/upload-clone-image.js`, only from `env`, and every
  place that logs a Telegram error text runs it through `scrubSecret()`
  first (`functions/_shared/cloneImages.js`), including the one path that
  logs a raw `fetch` failure message.

Clean.

## Item 5 — Supabase usage completely unaffected

- Grepped every new/changed Phase 10–12 file for the word "supabase": the
  only hits are comments in `upload-clone-image.js` and `cloneImages.js`
  **disclaiming** Supabase use, plus one boilerplate line in
  `OrderImageUpload.tsx`'s header comment ("routed to Telegram, NOT
  Supabase"). None of them are imports.
- Confirmed no Phase 10–12 file imports `supabaseFiles.js` or
  `supabaseStorage.js`; the only importers of those two modules are the
  pre-existing `images/store.js`, `orders/get-download.js`, and
  `showcase/upload-file.js` — unchanged.
- `docs/SUPABASE_CONTRACT.md`'s two buckets (`neribo-images`,
  `neribo-showcase-files`) and their owning files are exactly what they
  were before Phase 10.

Clean — comes back exactly as it should.

## Item 6 — Graceful provider-outage handling and enforced caps

- **Caps are enforced before any provider call, not just described.**
  `intake-chat.js` checks `state.userTurns >= state.maxUserTurns ||
  state.providerCalls >= state.maxProviderCalls` (and a second, narrower
  check for `providerCalls` alone, which also covers the `"start"` action)
  *before* `runAssistantTurn()` is ever invoked. Hitting either cap routes
  to `capOut()`, which marks `capReached: true`, raises a `medium`
  Operations event, and does **not** advance the order — matching the
  brief's "not just described" requirement.
- **Provider outage fails gracefully.** `groqChat.js`'s `callGroqJson`
  normalizes every failure mode (missing key, network error, timeout,
  non-2xx, unreadable/empty body) into a typed `GroqCallError`, logs the
  real detail server-side only, and reports an Operations event at the
  right severity (`high` for a missing key, `medium` for the rest). Back in
  `intake-chat.js`, a thrown `GroqCallError` from the assistant turn leaves
  the transcript **unchanged** (the customer's just-typed message is never
  stored) and returns a calm, Supervisor-editable failure message with a
  502 — the client is built to keep the typed text and retry with the same
  `messageId`, so nothing is lost on a flapping provider.
- The two-call safety net (repair-then-fail for a malformed JSON turn,
  retry-then-fail for a malformed audit) both terminate in a
  `GroqCallError` rather than looping forever or silently returning a false
  "done".

Confirmed both requirements hold in the actual code, not only in the
handoff's prose.

## Item 7 — Genuine integration bugs

**None found.** I looked specifically for the kinds of thing Phase 9 found
last time (a missed status branch, a field-name mismatch between phases, a
broken import) and did not find one:

- Every `import { ... }` in `intake-chat.js` and `upload-clone-image.js`
  resolves to a real `export` in the module it names (checked
  mechanically, not just by eye).
- `countImageSlots` (Phase 11, decides the status transition) and
  `usableImageSlots` (Phase 12, decides the real slot list) use identical
  criteria for what counts as a slot — verified line by line, not assumed
  from the handoffs saying so.
- `ORDER_STATUSES` / `ORDER_STATUS_LABELS` / `getOrderPill` all have a
  `"awaiting_images"` entry; `isValidSupervisorOverride` in
  `firestore.rules` includes it in the allowed list; nothing was missed.
- `SHOWCASE_INTAKE_LIMITS.maxImageSlots` (12) and `firestore.rules`'
  `isValidImageSlotAt` calls (indices 0–11, i.e. 12) agree; the
  `ShowcaseManagementPanel.tsx` slot/description inputs use the same
  constant object for their `maxLength`s.
- The customer-facing pill for `awaiting_images` ("Awaiting your images")
  and the Supervisor-facing label ("Awaiting images") are deliberately
  different strings for different audiences, not a typo.
- The areas Phase 11 and 12 each declared "deliberately unchanged"
  (`domainRequests` rules, `DomainsView.tsx`, `App.tsx`, `SidebarDrawer.tsx`,
  `ChatNeriboPanel.tsx`, `get-download.js`, `webhook.js`) contain zero
  references to `awaiting_images` — confirmed by grep, not taken on faith.

Nothing here needed a fix, so nothing was changed.

## Firestore rules — read against the real file

- `orders/{orderId}`: `cloneDetailsV2` is absent from every `hasOnly()`
  list on every update path (`isValidOwnerChoice`, `isValidOwnerIntake`,
  `isValidSupervisorOverride`), so any write that includes it is rejected
  by the field-set check alone — there is no owner or Supervisor path for
  it, matching Phase 11's stated design. `cloneImages` gets its own
  explicit, unconditional `!... .affectedKeys().hasAny(['cloneImages'])`
  guard on top of that, matching Phase 12's stated design.
  `isValidSupervisorOverride` accepts `'awaiting_images'` as one of six
  valid statuses.
- `orderIntake/{orderId}` has no `match` block of its own anywhere in the
  file, so it falls through to the file's final
  `match /{document=**} { allow read, write: if false; }` — denied to every
  client, service-account-only, exactly as both this phase's and Phase 11's
  brief require.
- I could not exercise any of this against the real rules engine (no
  emulator, no network) — my read is a textual one. **Please still run the
  five checks Phase 12 asked for in the Rules Playground** (owner write of
  `cloneImages` denied; owner write of `cloneDetailsV2` denied; a
  Supervisor override to `awaiting_images` allowed; a client read/write of
  `orderIntake/*` denied) plus Phase 10's six-case list for
  `detailsBrief`/`imageSlots` on `showcaseItems`. None of this has changed
  since Phase 10–12 shipped, so if it passed then it should pass now, but
  "should" isn't "did".

## Not verified — needs a real run

- `pnpm build` (fresh) and `pnpm lint`. The bundled `dist/` shows a build
  **has** succeeded on this codebase before (see the note at the top), but
  that's not the same as a build in front of me right now.
- Everything Paystack, Groq, and Telegram: the five-step walkthrough (item
  3 above), a real provider outage (I read the code path, I didn't trigger
  it), and an actual Telegram delivery with the 4-line caption.
- Firestore Rules Playground (item above).
- Phone layout/behaviour for `OrderIntakeChat` and `OrderImageUpload`
  (keyboard, scrolling, the file picker/camera, a slow network) — this is
  Westly's primary environment and nothing here was seen rendered.
- Empty states I traced but didn't watch render: an item with no
  `imageSlots`, an item with no `detailsBrief`, a `capped` conversation, a
  `SLOTS_CHANGED` mid-upload, a load failure on either component.
- Everything from Phase 9's own "Not verified" and "Flagged for Westly's
  decision" sections that Phases 10–12 didn't touch (upload size cap on the
  older Showcase-file upload path, the mobile download-popup risk, account
  deletion leaving orders/domainRequests/chatNeriboMessages behind, the
  domain "Send pricing" race, domain price snapshotting) — still open,
  still not this phase's job to decide.
- Phase 11 and 12's own still-open decisions, carried forward unchanged
  (not redecided here, per the brief's "document and ask" rule):
  1. Whether to delete the old `isValidOwnerIntake` clause now that the AI
     flow is live (Phase 11) — leaving it means a customer using dev tools
     could still skip the chat via the old fixed-shape path.
  2. Whether image replacement should ever be allowed once a slot is
     received (Phase 12) — currently locked, by design.
  3. Whether a rules-level validator is wanted for `cloneDetailsV2` /
     `cloneImages` even though no write path would use it (Phase 11 and 12
     both recommended against, but didn't decide unilaterally).

## Destructive operations

None. No Firestore collection was dropped, reset, or bulk-deleted; no order
was migrated or altered; nothing was pushed, deployed, or published.

## Bottom line

Phases 10–12, as actually delivered, hold together: the defaults for
pre-existing Showcase items work in the running logic (not just in stated
intent), old and new orders render correctly side by side forever, no
Telegram secret reaches client code, Supabase is untouched, and the AI
intake's outage handling and per-order caps are real enforcement, not
documentation. I did not find a bug to fix, so **no code was changed in
this phase** — there is nothing to zip. The project is left exactly as it
was, in the coherent state Phases 10–12 left it in, with the "not
verified" list above being the honest gap between that and a fully proven
build.
