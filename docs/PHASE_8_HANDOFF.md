# Phase 8 Handoff — Domains (manual-fulfillment domain-name requests)

Builds on Phase 3 (Paystack initialize/webhook scaffolding), Phase 4
(Orders + real Showcase fulfillment, whose `resolveShowcaseCheckout` /
`fulfillShowcaseOrder` this phase mirrors closely), and Phase 7 (Chat
Neribo, reused here for the "pricing is ready" notification).

## 1. What Phase 8 adds

Any account with an eligible order (a `type: "url"` order already
`in_progress` or `delivered` — a custom-site build that's underway or
done) can now:

1. Submit 2-5 candidate domain names against that order (Domains ->
   "Request a domain").
2. Wait for a Supervisor (Operations -> Domains Management) to check
   availability and set a price (Naira) for each candidate by hand — no
   registrar API, this is genuinely manual, same spirit as Orders'
   "awaiting_details" step.
3. Once the Supervisor sends pricing, the user picks ONE priced,
   available candidate and pays for it — the actual charge is a real
   Paystack transaction, same rails as Showcase/Orders, closed against
   client-side amount tampering the same way Phase 4 closed it for
   Showcase.
4. The payment webhook marks the request paid, independent of and
   without touching the order it's attached to.

Nothing here changes an existing order's lifecycle, Showcase, or Chat
Neribo's own data — Domains is a strictly additive attachment to an
order that already exists.

## 2. Files

### New

- `src/types.ts` — `DomainRequestStatus`, `DomainPricingEntry`,
  `DomainRequest` (additive to the existing file).
- `src/lib/domainRequestsPersistence.ts` — all client Firestore access
  for `domainRequests` (create, choose, Supervisor pricing update, live
  subscribe, parsing/formatting helpers). Mirrors
  `src/lib/ordersPersistence.ts`'s shape.
- `functions/_shared/domainCheckout.js` — `resolveDomainCheckout`,
  server-side price/ownership resolution for the `"domain"` Paystack
  purpose. Mirrors `functions/_shared/showcaseCheckout.js`'s
  `resolveShowcaseCheckout`.
- `functions/api/admin/set-domains-enabled.js` — Supervisor-gated
  endpoint that flips `appConfig/domains-enabled`. Mirrors
  `set-checkout-enabled.js` exactly.
- `src/hooks/useDomainsEnabled.ts` — live `{ enabled, loading }` read of
  `appConfig/domains-enabled`. Mirrors `useCheckoutEnabled.ts`.
- `src/components/DomainsView.tsx` — the regular-user Domains page.
- `src/components/operations/DomainsManagementPanel.tsx` — the
  Supervisor's Domains Management page.
- `docs/PHASE_8_HANDOFF.md` — this file.

### Modified (all additive except where noted)

- `firestore.rules` — new `domainRequests/{requestId}` block (see §3).
- `functions/api/payments/initialize.js` — the `"domain"` purpose branch
  now calls `resolveDomainCheckout` instead of trusting a client-sent
  `amount` (closes the gap that file's own inline comment had flagged
  since Phase 3); callback URL for `"domain"` now routes to
  `?domains=complete` instead of the generic `?upgrade=complete`.
- `functions/api/payments/webhook.js` — new `fulfillDomainRequest`
  function (replaces the `TODO(Phase 8)` log-only stub), wired into the
  `charge.success` dispatch for purpose `"domain"`.
- `src/lib/paymentsApi.ts` — new `startDomainCheckout(domainRequestId)`.
- `src/lib/operationsActions.ts` — new `setDomainsEnabled(enabled)`.
- `src/components/operations/AppSettingsPanel.tsx` — new
  `DomainsEnabledSetting` row, registered in `APP_SETTINGS`.
- `src/components/OperationsView.tsx` — renders
  `DomainsManagementPanel` for `section === "domainsManagement"`.
- `src/components/OperationsSidebar.tsx` — new "Domains Management" nav
  item.
- `src/components/SidebarDrawer.tsx` — new "Domains" nav item, shown only
  when `domainsEnabled && domainsEligible` (both new, optional props).
- `src/App.tsx` — wires `useDomainsEnabled()`, a live
  `subscribeToDomainRequests` listener (page-gated, like orders),
  `domainsEligible` (derived from the existing `orders` state — see
  §9's note on `needsOrdersData`), the `DomainsView` render, the
  `?domains=complete` redirect handler, and the new `SidebarDrawer`
  props.

## 3. Data model and rules

One document per request in the top-level `domainRequests` collection
(`id` also stored in the body, same convention as `Order` /
`ChatNeriboMessage`):

```
domainRequests/{id}
  id: string
  uid: string                        // owner
  orderId: string                    // the eligible order this attaches to
  candidates: string[]               // 2-5, as submitted
  status: "submitted" | "checked" | "awaiting_payment" | "paid"
  pricing: { domain, available, price }[]   // parallel to candidates by index
  chosenDomain: string | null        // see "Deviation from the brief" below
  paystackReference: string | null
  createdAt: string
  updatedAt: string
```

**Deviation from the brief's field list: `chosenDomain`.** The brief's
schema (id, uid, orderId, candidates, status, pricing, paystackReference,
createdAt, updatedAt) has no field for which priced candidate the user
actually wants to pay for — but a request can have several available,
priced candidates, so something has to record the one choice. Added
`chosenDomain`, gated by `firestore.rules` to only ever be set (by the
owner, only while `status === "awaiting_payment"`) to a candidate that
`pricing` actually marks available with a set price. Same precedent as
Order's `showcaseItemTitle` (also not in the Phase 4 brief's literal
field list, also added because the flow didn't work without it).

**`firestore.rules`' `domainRequests` block**, in short (full reasoning
is in the rules file's own comments):

- **Read**: owner or Supervisor.
- **Create** (owner only): 2-5 domain-shaped strings, `status:
  "submitted"`, `pricing: []`, `chosenDomain`/`paystackReference` both
  null, `orderId` pointing at the caller's own `type: "url"` order
  already `in_progress`/`delivered`.
- **Update**, two non-overlapping paths:
  - Supervisor: `status` + `pricing` + `paystackReference` +
    `updatedAt`. `pricing` must stay the same length as `candidates` and
    parallel to it by index (`pricing[i].domain == candidates[i]`) —
    checked per-slot, bounded at 5. A manual override straight to
    `"paid"` is allowed, same escape-hatch precedent as `orders`.
  - Owner, only while `status == "awaiting_payment"`: `chosenDomain` +
    `updatedAt` only, and only to a candidate `pricing` marks available
    with a price.
- **Delete**: nobody.

`status` and `paystackReference` are therefore never client-writable by
a request's own owner — only a Supervisor or the payment webhook
(service account) can change them, same shape as `orders`.

## 4. Payment contract

`POST /api/payments/initialize` with `purpose: "domain"` and
`metadata.domainRequestId` (no `amount` — same shape as
`showcase_code`/`showcase_url`). Server-side (`resolveDomainCheckout`):

1. Reads `appConfig/checkout-enabled` (the SAME sitewide pause every
   other Paystack purchase respects — deliberately NOT
   `appConfig/domains-enabled`, which is display-only, see §5).
2. Reads `domainRequests/{domainRequestId}`, confirms `uid` matches the
   verified ID token.
3. Confirms `status === "awaiting_payment"` and `chosenDomain` is set.
4. Looks up `chosenDomain`'s index in `candidates` and reads the SAME
   index out of `pricing` (never trusting a `domain` field inside a
   pricing entry over its position) — confirms `available === true` and
   a positive `price`.
5. `amountKobo = Math.round(price * 100)`.

`functions/api/payments/webhook.js`'s `fulfillDomainRequest`
independently re-derives the same expected amount at confirmation time
(never trusts what `initialize.js` computed earlier) inside one
transaction, matches it against what Paystack actually collected, and
only then writes `status: "paid"`, `paystackReference`, `updatedAt`.
Mismatches (amount, currency, uid, missing/unavailable price, no
`chosenDomain`) change nothing and raise a high-severity Operations
event instead — same idempotent, defense-in-depth shape as Phase 4's
`fulfillShowcaseOrder`.

**Known limitation, documented rather than engineered around:** the
price a Supervisor set is read fresh both at `initialize.js` time and
again at webhook time, straight from the live `pricing` array — there is
no snapshot of "the price that was actually agreed to" stored anywhere
in between (unlike Showcase orders, where `initialize.js` patches the
order's own `amount` field as the single source of truth the webhook
later checks against). If a Supervisor changes a price in the narrow
window between a user starting checkout and Paystack confirming it, the
webhook's re-check will disagree with what was actually charged and the
payment will be flagged as a mismatch rather than silently accepted at
the old price. This is an edge case (Supervisor edits mid-checkout) and
fails safe (into a flagged Operations event, not into a lost payment or
a wrong price silently accepted).

## 5. The "Domains enabled" switch

`appConfig/domains-enabled`, set from Operations -> App Settings
(`DomainsEnabledSetting`), read live via `useDomainsEnabled()`.
**Display-only**, exactly as specified: it only hides the regular-user
"Domains" nav item (even for an eligible account); it is never read by
any `functions/` code, so it can never block a payment, and Domains
Management keeps working while it's off. This is a deliberately
DIFFERENT switch from `appConfig/checkout-enabled` (the actual payment
kill-switch — see §4).

## 6. UI behaviour

- **DomainsView** (regular user): shown only once the account has at
  least one eligible order. A submission form (parses free-text
  candidates, 2-5, domain-shaped) and a live list of the account's own
  requests, each showing its status pill, priced/available candidates
  once ready, a "Select" control per candidate while
  `awaiting_payment`, and a "Pay for `<domain>`" button once one is
  chosen. Redirects to Paystack via `startDomainCheckout`; lands back
  via `?domains=complete`.
- **DomainsManagementPanel** (Supervisor): every request, live,
  filterable by status, searchable by domain/email/uid/request/order id.
  Per request: an inline pricing editor (checkbox + price per
  candidate, saved as `status: "checked"`), a "Send pricing" button
  (only once at least one candidate is priced+available — sets `status:
  "awaiting_payment"` AND sends a Chat Neribo message listing the
  available options), and a manual status override dropdown (including
  straight to `"paid"`, for fixing a stuck payment by hand).

## 7. What was verified, and what was not

**Verified by careful reading against the existing codebase's own
patterns** (no build tooling / `node_modules` available in this
environment, so nothing here was compiled, type-checked, or run):

- `firestore.rules`' new block: brace/paren-balanced; every function and
  field check modeled directly on the existing `orders` block's
  equivalents, re-read line by line against that block's own comments.
- `functions/_shared/domainCheckout.js` and the `fulfillDomainRequest`
  addition to `webhook.js`: syntax-checked with `node --check`; every
  Firestore-client function used (`batchGetDocuments`, `withTransaction`,
  `getInTransaction`, `commitTransaction`, `reportOperationsEvent`) was
  confirmed already imported/available in that file, and used with the
  exact same call shape `fulfillShowcaseOrder` already uses.
- Every new TS/TSX file's imports were checked, one by one, against the
  actual exported names in the files they import from (not assumed from
  memory) — including catching and fixing two real mistakes during
  review: `useDomainsEnabled` initially returned a bare `boolean`
  (mismatched with how `AppSettingsPanel.tsx` and the rest of the
  codebase consume `useCheckoutEnabled`'s `{ enabled, loading }` shape)
  and `toSafeMessage`'s call signature was initially guessed wrong in
  `DomainsManagementPanel.tsx`. Both were caught by re-reading the real
  source and fixed before delivery.

**NOT verified** (would need this repo's actual toolchain, which this
environment doesn't have):

- No `tsc`/`vite build`/lint pass — there could still be a TypeScript
  type error this review missed.
- No Firebase emulator run against the new `firestore.rules` block — the
  rule logic was reasoned through by hand, not tested against real
  writes.
- No end-to-end payment test against a real (or sandboxed) Paystack
  account.
- `useRealtimeFeed`'s exact generic signature was read from its first
  ~80 lines and from `OrdersManagementPanel.tsx`'s own call site, not
  from its full implementation — `DomainsManagementPanel.tsx`'s call
  mirrors that call site exactly, but wasn't independently exercised.

## 8. Test checklist for Phase 9 (or whoever verifies this first)

1. Deploy `firestore.rules`; confirm a regular account can create a
   domain request only against its own eligible order, cannot set
   `status`/`pricing`/`paystackReference` directly, and can only set
   `chosenDomain` to an actually-priced-available candidate while
   `awaiting_payment`.
2. As Supervisor: mark pricing, confirm the write rejects a
   mismatched-length or out-of-order `pricing` array (shouldn't be
   reachable from the UI, but rules should refuse it regardless).
3. "Send pricing" — confirm the Chat Neribo message arrives, and that
   `status` flips to `awaiting_payment`.
4. As the owner: select a priced candidate, pay via Paystack sandbox,
   confirm `status` flips to `paid` via the webhook and the browser
   lands back on Domains via `?domains=complete`.
5. Tamper test: attempt to POST `/api/payments/initialize` with
   `purpose: "domain"` and a fabricated `amount` — confirm it's ignored
   and the real Supervisor-set price is what's actually charged.
6. Toggle `appConfig/domains-enabled` off: confirm the nav item hides
   for an eligible account but Domains Management still works and an
   in-flight payment still completes.

## 9. Known limitations / notes for later

- See §4's note on price re-derivation being read live rather than
  snapshotted — the one deliberate, documented gap in this phase's
  otherwise-Phase-4-mirrored payment integrity story.
- `App.tsx`'s `needsOrdersData` now also loads the orders list whenever
  `domainsEnabled` is on (not just while Orders/Showcase is open), so
  the sidebar can decide whether to show "Domains" before the user ever
  opens Orders. This is an extra Firestore read for every signed-in
  regular account while the switch is on — the same "listen sitewide so
  the sidebar can decide" tradeoff Phase 7 already made for
  `chatNeriboEnabled`/the unread badge, just applied to an existing
  collection instead of a new one.
- No registrar integration of any kind, by design — Domains is
  manual-fulfillment end to end, same as the brief specifies.
