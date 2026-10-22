# Phase 11 Handoff — AI-driven conversational custom-URL intake

> **Superseded (Phase 8 provider-masking sweep).** The `functions/_shared/groqChat.js`
> module described throughout this handoff was later replaced by the fully
> masked `functions/_shared/intakeChat.js` (`NERIBO_INTAKE_KEY` /
> `NERIBO_INTAKE_URL` / `NERIBO_INTAKE_MODEL`, `IntakeCallError`,
> `callIntakeJson`) and `groqChat.js` was removed from the codebase — it was
> unused dead code by the time of the masking sweep. This page is kept
> as-written for historical accuracy; any provider name or `groqChat.js`
> reference below describes the original Phase 11 implementation, not the
> current one.

Scope: replaces Phase 6's fixed-step intake form with a chat with the model,
for `type: "url"` orders at `awaiting_details`. **This deliberately reverses
Phase 6's "no AI here" decision**; each risk Phase 6 named is handled (see
"Phase 6's three risks"). Nothing Supabase-related was touched. Nothing image
or Telegram related was built (Phase 12).

## What changed

| File | Change |
| --- | --- |
| `functions/api/orders/intake-chat.js` | **New.** The only endpoint for this feature: `POST /api/orders/intake-chat`. |
| `functions/_shared/orderIntake.js` | **New.** Pure logic: brief → checklist, prompts, parsing, completion checks, the sanitizer for `cloneDetailsV2`. |
| `functions/_shared/groqChat.js` | **New.** Small non-streaming, Groq-only call helper. |
| `src/lib/orderIntakeApi.ts` | **New.** Browser client for the endpoint. |
| `src/components/OrderIntake.tsx` | `OrderIntakeForm` replaced by `OrderIntakeChat`. `CloneDetailsReadOnly` / `SubmittedDetailsToggle` unchanged; added `CloneDetailsV2ReadOnly` / `SubmittedAnswersToggle`. |
| `src/components/Workspaces.tsx` | Mounts the chat; `awaiting_images` branches (see below). |
| `src/components/operations/OrdersManagementPanel.tsx` | Shows `cloneDetailsV2` and old `cloneDetails` side by side. |
| `src/types.ts` | `OrderStatus` += `"awaiting_images"`; new `CloneDetailsV2`; `Order.cloneDetailsV2?`. |
| `src/lib/ordersPersistence.ts` | Status list/labels/pill += `awaiting_images`; `toOrder` reads `cloneDetailsV2` via new tolerant `toCloneDetailsV2`. |
| `firestore.rules` | Supervisor override accepts `awaiting_images`; explanatory comment. |

Verified byte-identical to before: `functions/api/llm/chat/completions.js`,
`CLONE_DETAILS_LIMITS`, `submitCloneDetails`, `sanitizeCloneDetailsInput`,
`isValidOwnerIntake`, `isValidCloneDetails`, every Supabase file.

## The completion-signal contract

**Every assistant turn is ONE JSON object** (the server asks Groq for JSON mode
and tolerates a code fence or stray prose around it; if it still isn't valid it
asks once more, then fails the turn with a retryable error):

```json
{ "reply": "text shown to the customer",
  "asking": "the one question being asked, <=100 chars",
  "covered": [1, 2],
  "done": false }
```

- `covered`: numbers of checklist items the model believes are answered,
  cumulative. The checklist is derived **by the server** from the Showcase
  item's `detailsBrief` (see "Brief → checklist") and sent to the model as
  JSON data; the model never decides what the checklist is.
- **The completion signal is `done === true`** (literal boolean; `"true"`, `1`
  etc. are `false`). It is a *claim*, never an instruction. The server then:
  1. requires `covered` to contain **every** item number, else discards that
     reply and asks a corrective question (a second model call that lists the
     missing items);
  2. makes an **independent verification call** (fresh prompt, temperature 0,
     sees only the checklist + the customer's numbered messages, as JSON
     data). It must return one entry per item with `covered: true` **and** at
     least one cited customer-message number that really exists. Anything
     else (no evidence, out-of-range turn, duplicate/missing entry, unusable
     output twice) counts as *not covered* (or fails the turn);
  3. only if both pass does **the Function** (service account) write the
     order. If verification finds gaps, the "all done" reply is thrown away
     and the customer gets a question about the first gap; if even the
     corrective call misbehaves, a fixed fallback question is used — never a
     false "all done".
- The browser can neither trigger nor observe any of this beyond the returned
  `state` (`active` / `completed` / `capped`).

## Final `cloneDetailsV2` shape

```
orders/{id}.cloneDetailsV2 = {
  answers: [ { question: string /*1-200*/, answer: string /*1-1500*/ }, ... ],  // 1-60, one per customer message, in order
  submittedAt: string  // ISO; equals the order's updatedAt at that moment
}
```

- `answer` is the customer's **own words, verbatim** (control / zero-width /
  bidi characters stripped, newlines kept, capped). The model never writes an
  answer, so it can't fabricate one.
- `question` is the model's short `asking` label for the assistant message the
  customer replied to (cleaned, capped; falls back to the last question in the
  reply, then `"Follow-up"`).
- Written only by `intake-chat.js`, through `sanitizeCloneDetailsV2`
  (parallel to the client's `sanitizeCloneDetailsInput`, for the new shape,
  run server-side). Old `cloneDetails` is never read, changed or migrated; if
  an order has both, both are carried through and both display.

## Where the work happens

- **Conversation state** lives server-side in `orderIntake/{orderId}`
  (transcript, counters, a snapshot of the brief/checklist taken when the chat
  starts, a short-lived lock). There is **no rules match for it**, so the
  catch-all `allow read, write: if false` denies every client; only the
  service account touches it. The client sends only `{ orderId, action,
  message, messageId }`, so it cannot forge earlier turns, supply a prompt or
  model, or reset counters.
- **Auth, on every call** (each `start` and each `message`): verified Firebase
  ID token → order must exist, belong to that uid, be `type: "url"`, and be
  `awaiting_details`. Every failure of that check returns the same generic
  `404` (no existence/ownership leak). IP-ban / suspended / flagged checks are
  the same ones the main chat applies.
- **Provider**: Groq only (`GROQ_API_KEY`); `GEMINI_API_KEY` is never read; no
  model parameter from the client. Model id = `GROQ_MODEL_ADVANCED` (same env
  var and default `openai/gpt-oss-120b` as Neribo.ai.2.0). Missing key → logged,
  reported to Operations as a `high` event, calm error to the customer — same
  handling as `completions.js`.
- **No chat quota is spent** (the customer already paid). Cost is bounded per
  order instead — below.

### What was extracted from `completions.js`
Nothing was moved: `completions.js` has no reusable provider function (its Groq
code is welded to the SSE writer, quota `release()` and the vision fallback) and
this phase forbids editing it. `groqChat.js` re-declares only the upstream URL,
the default advanced model id, and the "missing key / log the body / report to
Operations / safe message" handling, and reuses `failureKindForStatus`
(`aiConfig.js`) and `reportOperationsEvent`. Supervisor-editable failure
messages (Operations → AI Model) are reused for provider errors. Small,
deliberate duplication; `completions.js` can import from `groqChat.js` in a
later, separately tested change.

## Limits (all server-side; constants in `orderIntake.js`)

| Limit | Value |
| --- | --- |
| One customer message | 1,500 chars after cleaning. Over → `400 MESSAGE_TOO_LONG` (never truncated). Empty/invisible-only → `400`. Request body > 8,000 chars → `400`. |
| Customer messages per order | `clamp(items×3 + 6, 12, 60)` |
| Provider calls per order (failed, corrective and verification calls included) | `maxUserTurns×3 + 3` |
| Checklist items | 30 (extras merge into the 30th); each ≤ 300 chars |
| Stored answers | ≤ 60; question ≤ 200; answer ≤ 1,500 |
| One provider call / one whole customer turn | 20 s / 50 s (lock lasts 90 s) |

**When the cap is hit** the chat becomes `capped`: the customer sees a calm
"length limit reached — the team will follow up" note, the order is **not**
advanced (the brief was never fully covered), and an Operations → Events entry
`intake-cap-reached` (severity medium) tells you to contact them and set the
status by hand.

## Brief → checklist (deterministic, server-side)

`detailsBrief` (Phase 10) is cleaned, then: if any line starts with a bullet or
number, each such line is an item (unmarked lines *after* one continue it;
unmarked lines *before* the first are "team notes", sent as context only); else
several lines → one item per line; else a single paragraph → one item per
sentence. **Empty / null / whitespace-only / marker-only → the built-in default
brief:** site or business name · what the site is for and who it serves · key
sections/pages · contact details for follow-up (`DEFAULT_BRIEF`). The brief is
snapshotted when the chat starts.

## Status transition

On validated completion, in one transaction on the order (only if it is still
this uid's `url` order at `awaiting_details`; otherwise nothing is written and
an Operations `high` event is raised):

- Showcase item has ≥ 1 real `imageSlots` entry (non-blank label) →
  `status: "awaiting_images"`.
- else → `status: "in_progress"` (Phase 6's behaviour).

`cloneDetailsV2` and `updatedAt` are written in the same commit; every other
field is carried through unchanged. If that write fails, the validated answers
are kept (`stagedAnswers`) and the customer sees "We couldn't save your details
— try again"; the retry re-does **only the write**, no new model calls.
If a Supervisor sets a completed order back to `awaiting_details`, a fresh
conversation starts.

## Every place `"awaiting_images"` was added

1. `src/types.ts` — `OrderStatus` union.
2. `src/lib/ordersPersistence.ts` — `ORDER_STATUSES` (after `awaiting_details`),
   `ORDER_STATUS_LABELS`, `getOrderPill` ("Awaiting your images"). The
   Supervisor panel's filter chips and override dropdown are built from
   `ORDER_STATUSES`, so they gained it automatically.
3. `firestore.rules` — `isValidSupervisorOverride`'s allowed statuses (without
   this a Supervisor couldn't touch an order sitting there).
4. `src/components/Workspaces.tsx` — chat stays mounted through the flip
   (`intakeStarted` also covers `awaiting_images`); placeholder block; V2
   answers toggle on `in_progress`.
5. `src/components/operations/OrdersManagementPanel.tsx` — V2 block open for
   `awaiting_images` / `in_progress`; "no site details" note only when neither
   shape exists.

Checked and **deliberately unchanged**: `domainRequests` rules /
`DomainsView` / `App.tsx` / `SidebarDrawer.tsx` (domains need `in_progress` /
`delivered` — an order still waiting on images shouldn't request a domain);
`ChatNeriboPanel` (lists `in_progress` orders); `get-download.js` (code orders
only); `webhook.js` (only ever moves `pending_payment` forward, so a redelivery
can't pull an `awaiting_images` order back).

**What renders for `awaiting_images` before Phase 12** (customer): the pill
"Awaiting your images" plus "Your details are in. Next we'll need a few images
from you — that step isn't ready yet, so there's nothing more to do for now."
and the collapsible list of their answers. Phase 12 replaces this paragraph
(`Workspaces.tsx`, search "PHASE 11 placeholder"). Supervisor: normal row with
answers open; they can move it on with Override status.

## Firestore rules — a deliberate deviation from the brief's item 8

The brief asked for a new validation function for `cloneDetailsV2` and the
new transition. I did **not** add an owner-write path or a `cloneDetailsV2`
validator to the rules, because the server writes these fields with the service
account (rules don't apply) and an owner path would let a customer skip the
conversation and its server-side completion check entirely. The existing
`hasOnly` lists already stop any client creating or changing `cloneDetailsV2`.
What the rules did need (`awaiting_images` for Supervisor overrides) is done;
old functions untouched. If you'd rather have a rules-level validator anyway,
say so — but it would be unused by any write path.

**Related, needs your decision:** the *old* owner-intake path
(`isValidOwnerIntake`) is still in `allow update`, as instructed ("don't weaken
or remove"). It means a customer using dev-tools could still submit the old
fixed shape directly and jump to `in_progress`, skipping the chat and image
step. It only affects their own order, and keeping it means a deploy in either
order can't break an old browser tab. Once you're happy with the new flow, the
fix is to delete the `isValidOwnerIntake` clause from `allow update` — I did not
do that without asking.

## Deploy order

1. Publish `firestore.rules` (only needed for Supervisor overrides to
   `awaiting_images`; safe first — nothing else depends on it).
2. Deploy the Pages project (Function + front end together).
3. No new env vars: `GROQ_API_KEY` must already be set (it is, for Chat).
   Optional: `GROQ_MODEL_ADVANCED` changes the model for Chat *and* intake.
4. No new indexes. Firestore gets a new collection `orderIntake`, created on
   first use.

## Verification performed (my sandbox: no network, no Firebase, no Groq)

- **59 Node tests** run the real `intake-chat.js`, `orderIntake.js` and
  `groqChat.js` against an in-memory Firestore (real value encoding, optimistic
  transaction conflicts, injectable commit failures) and a scripted fake Groq.
  They cover: multi-item brief asking every item in order and not finishing
  early; image slots → `awaiting_images`, none/malformed slots → `in_progress`;
  empty/null/blank brief → default brief; premature/partial `done`; audit with
  gaps, no evidence, bogus turn numbers, unusable output; a "compromised" model
  that obeys injected text; hostile brief text staying inside its JSON slot;
  attacker text never appearing in a system message; provider 500/429/503/
  timeout/network/malformed-JSON/missing-key with calm errors, unchanged
  transcript, retry with the same id succeeding exactly once, real detail only
  in Operations events; no client-controlled model; other user's / code /
  unpaid / paid / in-progress / awaiting-images / delivered / non-existent
  order → identical 404 with no model call, on both actions; re-checks on
  every message; 401s, suspended/flagged/banned; malformed bodies incl. path
  traversal; message/turn/provider-call caps; idempotent replay; concurrent
  requests (one gets 409); stale locks; transaction aborts; failed order write
  then retry without a model call; order changed mid-completion; sanitization
  of stored answers; old `cloneDetails` carried through; re-opened orders.
- **Client logic (4 tests)** on the real transpiled `ordersPersistence.ts`:
  status list/labels/pill consistent; an old-shape and a new-shape order
  normalise correctly side by side; junk `cloneDetailsV2` → null; old exports
  unchanged.
- **Type-check** of all of `src/` with stubbed React/lucide/firebase before vs
  after: no new errors (only stub noise changed; several old stub errors
  disappeared with the removed form).

## NOT verified — please do these

1. **`pnpm build`** with real dependencies. The stubs make React/lucide types
   `any`, so JSX/hook typing was not truly checked. `RotateCw` and `Send` are
   standard lucide icons.
2. **A real Groq call.** I could not reach Groq. Assumptions to confirm on the
   first real test: `response_format: {type:"json_object"}` and
   `reasoning_effort: "low"` are accepted for `openai/gpt-oss-120b` (if Groq
   returns a 400 naming either, the Function retries without it and still
   parses JSON from the text), and the model follows the JSON contract well
   enough that the verification step usually agrees with it. Watch
   Operations → Events for `intake-groq-*` entries.
3. **The chat UI in a browser / on a phone** (layout, keyboard, scrolling,
   Enter-to-send, the "Not sent" retry state, the finished state when the
   status flips before the reply arrives).
4. **A real end-to-end order**: pay for a URL item that has a multi-line brief
   and 1–2 image slots → converse → order lands on `awaiting_images` with
   `cloneDetailsV2`; repeat with an item with no slots (→ `in_progress`) and one
   with no brief (default brief). Also check an *old* order with `cloneDetails`
   still displays in Orders Management next to a new one.
5. **Firestore rules** in the Rules Playground: as Supervisor, changing an
   order's status to `awaiting_images` must be allowed; as the owner, any write
   touching `cloneDetailsV2` must be denied; a client read/write of
   `orderIntake/*` must be denied.

## Known limits / decisions to confirm

- Verification uses the same model as the conversation. It is a separate,
  differently-prompted, evidence-citing call, not an independent system: if an
  attacker somehow got *both* to cooperate they could complete an intake with
  thin answers. Impact is limited to their own order (the Supervisor sees the
  verbatim answers). Skipping items by saying "none" is allowed by design.
- `answers` has one entry per customer message (including follow-ups), not one
  per brief item.
- Answers render as plain text — links a customer types are not clickable
  (unlike the old shape's validated example sites).
- Flagged accounts are refused like in Chat, which would strand a *paying*
  flagged customer until you clear the flag.
- The Supervisor has no viewer for the raw transcript (`orderIntake/*`); only
  the final answers, and Operations events for caps/failures.
- Editing a brief mid-conversation doesn't affect chats already started (the
  brief is snapshotted); it applies to chats started afterwards.
- A conversation cut off by a crashed request blocks that order's chat for up
  to 90 s (the lock expiry) — the customer sees "still working, try again".
