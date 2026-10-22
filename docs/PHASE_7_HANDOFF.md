# Phase 7 Handoff — Chat Neribo (one-way Supervisor → user messages)

Status: built and unit-tested against stubs. **Not yet run against real Firebase / Cloudflare.**
Read this before Phase 8 (domain pricing notifications) and Phase 9 (end-to-end testing).

---

## 1. What Phase 7 adds

**Chat Neribo** is a one-way channel:

- The **Supervisor** writes a message (plain text + optional http(s) link) to one user from
  *Operations → Chat Neribo*.
- The **user** reads it under a new *Chat Neribo* item in their sidebar. They can tap **Got it**
  (sets `acknowledged`). They **cannot** reply — there is no input anywhere in the user view,
  and Firestore rules forbid every client-side create.
- When a **code order is paid**, the system sends the buyer an **automatic** message (reminder that
  the file is ready in Orders + the Cloudflare Pages / Netlify deploy guide). No Supervisor action.
- A sitewide **"Chat Neribo enabled"** switch (Operations → App Settings) hides the nav item for users.

Chat Neribo is a separate system from the regular chat threads (`users/{uid}/chats`). Never merged.

---

## 2. Files

### New
| Path | Purpose |
|---|---|
| `functions/_shared/chatNeriboMessages.js` | The ONLY server-side writer (`writeChatNeriboMessage`), text/link validation, ids, and the auto-message text builder. |
| `functions/api/admin/send-chat-neribo-message.js` | Supervisor-only send endpoint (contract in §4). |
| `functions/api/admin/set-chat-neribo-enabled.js` | Supervisor-only on/off switch. Mirrors `set-showcase-enabled.js`. |
| `src/lib/chatNeriboPersistence.ts` | Live listener + "Got it" update. **Deliberately has no create function.** |
| `src/hooks/useChatNeriboEnabled.ts` | Live read of `appConfig/chat-neribo-enabled` (starts after sign-in). |
| `src/components/ChatNeriboView.tsx` | The user's read-only feed. |
| `src/components/operations/ChatNeriboPanel.tsx` | Supervisor panel: pick user, order context, composer, recent messages. |

### Modified (all additive except where noted)
| Path | Change |
|---|---|
| `functions/api/payments/webhook.js` | Sends the auto message when a code order becomes `paid`. One existing line changed: the `"fulfilled"` outcome now also carries `showcaseItemTitle`. |
| `firestore.rules` | New `chatNeriboMessages` block (§3). |
| `src/types.ts` | `"chatNeribo"` added to `ActiveNav` and `OperationsSection`; new `ChatNeriboMessage`. |
| `src/App.tsx` | Enabled hook, live per-user listener, unread count, sidebar props, renders `ChatNeriboView`. |
| `src/components/SidebarDrawer.tsx` | "Chat Neribo" nav item + unread badge (hidden unless enabled). |
| `src/components/OperationsSidebar.tsx`, `OperationsView.tsx` | New "Chat Neribo" section. |
| `src/components/operations/AppSettingsPanel.tsx` | New `chat-neribo-enabled` setting in the registry. |
| `src/lib/operationsActions.ts` | `sendChatNeriboMessage`, `setChatNeriboEnabled`. |

Not touched: Header, Workspaces, Orders Management, OperationsUsersPanel, chat threads, Stripe/Paystack
amount logic, `deployGuide.ts`.

---

## 3. Data model and rules

Collection: **`chatNeriboMessages/{messageId}`**

```
id            string   also the doc id
uid           string   recipient
text          string   1..5000 chars, plain text
linkUrl       string | null   http(s) only, <= 2000 chars
createdAt     string   ISO timestamp (project convention; sorted client-side, so no composite index)
acknowledged  boolean  false on creation
source        "supervisor" | "code-purchase"      (added beyond the brief)
orderId       string | null   set for the automatic message  (added beyond the brief)
```

Rules (`firestore.rules`):

- **read**: the recipient (`resource.data.uid == request.auth.uid`) or a Supervisor.
- **create**: nobody (`false`). All writes use the service account in Functions, which bypasses rules.
- **update**: the recipient only, and only the `acknowledged` boolean.
- **delete**: nobody.

A regular user's query **must** include `where("uid", "==", <own uid>)` (rules aren't filters).

**The rules file must be published** (Firebase Console → Firestore → Rules) or the feature will
show permission errors. Not tested with the emulator — see §7.

---

## 4. Send endpoint contract (Phase 8 reuses this)

`POST /api/admin/send-chat-neribo-message`, header `Authorization: Bearer <Firebase ID token>`

```json
{ "targetUid": "string", "text": "string (1..5000)", "linkUrl": "https://… | null | omitted" }
```

Client helper: `sendChatNeriboMessage(targetUid, text, linkUrl)` in `src/lib/operationsActions.ts`.

Success `200`: `{ "success": true, "message": { "id", "uid", "createdAt" } }`

Errors (`{ error: { code, message } }`): `403 FORBIDDEN` (not signed in / not Supervisor — same generic
answer), `400 INVALID_BODY`, `400 INVALID_TARGET` (target is a Supervisor), `404 NOT_FOUND`,
`500 SERVER_ERROR`.

Notes:
- Text is normalized server-side (CRLF→LF, control/bidi/zero-width characters stripped, trimmed).
  ZWJ/ZWNJ are kept so emoji survive.
- The endpoint is **not** gated by the enabled switch — messages queue while it's off.
- No audit-log entry is written (not an account-management action).

---

## 5. The automatic "code purchased" message

- Trigger: `fulfillShowcaseOrder` in `webhook.js`, `"fulfilled"` outcome with `status === "paid"`
  (only code orders reach `paid` there; URL orders go to `awaiting_details`).
- Document id is deterministic: `code-purchased-{orderId}`; written with `skipIfExists`, so a repeat
  can neither duplicate it nor reset `acknowledged`.
- Best effort: a failure logs and reports an Operations event
  (`context: "chat-neribo-auto-message-failed"`, severity `medium`); the webhook still returns 200
  because the order is already paid. If you see that event, send the message by hand.
- **Not covered:** a Supervisor overriding an order to `paid` by hand in Orders Management sends
  nothing (that's a client write; no server code runs).
- The deploy-guide text is **duplicated** in `chatNeriboMessages.js` from `src/data/deployGuide.ts`
  (Functions can't import from `src/`). **If you edit one, edit the other.**

---

## 6. UI behaviour

**User view** — newest first, live (a message sent while it's open appears without refresh). Each card:
timestamp, plain text with line breaks preserved, optional "Open link" button (also shows the raw URL),
"Got it" button (or a "Got it" label once acknowledged). Links open with `rel="noopener noreferrer nofollow"`;
a `linkUrl` that isn't http(s) is dropped when the doc is loaded.

**Unread badge** — the sidebar item shows the count of messages not yet acknowledged. This required the
listener to run whenever the feature is on (not only while the page is open). It's a single per-uid query.
Reason: Phase 6's confirmation text promises "you'll be notified"; this is the notification. To remove
the badge, drop the `chatNeriboUnread` prop in `App.tsx`.

**Supervisor panel** — search users by email/nickname, pick one, see that user's `in_progress` order(s)
with the Phase 6 site details (read-only), compose (5000-char counter, optional link validated), send,
and see the last 10 messages to that user with Got it / Not acknowledged.

**Users list reuse** — `OperationsUsersPanel` has no selection callback and was do-not-touch, so the
panel reuses the shared `fetchOperationsUsers` cache and re-applies the same email/nickname search rule.

**Switch off** — nav item hidden; a user already on the page sees "temporarily unavailable". Supervisor
panel, the send endpoint, and the automatic message are unaffected.

---

## 7. What was verified, and what was not

Verified (with stubs, not real Firebase):
- Send endpoint end-to-end against a fake Firestore: 403 for no token / regular user, 400s, 404,
  supervisor target rejected, correct stored shape, link/text normalization.
- Webhook against a fake Firestore: code order → `paid` + message; redelivery doesn't duplicate or reset
  `acknowledged`; URL order → no message; amount mismatch → no message; message-write failure →
  order still `paid`, 200, Operations event reported; bad signature still 401.
- `ChatNeriboView` rendered to markup: no `input`/`textarea`/`select`/`form`/`contenteditable` in any
  state; message text is escaped; `javascript:` links never reach markup; disabled state hides messages.
- Loose type-check with stubbed React/Firebase/lucide: no errors beyond stub noise.

**Not verified:** the real app build (`pnpm run build`), the Firestore rules (read but never run in the
emulator or Rules Playground), the live listener and the "Got it" write against real Firestore, the real
Paystack webhook, visual layout on a phone.

---

## 8. Test checklist for Phase 9

1. Publish the new rules. In the Rules Playground: a signed-in non-supervisor **create** on
   `chatNeriboMessages/x` is denied; **update** of `text` on their own message is denied; update of
   `acknowledged` on their own message is allowed; **read** of someone else's message is denied.
2. Supervisor sends a message with and without a link → it appears on the user's Chat Neribo **without
   refresh**; the sidebar badge shows 1; **Got it** clears the badge and shows "Got it" in the Supervisor's
   recent-messages list.
3. Confirm the user view has no input anywhere and that a Supervisor account cannot reach it.
4. Pay for a **code** order (Paystack test mode) → order `paid` and one auto message with the item title and
   both deploy guides. Trigger the same webhook again → still one message.
5. Pay for a **URL** order → `awaiting_details`, **no** message.
6. Turn the switch off → nav item disappears for the user; Supervisor still sends; turn it on → queued
   messages are there.
7. Send a link like `javascript:alert(1)` from the composer → rejected.

---

## 9. Known limitations / notes for later

- Header shows the raw nav id (`chatNeribo`) after the `/` on this page, like `orders`/`live` do. Cosmetic.
  `Header.tsx` was not touched.
- The feed loads all of a user's messages (no limit; sorted client-side to avoid an index). Fine at
  expected volumes; add `orderBy` + `limit` + a composite index if a user ever accumulates hundreds.
- Nothing alerts the Supervisor when a customer submits site details (Phase 6 §13.7) — out of scope here.
- Phase 8 should call `sendChatNeriboMessage(...)` for its notifications rather than adding a new path.
