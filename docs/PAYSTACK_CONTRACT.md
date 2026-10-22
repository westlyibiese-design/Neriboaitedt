# Paystack Contract — Neribo

**Read this before touching `functions/api/payments/*` or Paystack in any later phase.**

Firestore is the source of truth for all data, including payment/order
records. Supabase is Storage-only (files/images) and is never involved
in payments. This document covers the full contract Paystack
integration follows across the whole project, not just Phase 3.

## 1. Files involved

| File | Purpose |
|---|---|
| `functions/api/payments/initialize.js` | Starts a Paystack checkout (subscription OR one-time). Never grants/fulfills anything itself. |
| `functions/api/payments/webhook.js` | The ONLY place anything is ever granted or fulfilled. Verifies signature, then branches on event + `metadata.purpose`. |
| `functions/api/payments/cancel.js` | Lets a signed-in Pro user cancel their subscription. Unrelated to one-time purposes. |
| `functions/_shared/paystackSignature.js` | HMAC-SHA512 webhook signature verification. Untouched since Phase 1 — no bug found in Phase 3's read of it. |

## 2. The `purpose` field

Every Paystack transaction Neribo initializes now carries `purpose` in
`metadata`. This is the single value every later phase (webhook
handling, Firestore records, UI) should switch on. Exactly these four
values exist for the whole 9-phase project:

| `purpose` | Meaning | Owning phase |
|---|---|---|
| `"subscription"` | Neribo Pro, ₦1,000/week, recurring | Phase 1 (unchanged) |
| `"showcase_code"` | One-time: raw code download for a Showcase item | Phase 4 |
| `"showcase_url"` | One-time: custom clone/URL service for a Showcase item | Phase 4 |
| `"domain"` | One-time: domain registration/setup service | Phase 8 |

`purpose` defaults to `"subscription"` when absent — this is what keeps
every pre-Phase-3 caller (including the current frontend, which sends
no request body at all) working unchanged, and is also why Paystack
renewal charges (which don't reliably carry metadata) still resolve
correctly: see `webhook.js`'s `resolveUid()`.

## 3. `initialize.js` — request contract

`POST /api/payments/initialize`, `Authorization: Bearer <Firebase ID
token>` (unchanged — identity always comes from the verified token,
never the body).

Body (JSON, all fields optional unless noted):

```jsonc
{
  "purpose": "subscription" | "showcase_code" | "showcase_url" | "domain", // default: "subscription"
  "amount": 150000,        // REQUIRED for "domain" only (until Phase 8 closes its gap). Positive integer, in KOBO (Naira × 100). IGNORED for "subscription" AND (since Phase 4) for "showcase_code"/"showcase_url" — for those the server computes the amount itself.
  "metadata": {
    "orderId": "abc123",         // REQUIRED for showcase_code / showcase_url (Phase 4) — orders/{orderId}, must be the caller's own unpaid order; optional/opaque for other purposes
    "domainRequestId": "xyz789"  // optional, opaque string — Phase 8's domainRequests/{domainRequestId}
  }
}
```

- `purpose === "subscription"`: behaves exactly as Phase 1 built it —
  uses `env.PAYSTACK_PLAN_CODE`, `amount` and `metadata.orderId`/
  `metadata.domainRequestId` are ignored entirely.
- **`showcase_code` / `showcase_url` (Phase 4):** the body's `amount` is
  never read. `initialize.js` calls `resolveShowcaseCheckout()`
  (`functions/_shared/showcaseCheckout.js`), which verifies checkout isn't
  paused (`appConfig/checkout-enabled`), that `orders/{orderId}` exists,
  belongs to the token's uid, is `pending_payment`, and has the matching
  `type`, and that the Showcase item is active — then computes
  `amount = priceCode|priceUrl × 100` from the `showcaseItems` doc and
  writes that price (Naira) back onto the order. Paystack's
  `metadata` for these is `{ uid, purpose, orderId }`, and its
  `callback_url` is `/?orders=complete` (not `/?upgrade=complete`).
  Errors: `400 INVALID_REQUEST`, `403 CHECKOUT_PAUSED`, `404
  ORDER_NOT_FOUND`, `409 ORDER_NOT_PAYABLE | ORDER_TYPE_MISMATCH |
  ITEM_UNAVAILABLE | PRICE_UNAVAILABLE | ORDER_INVALID`.
- `purpose === "domain"` (Phase 8's): Paystack's `amount` field is used directly
  instead of `plan`, in **kobo** (Paystack's native unit for NGN — a
  ₦1,500 item is `amount: 150000`). `metadata.orderId` /
  `metadata.domainRequestId`, if sent as non-empty strings, are
  forwarded into Paystack's `metadata` untouched — Phase 3 does not
  validate them against Firestore (neither collection exists yet).
- An unrecognized `purpose` → `400 INVALID_REQUEST`.
- A missing/non-positive-integer `amount` for a one-time purpose → `400
  INVALID_REQUEST`.

### ✅ Server-side amount validation — CLOSED for showcase_code/showcase_url in Phase 4; STILL OPEN for "domain"

*(Original Phase 3 text below, kept for the record and for Phase 8. For
the two Showcase purposes the checklist below is now implemented in
`functions/_shared/showcaseCheckout.js`; only `domain` still accepts a
client `amount` and must follow it in Phase 8.)*

The Security Requirements for this phase call for the charged amount to
always come from a Supervisor-set value in Firestore, never a value the
client sends unchecked — otherwise a user could tamper with `amount`
client-side and pay less than the real price.

**That Firestore price source doesn't exist yet** (it's the
`orders`/`domainRequests` records Phase 4 and Phase 8 create). Rather
than invent a temporary schema that risks conflicting with what those
phases actually build, `initialize.js` currently accepts `amount`
directly from the request body for one-time purposes — see the
`SECURITY NOTE` comment right above where `amount` is read in
`initialize.js`.

**This is a known, documented gap, not a design decision to keep.**
Phase 4 (for `showcase_code`/`showcase_url`) and Phase 8 (for
`domain`) MUST, before wiring this endpoint to any real "Buy" button:
1. Look up the real price server-side from the Supervisor-set
   Firestore value (the `showcaseItems` doc's `priceCode`/`priceUrl`,
   or the equivalent domain pricing config).
2. Convert Naira → kobo server-side (`× 100`).
3. Use that computed value as `amount` — ignore whatever (if anything)
   the client sends for `amount`.

Until that happens, this endpoint should not be reachable from a real
purchase button in the UI.

## 4. `webhook.js` — where each later phase plugs in

`webhook.js`'s `charge.success` handler (function `onRequestPost`,
inside the `try` block) now reads `data.metadata.purpose` and
dispatches:

- **`purpose === "subscription"`** (or missing/unrecognized-as-new,
  which is the same thing pre-Phase-3 traffic looks like): runs the
  exact Phase 1 code — `resolveUid` → `setPlan(env, uid, "pro")`.
  Byte-for-byte unchanged logic, just moved one indent level in.
- **`purpose === "showcase_code" || purpose === "showcase_url"`**
  (**implemented in Phase 4**, `fulfillShowcaseOrder()` in `webhook.js`):
  in one Firestore transaction, looks up `orders/{metadata.orderId}` and —
  only if the order's `uid` equals `metadata.uid`, its `type` matches the
  purpose, its status is still `pending_payment`, Paystack's collected
  `amount` (kobo) equals the order's `amount` (Naira) × 100, and the
  currency is NGN — sets `status` to `"paid"` (code) or
  `"awaiting_details"` (url) plus `paystackReference` and `updatedAt`.
  Any mismatch leaves the order untouched and raises a high-severity
  Operations event (`paystack-order-mismatch`); a second, different
  reference for an already-paid order raises `paystack-duplicate-payment`.
  Redeliveries are no-ops. Not gated by "Checkout enabled".
- **`purpose === "domain"`**: currently only `console.log`s the parsed
  event (reference, amount, `metadata.domainRequestId`, customer
  email) with a message starting `"charge.success (one-time,
  purpose=domain) — TODO(Phase 8)"`. The comment directly above it —
  marked `// TODO(Phase 8):` — is exactly where Phase 8 must add the
  real Firestore write to `domainRequests/{domainRequestId}`.
- Any other value: `console.warn`'d and ignored (defensive only —
  `initialize.js` already rejects anything outside the four valid
  purposes before a transaction is ever created, so this branch
  shouldn't be reachable in practice).

No Firestore write was added for the new purposes in Phase 3 — the
`orders`/`domainRequests` collections belong to Phase 4/8, and
inventing a shape now would risk conflicting with what those phases
actually build. (Phase 4 has since added the `orders` write; only
`domainRequests` — Phase 8 — remains.)

**Signature verification is unconditional and unchanged**: every event,
regardless of `purpose` or even whether the body parses as valid JSON
Paystack, is checked against `x-paystack-signature`
(`verifyPaystackSignature`, HMAC-SHA512 of the raw body) before the
body is even parsed. There is no code path — old or new — that skips
this check.

## 5. Amounts and currency

- Paystack's API always wants `amount` in the smallest currency unit —
  **kobo** for NGN (₦1 = 100 kobo).
- The existing subscription flow never sends `amount` at all — the
  ₦1,000/week price lives in the Paystack Plan (`PAYSTACK_PLAN_CODE`),
  not in Neribo's code. This is unchanged.
- `showcaseItems.priceCode` / `showcaseItems.priceUrl` (see
  `docs/PHASE_2_HANDOFF.md` §3) are stored in **Naira**, not kobo.
  `orders.amount` is also **Naira**. Phase 4's
  `showcaseCheckout.js` multiplies by 100 when computing the Paystack
  `amount`, and the webhook multiplies `orders.amount` by 100 again to
  compare against what Paystack collected. Phase 8 must do the same for
  domains.

## 6. Dashboard checklist for Westly (do this in the actual Paystack dashboard)

- [ ] Confirm which Paystack secret key is currently set as
      `PAYSTACK_SECRET_KEY` in Cloudflare Pages (Settings > Environment
      variables, both Production and Preview) — it should be the
      **test** key (`sk_test_...`) until you're deliberately ready to
      accept real payments. Swapping to the live key (`sk_live_...`)
      is a manual, deliberate step for later — nothing in Phase 3
      changes this for you.
- [ ] Confirm the webhook URL registered in Paystack dashboard >
      Settings > API Keys & Webhooks matches your deployed
      `/api/payments/webhook` endpoint. Test mode and Live mode each
      have their own webhook URL field — Phase 1's setup note already
      covers setting the Test one; you'll set the Live one separately
      when you actually go live.
- [ ] Confirm the dashboard's active mode (the Test/Live toggle, top of
      the Paystack dashboard sidebar) is **Test** — this determines
      which key pair and webhook URL are actually in effect, separate
      from what's saved in each field. Stay in Test mode through
      Phase 3's testing checklist below; only switch when you're
      genuinely ready to accept real money.
- [ ] Nothing about Plans changes in Phase 3 — the existing "Neribo Pro
      Weekly" Plan and its `plan_code` are untouched.
