# Phase 10 Handoff — Supervisor brief + image slots on Showcase items

Scope: Supervisor-side data model and editing UI only. **No user-facing screen
reads or shows any of this yet** (conversational intake = Phase 11, image
collection = Phase 12). The existing `OrderIntake` form is unchanged.

## What changed (4 files; nothing else)

| File | Change |
| --- | --- |
| `src/types.ts` | New `ImageSlotDef { label, description }`. `ShowcaseItem` gains optional `detailsBrief?: string \| null` and `imageSlots?: ImageSlotDef[] \| null`. |
| `src/lib/showcasePersistence.ts` | New exported `SHOWCASE_INTAKE_LIMITS`. Loader (`toShowcaseItem`) reads both fields; writer (`saveShowcaseItem`) writes both (explicit `null` when empty). Persistence mechanism (setDoc + retry) untouched. |
| `firestore.rules` | `isValidShowcaseItem` allows and validates the two new keys (helpers `isNullOrValidDetailsBrief`, `isValidImageSlot`, `isValidImageSlotAt`, `isNullOrValidImageSlots`). |
| `src/components/operations/ShowcaseManagementPanel.tsx` | Brief textarea + image-slot editor, shown only when a custom-URL price is entered. One-line "Intake: …" summary in the item list. |

Verified untouched (checksums): `OrderIntake.tsx`, `ordersPersistence.ts`, every
Cloud/Pages Function, and the Supabase files.

Note: the brief called the persistence file `showcasePersistence.js`; the real
file is `showcasePersistence.ts` (as documented since Phase 1).

## DEPLOY ORDER MATTERS — rules first

**Publish `firestore.rules` BEFORE deploying the front end.** The new client
writes eleven keys on every save (including the Active/Hidden switch). The old
rules' `hasOnly` list has nine, so the new front end against old rules would
reject *every* Showcase save. The reverse order is safe: the old front end
(nine keys) passes the new rules.

## Data contract (for Phases 11 and 12)

`showcaseItems/{id}` now has up to **eleven** fields (nine from Phase 1 plus):

| Field | Type | Rules |
| --- | --- | --- |
| `detailsBrief` | string \| null | 1–8,000 characters when present. Free text, line breaks preserved. |
| `imageSlots` | list \| null | 1–**12** entries when present. Ordered. |
| `imageSlots[i].label` | string | 1–60 chars, single line. |
| `imageSlots[i].description` | string | 0–300 chars, single line, **may be empty**. |

- **Absent, null, and "none" are the same.** Items created before this phase
  have neither key; the loader returns `null` for both. The client always writes
  explicit `null` (never `""`, never `[]` — rules reject both), so consumers
  only need to handle `null` vs a real value. A whitespace-only brief cannot be
  ruled out by rules, so trim-check it anyway.
- **Order is identity.** Slot labels are kept unique (case-insensitive) by the
  Supervisor form, but rules cannot enforce uniqueness. Key uploads and answers
  by slot **index**, not by label.
- **Text is pre-cleaned by the form**: control characters, zero-width and
  bidirectional-override characters stripped, line endings normalized, slot
  text collapsed to single lines. It is still Supervisor-authored free text —
  if it goes into an LLM prompt, treat it as data, not instructions.
- **Gate on the order path, not on the brief.** Fields are only *edited* while
  a custom-URL price is set, but they are **kept** when the price is later
  cleared (see below), so an item with `priceUrl == null` can still carry a
  brief. A customer who already paid for the custom-URL service on that item
  can still be served from it.
- **Not a secret.** Like every other field on an *active* item, both fields are
  readable by any signed-in account (whole-document read rule). The form says
  so. If the brief must be private, Phase 11 needs a Supervisor-only document.

## Behaviours worth knowing

1. **Hidden ⇒ untouched.** When the custom-URL price is blank the two sections
   are not shown, and saving does not validate, edit, or erase what is stored.
   Clearing the price does not delete a carefully written brief. Typing a price
   back reveals the stored values.
2. **Active/Hidden switch** re-saves `{ ...item }`. The loader therefore must
   carry the new fields (it does; covered by a test). Any future field added to
   `saveShowcaseItem` must be added to `toShowcaseItem` too.
3. **Blank slot rows are dropped silently** on save (an "Add image slot" never
   filled in). A row with a description but no label is an error.
4. **No silent truncation of a pasted brief.** The brief textarea has no
   `maxLength`; a live counter turns red past 8,000 and Save is blocked with a
   message. (Slot label/description inputs do use `maxLength`.)
5. **Loader is tolerant**: malformed slot entries are dropped rather than
   crashing the page; it does not truncate an over-long list (that would lose
   data on the next save).

## Why the slot cap is 12, not 20

Rules cannot loop, so every slot index gets its own check (same technique as
Phase 6's `exampleSites`). A rough evaluated-node count (my own proxy — NOT
Google's exact metric) gives about **757** nodes for a full 12-slot list plus an
8,000-char brief, versus about **1,141** for a 20-slot cap, which would exceed
Firestore's documented 1,000-expressions-per-request limit. 12 leaves headroom.

- If a full 12-slot save is ever refused with an expression-limit error,
  **lower** the cap (`firestore.rules` and `SHOWCASE_INTAKE_LIMITS.maxImageSlots`).
- Raising it means adding `isValidImageSlotAt(v, N)` lines, updating the
  constant, and re-testing a full list in the Rules Playground.

## Security check (as requested)

Read from the actual rules: `allow create, update: if isSupervisor() &&
isValidShowcaseItem(request.resource.data);` and `allow delete: if
isSupervisor()`. It is a whole-document gate, so the new fields are
Supervisor-write-only with no separate rule needed. Read access is unchanged
(Supervisor: all items; any signed-in user: active items).

## Verification performed

Run in a sandbox with no network, no Firebase emulator, and no `node_modules`:

- **Rules logic — 61 cases** against the real function bodies loaded from
  `firestore.rules` by a small home-made evaluator (a sanity block first
  confirmed it reproduces the ORIGINAL rules' behaviour): exact limits and
  one-over on every bound, wrong types (incl. a list used as a label, which a
  bare `.size()` would have accepted), extra/missing keys, non-map slots, every
  slot index 0–11, legacy nine-field docs, unchanged protections.
- **Client code — 22 tests** on the real transpiled `showcasePersistence.ts`
  and the panel's helper functions (extracted verbatim) with a mock Firestore.
  Includes: bodies the client writes pass the rules; round trip preserves
  order; the toggle preserves brief/slots; legacy docs load and re-save;
  malformed stored slots are dropped.
- **Real panel in headless Chromium — 12 tests**: section shown for URL items
  and absent for code-only; prefill; hidden-save leaves stored values; reveal
  on typing a price; legacy item saves explicit nulls (11 keys); add / reorder /
  remove / save; validation messages (duplicate label, description without a
  label, over-long brief); Add disabled at 12; toggle preserves fields; no
  page errors.
- **Type-check**: identical error set before and after (2 stub-noise errors),
  also under `--strict`.

## NOT verified — please do these

1. **Real Firestore rules.** My evaluator is not Google's engine. In the Rules
   Playground (or emulator), as the Supervisor account, test `create`/`update`
   on `showcaseItems/x` with: (a) a legacy nine-field doc; (b) 12 slots, each
   label 60 chars and description 300 chars, plus an 8,000-char brief — **must
   be allowed** (this is the expression-budget check); (c) 13 slots — denied;
   (d) brief of 8,001 chars — denied; (e) a slot with an extra key — denied;
   (f) as a non-Supervisor — denied.
2. **`pnpm build`** with the real dependencies (React/lucide/Firebase types).
   I used stubs; lucide `ChevronUp`, `ChevronDown`, `Trash2` are standard
   icons and `Trash2`/`ChevronDown` were already imported elsewhere.
3. **Visual check on a phone.** The browser test ran unstyled (no Tailwind in
   the sandbox), so layout and spacing of the new section are unseen.
4. **Manual smoke test** in the app: edit a URL-priced item, add a brief and
   two slots, save, reload the page, reopen — values and order should persist;
   flip Active/Hidden and confirm they survive.

## Known limits / decisions to confirm

- Slot cap 12 (see above). Empty slot descriptions are allowed.
- Uniqueness of labels is client-only.
- Nothing yet tells the Supervisor how many customers a brief affects; there is
  no versioning of briefs. Editing a brief later changes it for orders not yet
  through intake.
