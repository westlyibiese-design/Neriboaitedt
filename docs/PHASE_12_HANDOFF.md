# Phase 12 Handoff — per-slot image upload, routed to Telegram

Scope: for a paid `type: "url"` order at `awaiting_images`, the customer uploads
one image per Showcase image slot. Each image is sent to a **Telegram chat via
the Bot API**; Firestore keeps only a pointer. When every slot has an image the
server moves the order to `in_progress`.

**No Supabase code was touched anywhere in this phase.** No file imports
`supabaseFiles.js` / `supabaseStorage.js`, no bucket was created, and
`docs/SUPABASE_CONTRACT.md` is unchanged. This phase is the one deliberate,
narrow exception to the project's "files go to Supabase" rule (Westly's cost
decision). It is called out in comments in every new file.

## What changed

| File | Change |
| --- | --- |
| `functions/api/orders/upload-clone-image.js` | **New.** `GET` = the order's slot list + which are received. `POST` = upload one image. The **only** place Telegram is called and the only writer of `cloneImages`. |
| `functions/_shared/cloneImages.js` | **New.** Pure helpers: limits, slot list, byte-level image sniffing, filename cleaning, caption builder, completeness check. No network, no secrets. |
| `src/lib/cloneImagesApi.ts` | **New.** Browser client (GET slots, XHR upload with progress) + advisory client-side file checks. |
| `src/components/OrderImageUpload.tsx` | **New.** The per-slot upload UI. Treats a slot as received only when its `cloneImages` entry is `verified`. |
| `src/components/Workspaces.tsx` | Replaces Phase 11's "not ready yet" placeholder with `OrderImageUpload`; keeps it mounted through the status flip; avoids a duplicate "working on your order" block. |
| `src/components/OrderIntake.tsx` | Two small display edits (no logic): the completion copy no longer says the images step "isn't ready"; the status it shows follows the **live** order so it stops saying "next we'll need images" once they're in. |
| `src/components/operations/OrdersManagementPanel.tsx` | New "Customer images (in Telegram)" checklist per order: each slot received / not received, original filename, time, and the order id to search for in Telegram. Counts only `verified` entries as received. |
| `firestore.rules` | **New.** The owner of an `awaiting_images` `type: "url"` order may append ONE entry to `cloneImages` per write (own rules block; nothing else changed). See "Firestore rules" below. |
| `src/types.ts` | `CloneImageEntry` (now includes `verified: boolean`); `Order.cloneImages?`. |
| `src/lib/ordersPersistence.ts` | `toOrder` reads `cloneImages` (including `verified`) via a new tolerant `toCloneImages`. |

Not changed (byte-identical): `functions/api/orders/intake-chat.js`,
`functions/_shared/orderIntake.js`, the payment code, and everything
Supabase-related. (`OrdersManagementPanel.tsx` only gained the new checklist
and a one-time item-slot load; its existing rows and status override are
untouched. `firestore.rules` gained exactly one new update path — see below —
every existing rule is otherwise unchanged.)

## One-time manual setup (Westly — do this before deploying)

1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts, copy
   the **bot token** (looks like `123456789:ABC-DEF...`).
2. Choose where images land, then get the numeric **chat id**:
   - **Your own chat with the bot:** open the bot and press **Start** (bots can't
     message you first), send it any message, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
     `message.chat.id` (a positive number).
   - **A private channel:** create it, add the bot as an **admin** (it needs
     permission to post), post any message in the channel, then read
     `channel_post.chat.id` from the same `getUpdates` page. It starts with `-100`.
3. Cloudflare Pages → your project → Settings → Environment variables → add
   `TELEGRAM_BOT_TOKEN` (mark it a secret) and `TELEGRAM_CHAT_ID`, for Production
   (and Preview if you use it). **New values only apply to a new deployment.**
4. Treat the token like `PAYSTACK_SECRET_KEY`: never paste it into chat or commit
   it. (The `getUpdates` URL in step 2 contains it — don't share that URL.)

If either variable is missing, uploads fail with a calm 503 for the customer and
a **high**-severity Operations event (`clone-image-config`). Nothing else breaks.

## API

### `GET /api/orders/upload-clone-image?orderId=<id>`

Auth: `Authorization: Bearer <Firebase ID token>`. Returns:

```json
{
  "orderStatus": "awaiting_images",
  "slots": [{ "index": 0, "label": "Logo", "description": "…" }],
  "received": [{ "slotIndex": 0, "slotLabel": "Logo", "originalFilename": "logo.png", "uploadedAt": "…" }],
  "limits": { "maxBytes": 10485760, "allowedTypes": ["image/png","image/jpeg","image/webp","image/gif"] }
}
```

The slots are read server-side (service account) so this still works if the
Supervisor hides the item after purchase (customers can't read hidden items).
Telegram ids are never returned to the browser.

### `POST /api/orders/upload-clone-image?orderId=<id>&slot=<index>&label=<label>&filename=<name>`

Headers: `Authorization: Bearer …`, `Content-Type: image/…`. **Body: the raw image
bytes** (no base64, no multipart). Metadata is in the query string so every check
runs before the file is read, and there's no base64 decode loop burning Worker CPU.

Success `200`:

```json
{ "received": { "slotIndex": 1, "slotLabel": "…", "originalFilename": "…", "uploadedAt": "…" },
  "progress": { "received": 2, "total": 3 }, "orderStatus": "awaiting_images", "allReceived": false }
```

Error codes (`{ "error": { "code", "message" } }`): `AUTH_ERROR` 401,
`FORBIDDEN`/`ACCOUNT_SUSPENDED` 403, `NOT_FOUND` 404 (someone else's / missing /
code order — all identical), `ORDER_NOT_ACCEPTING_IMAGES` 409 (owner only),
`NO_IMAGE_SLOTS` 409, `SLOTS_CHANGED` 409, `SLOT_ALREADY_RECEIVED` 409,
`INVALID_REQUEST` 400, `EMPTY_FILE` 400, `UNSUPPORTED_TYPE` 415,
`FILE_TOO_LARGE` 413, `IMAGE_REJECTED` 422, `UPLOAD_UNAVAILABLE` 503,
`SAVE_FAILED` 500, `SERVER_ERROR` 500.

## Final `cloneImages` shape (`orders/{id}.cloneImages`)

```ts
interface CloneImageEntry {
  slotIndex: number;        // position in the item's usable imageSlots  ← ADDED (see decisions)
  slotLabel: string;        // slot label at upload time
  telegramMessageId: number;
  telegramFileId: string;   // document.file_id ("" if Telegram omitted it)
  originalFilename: string; // cleaned: no path parts/control chars, extension matches the verified type
  uploadedAt: string;       // ISO
  verified: boolean;        // true ONLY when this function wrote it, after Telegram accepted the image.
                             // A client can never set this (see "Firestore rules" below) — everything
                             // that decides "is this slot filled" filters to verified === true.
}
```

An array in arrival order. Absent until the first upload. **Image bytes are never
stored** — only this pointer. `slotIndex` indexes the item's `imageSlots` **with
blank-label entries removed** (the same rule Phase 11's `countImageSlots` uses);
the server and the Supervisor panel both build that list the same way. The
array can contain entries a customer wrote directly (see "Firestore rules"),
but only `verified: true` entries are ever treated as real.

## The exact Telegram call

`POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendDocument`, multipart:

| Field | Value |
| --- | --- |
| `chat_id` | `TELEGRAM_CHAT_ID` |
| `document` | the file, under the cleaned original filename, with the **verified** MIME type |
| `caption` | plain text (no `parse_mode` is ever set) |
| `disable_content_type_detection` | `true` |

Only `message_id` and `document.file_id` are read from the response. 25 s timeout.

**Caption format** (4 lines, each cleaned to one line, ≤ 1024 chars total):

```
Order: <orderId>
Item: <showcaseItemTitle>
Slot 2 of 5: <slot label>
File: <original filename>
```

To find a customer's images: open Telegram and **search for the order id** (it's
shown in the Orders Management checklist).

**Why `sendDocument`, not `sendPhoto`:** `sendPhoto` re-compresses the image,
drops the filename, rejects extreme aspect ratios/dimensions and caps at ~10 MB.
You need the customer's real logo/photos to build from, so `sendDocument`
preserves the exact bytes and name. Trade-off: in Telegram they appear as file
cards with a small thumbnail rather than large inline previews — tap to view.

## Limits enforced (server-side; constants in `functions/_shared/cloneImages.js`)

- **Size:** 10 MB per image. Telegram itself allows ~50 MB for documents; ours is
  lower because the whole file sits in Worker memory (128 MB) while forwarded.
  Checked from `Content-Length` before reading, **and** while reading (a chunked/
  lying upload is cut off at the cap, never buffered whole), and again on the bytes.
- **Types:** PNG, JPEG, WebP, GIF, decided **from the file's own bytes**
  (`sniffImageType` checks the signature plus the next structural bytes — PNG's
  IHDR, a JPEG marker, WebP's first chunk name). The declared `Content-Type` is
  only used to refuse a request that announces itself as something else (e.g.
  `application/pdf`). HEIC and SVG are rejected on purpose.
- **Slots:** the slot must exist on the item *now*, and the label the browser
  sends must equal that slot's label (otherwise `SLOTS_CHANGED`). Max 12 slots
  (Phase 10's cap). One image per slot.
- **Filenames:** stripped of path parts, control/zero-width/bidi characters and
  leading dots; ≤ 100 chars; extension forced to match the verified type.

## Security checks (every call, GET and POST)

1. Verified Firebase ID token → `uid` (never from the request).
2. IP ban and suspended-account checks (same as `intake-chat.js`). The "flagged"
   restriction is intentionally **not** applied — it exists to stop AI replies.
3. `orders/{id}` exists, `uid` matches, `type === "url"` → else one generic 404.
4. `status === "awaiting_images"` → else 409 (only the owner ever sees this).
5. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are read from `env` only, used only in
   `upload-clone-image.js`, and never returned, logged or put in an Operations
   event (error text is scrubbed of the token before logging).
6. The write is a Firestore **transaction** that re-reads the order **and** the
   Showcase item, re-checks every rule above plus "slot still empty", appends the
   entry, and — only if every slot now has an entry — sets `in_progress`. Two
   uploads at once can't overwrite each other; completeness is decided
   server-side against the slot list as of commit time.

## Firestore rules — owner-write, made safe with a `verified` flag

You asked for the owner-write rule from the brief's item 3, so `firestore.rules`
now has one: while an order is `type: "url"` and `status: "awaiting_images"`,
its owner may `update` it appending **exactly one** well-formed entry to
`cloneImages` per write (touching only `cloneImages` + `updatedAt`; every
earlier entry in the array must stay byte-identical — enforced index by index,
the same technique the rules already use for `exampleSites`). The new
`isValidCloneImageEntry` / `isValidOwnerCloneImageAppend` functions and the new
branch on `orders/{orderId}`'s `allow update` are the only changes to the file.

The problem this raises (and how it's closed): rules can't tell whether an
image actually reached Telegram, so a plain owner-write rule would let a
customer write a fake "received" entry for a slot they never uploaded, then
have the real last upload flip the order to `in_progress` without every image
actually being there. **The fix is a `verified` boolean.** `isValidCloneImageEntry`
does not include `verified` in the fields a client may set (`hasOnly` excludes
it), so a client-written entry always ends up with `verified` absent /
falsy. `functions/_shared/cloneImages.js` (`verifiedEntries`) and
`upload-clone-image.js` treat entries as real **only** when `verified === true`
— which only that function ever sets, and only after Telegram has accepted the
image. Every decision (is a slot filled, is the order complete, what a customer
or Supervisor is told is "received") goes through that filter, in four places:

- `upload-clone-image.js`'s `GET` (what the customer sees as already uploaded)
- `upload-clone-image.js`'s upload transaction (what counts as "already filled"
  and what feeds `allSlotsFilled`) — it also **rewrites `cloneImages` from only
  the verified entries** on every real upload, so a forged entry doesn't even
  persist past the next genuine one
- `src/components/OrderImageUpload.tsx` (the customer's own "Received" display)
- `src/components/operations/OrdersManagementPanel.tsx` (the Supervisor
  checklist)

So a client-written entry can be *displayed* nowhere as received, can never
mark a slot filled, and can never complete an order — the actual gate is still
"Telegram accepted this image," decided only by the trusted backend, exactly
as before. Phase 11's `cloneDetailsV2` still has no owner-write path at all
(unchanged) — that field's validation is far more involved (a whole AI
conversation) and this pattern doesn't fit it.

**Please confirm in the Rules Playground:**
1. Owner appends one well-formed `cloneImages` entry to an `awaiting_images`
   `url` order, touching only `cloneImages` + `updatedAt` → **allowed**.
2. Same, but the entry includes `verified: true` → **denied** (extra key).
3. Same, but it rewrites/removes an earlier entry, or appends two at once →
   **denied**.
4. Same, but the order's `status` isn't `awaiting_images`, or `type` isn't
   `url` → **denied**.
5. A different user's order → **denied** (unchanged, but worth re-checking).

## Operations events (Supervisor console)

| `context` | Severity | Meaning |
| --- | --- | --- |
| `clone-image-config` | high | Env vars missing. |
| `clone-image-telegram-config` | high | Bad token / chat not found / bot lacks rights. |
| `clone-image-telegram-rate` / `-network` / `-rejected` / `-malformed` | medium | Rate-limited / unreachable or 5xx / Telegram refused the file / unusable reply. |
| `clone-image-not-recorded` | medium (low if `already-received`) | Telegram accepted an image but the order wasn't updated. `technical.telegramMessageId` says which message is orphaned. |

## Verification performed (my sandbox: no network, no Firebase, no Telegram)

- **39 Node tests** for `upload-clone-image.js` + helpers against an in-memory
  Firestore (real value encoding, real transaction conflict detection) and a fake
  Telegram: full 3-slot flow and exact caption/filename/shape; out-of-order;
  1-slot and 12-slot items; blank-label slots; non-image/lying-MIME/empty/oversized
  (announced and chunked)/exactly-10 MB; wrong user/missing/code order; every
  non-`awaiting_images` status; out-of-range/wrong-label/filled slot; malformed
  query; suspended/banned; hidden item; every Telegram failure mode with the
  token absent from responses, logs and events; Firestore commit failure then
  retry; two simultaneous uploads (different slots → both land, flips once; same
  slot → one wins); Supervisor editing/adding slots or overriding status mid-way;
  **an unverified (owner-written-style) entry never blocks a slot, is never
  returned as received, and is dropped the next time the endpoint writes the
  order — even when every slot appears covered by unverified entries.**
  I also broke the code eight ways on purpose (including two that make
  verification a no-op); the tests caught each.
- **18 browser tests** of the real `OrderImageUpload` in headless Chromium at
  390 px width (mocked endpoint): load, validation messages (type/size/HEIC/
  empty), Send-gating, change/remove, full sequential flow and request shape,
  failure + resume, rejected file, `SLOTS_CHANGED`, `SLOT_ALREADY_RECEIVED`,
  network drop (+ permanent-vs-retryable), reload mid-way, 1 and 12 slots, load
  failure, in-progress-on-load, **and an unverified entry not reading as
  received (the slot stays open to choose and send for real).**
- **8 browser tests** of the real `OrdersManagementPanel` list: received/missing,
  collapsed when complete, absent when irrelevant, slots unavailable, item
  deleted, slot list shrank, **and an unverified entry not counted as received.**
- `tsc` (with stubbed libraries) reports **no new errors** versus the original,
  including after this round's changes.

## NOT verified — please do these

1. **`pnpm build`** — I couldn't run it (no dependencies/network here).
2. **A real Telegram delivery:** the message arrives in the right chat with the
   4-line caption, original filename and the file opens as an image.
3. **A real Firestore transaction reading two documents** (order + item). It is
   supported by Firestore, and my fake models it, but I couldn't hit the real API.
4. **Cloudflare limits on your plan:** a 10 MB upload's CPU/memory. It uses no
   base64 and no per-byte loops, so it should be light — but try a ~9 MB photo.
5. **Real phones:** the Android/iOS file picker and camera, on a slow network.
6. **Rules Playground:** the five cases listed under "Firestore rules" above.
7. **End to end:** buy a custom-URL item whose slots you defined → finish the
   chat → upload every slot → the order becomes "in progress", Orders Management
   shows all received, and Telegram has one message per slot. Then try:
   an 11 MB image, a `.pdf` renamed `.png`, closing the tab midway and coming
   back, and a second device uploading a slot already filled.

## Known limits / decisions to confirm

1. **`slotIndex` added to the entry shape** (the brief listed five fields). Phase
   10 says to key uploads by index, not label.
1. **The owner-write rule only lets the customer WRITE a record of an attempt,
   never mark anything received.** See "Firestore rules" above for the full
   reasoning. Nothing in the app actually uses this path today (the real
   upload always goes through the endpoint) — it exists because you asked for
   it, and it's harmless because of the `verified` flag. If you'd rather not
   carry that rule at all (since the app doesn't use it), say so and I'll
   remove it — the endpoint's own security doesn't depend on it either way.
2. **No replacing a sent image.** The customer can change a file freely *before*
   sending; once a slot is received it's locked. Allowing replacement means a
   per-order upload cap and duplicate Telegram messages — say if you want it.
3. **Image check is header-level, not a full decode** (Workers has no image
   decoder). A file that starts like a PNG but is corrupt further in would pass;
   it only ever goes to a Telegram chat, where nothing executes it.
4. **Orphan/duplicate Telegram messages are possible in rare failures** (Telegram
   accepts, then the Firestore save fails; or two uploads for the same slot race).
   The customer's retry can then send a duplicate. The `clone-image-not-recorded`
   event carries the message id so you can tell which is which.
5. **Late Supervisor edits:** if the slot list changes mid-upload the customer is
   told to choose again; a slot **added** after some uploads simply means the
   order doesn't complete until it's filled (and the Supervisor can override
   status by hand as before). A slot **removed** after upload leaves an entry the
   panel labels "no longer a slot on the item".
6. **No client-side resizing** of large phone photos: a >10 MB photo is refused
   with a clear message rather than silently degraded.
7. **Out of scope, as briefed:** no in-app image viewer and no Telegram
   file-download proxy. You find the images by opening Telegram and matching the
   caption. `telegramFileId` / `telegramMessageId` are stored so a future phase
   could build a viewer.
