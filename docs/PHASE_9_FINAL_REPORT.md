# Phase 9 Final Report — Integration, QA & Stabilization

**Method and limits.** This pass was a static read of the final codebase (all
handoffs, contracts, `firestore.rules`, every Function, and the client code
that talks to them). It was done without network access or installed
dependencies, so **nothing was built, run, or exercised against Firebase,
Supabase or Paystack**. Everything under "Verified" means "confirmed by
reading the code", not "seen working". The manual walkthroughs at the bottom
still need to be run by Westly.

## Verified (by reading)

- **Supabase is Storage-only.** The only Supabase calls are
  `/storage/v1/...` in `functions/_shared/supabaseFiles.js` and
  `supabaseStorage.js`. Bucket names match `docs/SUPABASE_CONTRACT.md`
  (`neribo-images`, `neribo-showcase-files`), path convention
  `${showcaseItemId}/${filename}` matches. No SQL, tables, RLS, or Supabase
  Realtime anywhere. ("Realtime" in the UI code is Firestore `onSnapshot`.)
- **No secrets in client code.** No service-role, Paystack, or Firebase
  private keys in `src/` or the built `dist/` bundle. The Firebase web config
  in `src/lib/firebase.ts` is public by design.
- **Function auth.** Every function under `functions/api` verifies a Firebase
  ID token, and every `admin/*` function plus `showcase/upload-file` also
  checks Supervisor. Exceptions by design: `payments/webhook` (Paystack
  signature), `admin/reset-expired-quotas` (shared secret),
  `auth/record-login-failure` (pre-auth logging).
- **Server-side amounts.** `initialize.js` computes the amount server-side for
  `showcase_code`, `showcase_url` and `domain`; the client never sends one.
  The webhook re-derives and compares amount, currency and owner inside a
  transaction and is safe against redelivery.
- **Firestore rules.** `showcaseItems`, `orders`, `chatNeriboMessages` and
  `domainRequests` all have rules matching what the client writes. Chat
  Neribo: `create: false`, users may change only `acknowledged`, and no client
  create function exists. Cross-account reads/writes are denied by the
  `uid` checks and by the default deny.
- **Cross-account download.** `orders/get-download` returns the same generic
  404 for wrong owner, wrong type, or unpaid.
- **Nav / Operations wiring.** All original Operations sections remain;
  `showcaseManagement`, `ordersManagement`, `chatNeribo`, `domainsManagement`
  are present in `OperationsSidebar` and `OperationsView`. Component props in
  `App.tsx` match the declared props. No broken imports or leftover
  `Project/Artifact/Code` view names. `tsc` reported no unresolved local
  names or missing exports (its remaining errors are only missing packages).
- **Deploy guide** text is identical in `src/data/deployGuide.ts` and
  `functions/_shared/chatNeriboMessages.js`.

## Bugs found and fixed (items 5-6 implement Westly's decisions)

| # | File | Problem | Fix |
|---|---|---|---|
| 1 | `src/components/Header.tsx` | Header showed the raw nav id, so Chat Neribo read "CHATNERIBO". | Added a `NAV_LABELS` map (`chatNeribo` -> "Chat Neribo"); other ids unchanged. |
| 2 | `src/hooks/useUsageAnalytics.ts` (`SCREEN_LABELS`) | `chatNeribo` and `domains` had no label, so raw ids appeared in analytics. | Added both labels. |
| 3 | `src/lib/showcaseFilesApi.ts` | Client sent `file.name` as-is; the server only accepts `[A-Za-z0-9._ -]`, so names like `site (1).zip` or `café.zip` failed with a confusing error. | New `toSafeUploadFilename()` used for the upload's `filename`; extension kept, disallowed characters become `-`. Output checked against the server's `FILENAME_RE` for several sample names. |
| 4 | `src/lib/domainRequestsPersistence.ts` (`createDomainRequest`) | A retry after a create that had actually landed is treated as an update by the rules and refused, so the user saw an error although the request existed. | On `permission-denied` after a retry, read the doc back; if it exists with the same uid/orderId, return success. Same idea as `submitCloneDetails`. Comment corrected. |
| 5 | `functions/api/orders/get-download.js` | Westly's decision: a code order should end as `"delivered"`. Phase 5 left it at `"paid"` forever. | The first successful download of a `paid` code order now sets `status: "delivered"` (plus `downloadedAt`, `updatedAt`). Orders a Supervisor already moved to `in_progress`/`delivered` are left alone. Download access is unchanged (`paid`/`in_progress`/`delivered` all allowed), so re-downloads keep working. The write stays non-fatal. |
| 6 | `src/components/Workspaces.tsx` | Download button vanished once a code order left `paid` (either by item 5 or a Supervisor override). | Code orders show Download + deploy guide in `paid`, `in_progress` and `delivered` as one block (so the open guide isn't remounted when the status flips live). The generic "We're working on your order" / "Your order has been delivered" lines now apply to non-code orders only. |

## Flagged for Westly's decision (NOT changed)

1. **Upload size cap.** `upload-file.js` accepts 40 MB decoded, sent as
   base64 JSON. Parsing and decoding hold several copies at once, which
   probably exceeds a Cloudflare Function's 128 MB memory near that size.
   Unconfirmed without a runtime test. Options: lower the cap, or upload
   directly to storage with a signed upload URL.
2. **Download popup on mobile.** `window.open` runs after an `await`, so some
   mobile browsers may block the new tab.
3. **Account deletion.** `admin/delete-account.js` does not touch `orders`,
   `domainRequests` or `chatNeriboMessages`; they are left behind (arguably
   right for payment records, but worth a conscious choice).
4. **Domain "Send pricing" order.** Status flips to `awaiting_payment` before
   the Chat Neribo message is sent. If the message fails the user is not
   notified; the Supervisor sees the error and would need to send it from
   Chat Neribo by hand.
5. **Domain price not snapshotted** (already documented in Phase 8 §4): a
   price edit mid-checkout is flagged as a mismatch rather than accepted.

## Not verified — needs a real run

`pnpm build` and `pnpm lint`; publishing `firestore.rules` and testing in the
Rules Playground (Phase 7 §8 and Phase 8 §8 checklists); the five end-to-end
paths in Paystack test mode (raw code, custom URL, domains, plus Chat Neribo
delivery and the auto message); empty/loading/error states; expired signed
URL; and layout on a phone. Pre-existing features (chat streaming, image
generation, subscription pay/cancel, device PIN, IP bans, existing Operations
panels) were read but not run; the subscription branch of the webhook and the
other pre-existing functions look intact.

## Destructive operations

None performed. No push, deploy, or data changes.

## Note on Phase 5 docs

`docs/PHASE_5_HANDOFF.md` still describes the old "code orders stay `paid`"
convention; item 5 above supersedes it. Small race to be aware of: if a
Supervisor changes a `paid` order's status in the same instant the customer
first downloads, the download's `delivered` write can win. Harmless (both
end states are valid) and not guarded.

Also re-test after applying: pay for a code order, tap Download, confirm the
file saves, the pill flips to "Delivered", the Download button stays, and a
second download still works.
