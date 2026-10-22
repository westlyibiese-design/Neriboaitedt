# Phase 1 Handoff — Foundation & Navigation Renaming

**Phase 2: read this before touching anything.**

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

**Heads-up for Phase 2:** because active items are readable by any signed-in
account, `fileRef` is too. It's only a path (bucket stays private, access only
via signed URLs), but if you want the path hidden from regular users, put it in
a Supervisor-only document instead of trying to hide one field with rules.

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

- Supabase, Paystack, `chatPersistence.ts`, `checkSupervisorRole.js`,
  `useIsOperations()`, `functions/api/payments/*`, `supabaseStorage.js`:
  untouched.
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
