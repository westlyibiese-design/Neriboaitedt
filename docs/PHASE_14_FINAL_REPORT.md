# Phase 14 Final Report — Close the Intake Bypass, Allow Image Replacement

**Method and limits.** Same posture as Phases 9 and 13: static read of the
real code (every relevant handoff, `firestore.rules`, both touched
Functions, the shared logic file, every component that touches
`cloneImages`/`cloneDetails`) against the actual codebase in the zip, not a
rebuild of prior claims. No network access and no installed dependencies in
this sandbox, so **nothing was executed against Firebase, Telegram or a real
browser**, and `pnpm build`/`pnpm lint`/the Firestore Rules Playground were
not run by me. What this sandbox *did* let me check mechanically:
`node --check` against both edited `.js` Function/shared files (no syntax
errors), a manual brace/paren/bracket balance check on every edited `.ts`/
`.tsx` file (all balanced), a cross-reference of every changed `import`
against the real `export`s in the modules it comes from, and a small
standalone test script exercising the new `latestVerifiedEntryPerSlot` /
`allSlotsFilled` logic in isolation (8 assertions, all passing — see the
"Verified" note under Task B.1). Everything else below is "confirmed by
reading the real code", not "seen running" — **the manual Testing
Requirements from the brief still need Westly to run them for real**, most
importantly the two Firestore-rules-shaped ones (A) and the four-scenario
replacement walkthrough (B), neither of which can be faked from a static
read.

---

## Task A — close the legacy intake bypass

**1. `firestore.rules`** — removed the `isValidOwnerIntake` function and its
`allow update` disjunct on `match /orders/{orderId}`. There is now exactly
one owner-write path that can touch `status` on a `type: "url"` order
(`isValidOwnerChoice`, unrelated — that's the checkout/payment-intent path),
plus the narrow `cloneImages` append path (Phase 12, untouched) and the
Supervisor override. No owner-write path can set `cloneDetails` (old shape)
or move `awaiting_details` → `in_progress` directly any more. `isValidCloneDetails`
and `isValidExampleSiteSlot` are left in the file — they're now unused by any
rule, but rules files aren't compiled/linted for unused functions, and
removing them wasn't asked for or necessary to close the bypass. Rewrote the
long Phase 6/11/12 explanatory comment block above the `orders` match (it
described the now-removed path as current) and added a Phase 14 note
explaining what was removed and why, and confirming the ONLY way an order
still reaches `in_progress`/`awaiting_images` from `awaiting_details` is
`functions/api/orders/intake-chat.js`'s service-account write, which bypasses
rules entirely and is unaffected.

**2. `src/lib/ordersPersistence.ts`** — removed `submitCloneDetails()` and
its two private helpers (`isPermissionDenied`, `intakeLanded` — both existed
solely to support it, so removing them isn't a separate refactor, it's the
same cut). This left the `getDoc` import unused (it was ONLY used inside
`intakeLanded`), so I removed that import too, otherwise this would fail a
TypeScript "unused import" check. `CLONE_DETAILS_LIMITS`, `CloneDetailsInput`/
`Field`/`Errors`/`Value`, `sanitizeCloneDetailsInput`, `parseExampleSites`,
`cleanText`, and `toCloneDetails` are all untouched — they're read/display-
side logic for orders that already have old-shape `cloneDetails`, which must
keep rendering correctly forever. Updated the surrounding comments (the file
header's field-mutation rules, the PHASE 6 section header, the
`sanitizeCloneDetailsInput` and `cloneDetailsV2` doc comments) so nothing
still describes `submitCloneDetails` as live.

**3 & 4. `src/components/OrderIntake.tsx` / `Workspaces.tsx`** — **no code
change was needed here.** I read both files fully before touching anything
else: Phase 11 already fully replaced the old fixed-step form
(`OrderIntakeForm`) with the AI chat (`OrderIntakeChat`) in `OrderIntake.tsx`
— there is no wizard UI, no `submitCloneDetails` call, and no
`sanitizeCloneDetailsInput` call left in that file at all (only
`CloneDetailsReadOnly` / `CloneDetailsV2ReadOnly` / `SubmittedDetailsToggle` /
`SubmittedAnswersToggle` / `OrderIntakeChat` remain, all read/display or the
chat itself). `Workspaces.tsx` only imports and renders `OrderIntakeChat`. A
repo-wide grep for `OrderIntakeForm` and `submitCloneDetails` outside
`ordersPersistence.ts` itself confirms nothing else references either. So
Task A's "remove the old form" step turned out to already be done by Phase
11 — I did not touch these two files, since there was nothing left to
remove and touching them for no reason would be exactly the kind of
unnecessary refactor the brief asked me to avoid.

**`CloneDetailsReadOnly` / `CloneDetailsV2ReadOnly` — confirmed unaffected.**
Both are exported from `OrderIntake.tsx` exactly as before (I made zero
changes to that file); both are still imported the same way by
`ChatNeriboPanel.tsx` and `OrdersManagementPanel.tsx`; neither component
reads anything I changed (they render `order.cloneDetails` /
`order.cloneDetailsV2` directly, not `cloneImages`, and I didn't touch
`toCloneDetails`/`toCloneDetailsV2` or either interface). Existing orders —
old-shape `cloneDetails` or new-shape `cloneDetailsV2` — will render in
Operations exactly as they did before this phase.

**Confirmed no other bypass remains:** grepped the whole repo for
`isValidOwnerIntake` and `submitCloneDetails` — every remaining hit is a
comment (either one I just wrote/updated, or an untouched historical
handoff doc). No live code path references either any more.

## Task B — allow a customer to replace an image before completion

**1. `functions/_shared/cloneImages.js`** — added
`latestVerifiedEntryPerSlot(entries)`, which returns a `Map<slotIndex, entry>`
holding only the LAST verified entry per slot (a later array position wins).
`allSlotsFilled` now determines completeness from this instead of "any
verified entry exists for this slot" (a `Set` of slot indices before). Old
entries are never modified — `verifiedEntries` (the full, undeduped list)
is untouched and still exists for anything that wants the full history.
*Verified*: wrote a standalone Node script exercising both functions against
a 3-slot scenario with one slot replaced, one forged (unverified) entry, and
a not-yet-uploaded slot — all 8 assertions passed (latest-wins, forged
entries never count, `allSlotsFilled` isn't blocked or fooled by a
replacement, `latestVerifiedEntryPerSlot(...).size` gives the correct unique
count). Script not included in the deliverable zip (it's a throwaway test,
not part of the app), but the logic it validates is now in the shipped file.

**2. `functions/api/orders/upload-clone-image.js`** — the "SLOT_ALREADY_RECEIVED"
rejection existed in two places; both are gone, replaced by the same idea:
a replacement is allowed for as long as the order's live status is
`awaiting_images`.
   - The early pre-check before the Telegram call (`existing.some(...)` →
     409) is removed outright. By the time execution reaches that point,
     `loadUploadContext` has ALREADY confirmed `order.status === "awaiting_images"`
     — the exact same state check the base (first-time) upload path uses —
     so there's nothing left to gate on a second time.
   - Inside `recordUpload`'s transaction, the same `existing.some(...)` →
     `{ reason: "already-received" }` early-return is removed. The
     transaction had already re-confirmed `fields.status === "awaiting_images"`
     a few lines above (this is what makes the earlier point true even under
     a race), so `entry` is now simply appended — `cloneImages` can hold more
     than one verified entry for a slot, exactly matching the brief's
     append-only / audit-trail requirement (nothing edits or removes an old
     entry; `firestore.rules`' `cloneImagesPrefixUnchanged` still guarantees
     that for the owner-append path, untouched).
   - `receivedCount` (both here and in the GET response's `received` list)
     now comes from `latestVerifiedEntryPerSlot(...).size` / `.values()`
     instead of the raw array. **This fixes a real bug the naive version of
     this change would have introduced**: the old formula
     (`receivedCount: next.length`) counts every historical entry, so after
     one replacement it would report e.g. "4 of 3 received" — an overcount
     that would never self-correct. Counting unique slots instead is the fix.
   - Removed the now-unreachable `if (recorded.reason === "already-received")`
     branch in the POST handler (recordUpload can no longer return that
     reason), and simplified `reportNotRecorded`'s severity ternary (it
     special-cased `"already-received"` as low-severity; that case can't
     occur any more, so every remaining reason is a real, medium-severity
     problem). I did NOT remove the `SLOT_ALREADY_RECEIVED` client-side
     handler in `OrderImageUpload.tsx` (`case "SLOT_ALREADY_RECEIVED":` in
     `handleUploadError`) — it's now unreachable defensive code, but harmless,
     and removing it wasn't necessary for the fix to work.
   - Rewrote the affected doc comments (file header, `recordUpload`'s JSDoc)
     to describe the new behavior instead of the old one.

**Testing requirement I can confirm from the code alone:** "attempt to
replace a slot after the order has reached `in_progress`" is still rejected
with `ORDER_NOT_ACCEPTING_IMAGES` (409) — the exact same response the base
upload path already returns for a completed order — because
`loadUploadContext`'s `order.status !== "awaiting_images"` check runs before
anything else and doesn't distinguish first-time from replacement uploads.
This is the check that makes SLOT_ALREADY_RECEIVED unreachable, and it's the
same one that keeps a completed order fully locked. **I could not confirm
the transactional race / concurrency behavior (two near-simultaneous
uploads to the same slot, or filling the last slot while a replacement to
an earlier slot is in flight) without a real Firestore instance — Westly,
please run scenario 4 below for real.**

**3. `src/components/OrderImageUpload.tsx`** — a received slot now shows a
**"Replace"** button (next to the existing "Received · filename" line)
instead of being a dead end, for as long as the order is still
`awaiting_images`. Picking a replacement shows the same preview/Change/
Remove UI a fresh pick would. `handleSubmit`'s per-slot loop no longer skips
a slot just because it's already received — it only skips a slot with
nothing newly picked, so a replacement pick is sent exactly like a first-time
one. Three bugs I found and fixed while making this change (all direct,
necessary consequences of enabling replacement — not separate refactors):
   - `receivedNames` was built by letting the live order snapshot always win
     over this session's own `justSent` result for a slot that was already
     "received". For a first-time upload that's harmless (the slot wasn't in
     `receivedNames` yet), but for a REPLACEMENT it meant the UI would keep
     showing the OLD filename until the Firestore listener caught up, even
     though the new upload had already succeeded. Fixed by letting `justSent`
     always win (this session's own confirmed result is always at least as
     current as a live snapshot that hasn't arrived yet).
   - `receivedRef` (a ref that mirrored `receivedNames` purely so
     `handleSubmit` could check "is this slot already received") became
     completely unused once that check was removed from `handleSubmit` — I
     removed the ref itself rather than leave a pointless assignment behind.
   - The "Send N images" button label used `slots.length - receivedCount`
     (i.e. "not-yet-received slots") as the count of images about to be
     sent. That undercounts once a replacement is picked for an
     already-received slot (that slot doesn't change `receivedCount`, so the
     label wouldn't reflect the extra send). Replaced with a direct count of
     `picked` entries, which is exactly what `handleSubmit` iterates over.
   - The "finished"/locked confirmation view's fallback row list (used only
     when the server's slot list wasn't loaded, e.g. the page loaded
     straight into `in_progress`) mapped over the raw `cloneImages` array
     with `key={entry.slotIndex}`, which would show a duplicate, colliding-key
     row for any slot that was replaced. Deduped it to one row per slot
     (latest entry), sorted by slot index.
   - Also fixed a stray stale line of copy ("Once an image is sent it can't
     be changed here") that would now be actively wrong.
   - The `finished` (locked, `order.status === "in_progress"`) branch itself
     needed NO logic change — it already renders no upload/replace controls
     at all, which is exactly the "fully locked, nothing left to press"
     requirement.

**4. `src/components/operations/OrdersManagementPanel.tsx`** —
`OrderImagesList` (the Supervisor's per-order image checklist) now shows
exactly one row per slot using its latest verified entry, in both the
slot-list-known and slot-list-unknown render branches, and in the "orphan"
(slot no longer on the item) list — all three previously iterated the raw,
undeduped `verified` array directly, which would have shown a duplicate row
for any replaced slot (with a React key collision on top, since the old code
used `key={entry.slotIndex}`). Added a small, low-effort **"· replaced"**
text marker (matching the row's existing plain-text style — no new
component, no new interaction) next to any slot whose history has more than
one verified entry, in both the known- and unknown-slot-list branches. I did
NOT add it to the "orphan" rows (a slot no longer on the item at all) — that
felt like it'd add complexity disproportionate to a rare, already-degraded
case; flagging it here rather than doing it.

## Files touched
- `firestore.rules`
- `src/lib/ordersPersistence.ts`
- `src/lib/domainRequestsPersistence.ts` (one stale comment referencing
  `submitCloneDetails`, fixed for accuracy — no logic change)
- `src/types.ts` (one stale comment on `CloneDetails`, fixed for accuracy —
  no logic/type change)
- `functions/_shared/cloneImages.js`
- `functions/api/orders/upload-clone-image.js`
- `src/components/OrderImageUpload.tsx`
- `src/components/operations/OrdersManagementPanel.tsx`
- `docs/PHASE_14_FINAL_REPORT.md` (this file)

**Not touched, deliberately:** `src/components/OrderIntake.tsx`,
`src/components/Workspaces.tsx` (nothing left to remove — see Task A.3/4
above), `src/lib/cloneImagesApi.ts` (generic error pass-through, no
SLOT_ALREADY_RECEIVED-specific handling to remove), every other `docs/*.md`
handoff (historical record, not rewritten).

## Testing Requirements — for Westly to run for real

None of these were run against a live Firebase/Telegram/browser in this
sandbox (no network, no dependencies installed). Please run all of them
before considering this phase done:

1. **Rules bypass closed.** In the Firestore Rules Playground (or a real
   browser dev-tools attempt), try the OLD fixed-shape write directly against
   an order at `awaiting_details` (the exact payload shape from Phase 6's
   handoff: `status: "in_progress"` + a valid `cloneDetails` map in one
   update) — it should now be **denied**. Also re-run the normal AI-chat
   intake end to end (Phase 11's flow) to confirm it still completes
   normally (it goes through the service account and never touches this
   rule, but worth a real confirmation after a rules change).
2. **Normal completion still works.** Fill every slot on a fresh
   `awaiting_images` order with NO replacements — confirm it still reaches
   `in_progress` exactly once, with the Telegram messages and Supervisor
   checklist looking exactly as before.
3. **Single replacement.** Upload a slot, then upload a different image to
   the SAME slot before the order completes. Confirm: (a) both images arrive
   in the Telegram channel as separate messages; (b) the customer's UI shows
   the NEW filename as "Received" promptly (not stuck on the old one); (c)
   the order does NOT complete from this alone; (d) the Supervisor panel
   shows one row for that slot with the new filename and a "· replaced"
   marker, not two rows.
4. **Complete with a replacement in the mix.** Fill every slot, replacing at
   least one along the way, and confirm the order reaches `in_progress`
   exactly once (not zero times, not twice) — this is the concurrency/race
   case I could not verify statically (see Task B.2 above). Also try two
   near-simultaneous replacement uploads to the SAME slot if practical, to
   exercise the transaction's optimistic-retry path.
5. **Locked after completion.** Once `in_progress`, attempt to upload
   (fresh or replacement) to any slot on that order — confirm it's rejected
   with `ORDER_NOT_ACCEPTING_IMAGES` (409), the same response a completed
   order already gave a first-time upload attempt before this phase, and
   that the customer's UI shows the fully-locked "All images received" view
   with no Replace button anywhere.
6. **`pnpm build` / `pnpm lint`** — not run by me (no dependencies
   installed, no network). Please run both; I verified syntax
   (`node --check`) and bracket balance manually on every edited file, and
   cross-checked every changed import against the real exports of the
   modules it comes from, but that is not a substitute for a real
   TypeScript/bundler pass.
