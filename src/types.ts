export interface UserAccount {
  id: string;
  name: string;
  nickname?: string;
  email: string;
  avatarType: "initials" | "image" | "icon";
  avatarValue?: string;
  bgColor?: string;
  badge?: string;
  plan?: "Free" | "Pro" | "Team";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
  liked?: boolean;
  disliked?: boolean;
  // Present only for image-generation replies (Neribo.ai Art). For
  // messages created going forward, this is a long-expiry Supabase
  // Storage signed URL (https://...) — the actual image bytes live in
  // Supabase, not Firestore, keeping this field a short string (see
  // functions/api/images/store.js and src/lib/neriboApi.ts's
  // storeGeneratedImage()). Messages saved before this changed may still
  // hold a legacy base64 `data:` URL; no migration of those is done, and
  // both forms render identically via <img src>, so no rendering code
  // needs to branch on which kind a given message has.
  imageUrl?: string;
  // Present only on a USER message that attached an image via the chat
  // composer's "+" button (see src/components/ChatView.tsx's
  // handleFileSelect and src/App.tsx's handleSendMessage) — distinct
  // from imageUrl above, which is only ever an assistant/Art-generated
  // image, so the two never collide on one message. Set optimistically
  // to a local base64 `data:` URL the instant the message is sent, then
  // swapped in-place for a short Supabase Storage signed URL once the
  // upload finishes (see src/lib/neriboApi.ts's storeChatImage) — never
  // left as a raw base64 string in what gets persisted to Firestore,
  // since a chat thread is one Firestore document and base64 image data
  // would risk that document's 1 MiB size limit.
  userImageUrl?: string;
  // Present only on the canned redirect reply sent when a message was
  // routed between a text model and Neribo.ai Art (see
  // src/lib/intentDetection.ts and src/App.tsx's handleSendMessage/
  // handleRegenerate). Rendered by ChatView as one button per target so
  // the user can jump straight to the right model with their original
  // prompt already filled in, instead of retyping it.
  routeSuggestion?: {
    prompt: string;
    targets: { modelId: string; label: string }[];
  };
  // Present only on a reply from Neribo.search (see src/lib/neriboApi.ts's
  // searchWeb() and functions/api/search/query.js). Unlike every other
  // assistant message, a Neribo.search reply has no AI-generated
  // `content` — ChatView renders this list of raw results (title, link,
  // snippet) instead of a markdown bubble. Never present together with
  // imageUrl or routeSuggestion on the same message.
  searchResults?: { title: string; url: string; snippet: string }[];
}

export interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  model?: string;
}

export interface ProjectItem {
  id: string;
  title: string;
  description: string;
  filesCount: number;
  updatedAt: string;
  tag: string;
  icon?: string;
}

// One curated Showcase entry — a downloadable project/template Westly posts
// himself (Phase 1 of the Showcase/Orders build). This is what the old
// `ArtifactItem` (the "Artifacts" nav) became: renamed rather than kept,
// since only four files actually referenced the type (types.ts, App.tsx,
// mockData.ts, Workspaces.tsx). The old chat-snippet fields (`type`,
// `content`, `language`, `size`) were dropped along with the auto-created
// Artifacts they described — nothing curates or displays them anymore.
//
// Persisted as one document per item in the top-level Firestore collection
// `showcaseItems` (see src/lib/showcasePersistence.ts and
// docs/PHASE_1_HANDOFF.md for the exact stored shape). `id` is the
// document id and is NOT stored inside the document body.
// PHASE 10: one labeled image the buyer of a custom-URL item will be asked
// to supply (e.g. { label: "Logo", description: "Square PNG, used in the
// header" }). The Supervisor defines an ORDERED list of these per Showcase
// item (ShowcaseItem.imageSlots). Position in the list is the slot's
// identity — labels are kept unique by the Supervisor form, but firestore.rules
// cannot enforce that, so later phases should key by index, not by label.
// Limits (mirrored in firestore.rules' isValidShowcaseItem — change both
// together): label 1–60 characters; description 0–300 characters (may be
// empty); at most 12 slots per item. See docs/PHASE_10_HANDOFF.md.
export interface ImageSlotDef {
  label: string;
  description: string;
}

export interface ShowcaseItem {
  id: string;
  title: string;
  description: string;
  /** Naira price for the raw-code download. null/absent = not offered. */
  priceCode?: number | null;
  /** Naira price for the custom URL/clone service. null/absent = not offered. */
  priceUrl?: number | null;
  /** Whether regular users can see this item. Defaults to true for a new item. */
  active: boolean;
  /** Placeholder for the Supabase Storage path of the downloadable
   * files — Phase 2 populates this. Unused (never read for display or
   * logic) in Phase 1; the Supervisor form just lets it be typed in. */
  fileRef?: string | null;
  /** Deployed preview link (http/https). Populated and used in Phase 1:
   * the Live page lists every active item that has one. */
  liveUrl?: string | null;
  /** PHASE 10: the Supervisor's free-text brief of what he needs to know
   * to build THIS kind of site (1–8,000 characters when present; no fixed
   * structure). null/absent = no brief. Only meaningful for an item that
   * offers the custom-URL service (priceUrl set); the Supervisor form only
   * shows it then. Not read by any user-facing screen yet (Phase 11). */
  detailsBrief?: string | null;
  /** PHASE 10: ordered list of labeled image slots the buyer will be asked
   * to fill (1–12 entries when present). null/absent = no image slots.
   * Same visibility rule as detailsBrief. Not read by any user-facing
   * screen yet (Phase 12). */
  imageSlots?: ImageSlotDef[] | null;
  /** ISO timestamps (same convention as ChatThread.createdAt/updatedAt). */
  createdAt: string;
  updatedAt: string;
}

// Which paid path an Order is on. `null` while the order is only a free
// bookmark ("Add to Orders") — set to "code" or "url" the moment the user
// clicks one of the two checkout buttons in Orders (Phase 4).
export type OrderType = "code" | "url";

// Exactly six values exist; docs/PHASE_4_HANDOFF.md lists what triggers
// each transition, and docs/PHASE_11_HANDOFF.md adds "awaiting_images"
// (PHASE 11: a custom-URL order whose AI intake conversation is complete but
// whose Showcase item still needs images from the customer — set only by
// functions/api/orders/intake-chat.js, or by a Supervisor by hand).
export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "awaiting_details"
  | "awaiting_images"
  | "in_progress"
  | "delivered";

// PHASE 6: what a customer tells us about the site they paid for, after a
// `type: "url"` order is paid (status "awaiting_details"). Stored as a
// single map field `cloneDetails` on the order document — see
// docs/PHASE_6_HANDOFF.md for why it is an object and not a subcollection.
// PHASE 14: this shape's write path (the owner submitting it directly,
// firestore.rules' now-removed isValidOwnerIntake) was removed once the
// AI-driven intake (Phase 11, `cloneDetailsV2` below) fully replaced it.
// This type and its length caps (CLONE_DETAILS_LIMITS in
// src/lib/ordersPersistence.ts) still exist purely to read/display
// `cloneDetails` on orders that already have it from before that phase.
export interface CloneDetails {
  /** Site / business name. Required, 1-120 chars. */
  siteName: string;
  /** What the site is for. Required, 1-1500 chars. */
  purpose: string;
  /** Key sections / pages wanted. Required, 1-1500 chars. */
  sections: string;
  /** Existing branding as text/links (logo, colours, fonts). Optional —
   * always present, "" when the customer skipped it. Max 1500 chars. */
  branding: string;
  /** Example sites the customer likes. http(s) URLs only, 0-5 entries,
   * each max 500 chars. */
  exampleSites: string[];
  /** How to follow up (email / phone / WhatsApp, free text). Required,
   * 1-300 chars. */
  contact: string;
  /** ISO timestamp of submission. Always equals the order's `updatedAt`
   * at that moment (the rules enforce it). */
  submittedAt: string;
}

// PHASE 11: what a customer told the AI intake assistant, as the dynamic
// replacement for the fixed CloneDetails shape above. One entry per customer
// message, in order: `answer` is the customer's own words (verbatim, cleaned
// and length-capped — the model never writes an answer) and `question` is a
// short label of what the assistant had asked. Written ONLY by
// functions/api/orders/intake-chat.js, after it has validated that the
// conversation covered the Showcase item's whole brief. Stored as the map
// field `cloneDetailsV2` on the order; the old `cloneDetails` field is never
// migrated into it.
export interface CloneDetailsV2Answer {
  /** What the assistant asked (max 200 chars). */
  question: string;
  /** What the customer replied (1-1500 chars). */
  answer: string;
}
export interface CloneDetailsV2 {
  /** 1-60 entries, in conversation order. */
  answers: CloneDetailsV2Answer[];
  /** ISO timestamp the intake was completed; equals the order's
   * `updatedAt` at that moment. */
  submittedAt: string;
}

// PHASE 12: one customer image received for one image slot of a paid
// custom-URL order. The image itself lives ONLY in Telegram (a deliberate,
// narrow exception to the project's Supabase-for-files rule — see
// docs/PHASE_12_HANDOFF.md); Firestore keeps just this pointer. Written ONLY
// by functions/api/orders/upload-clone-image.js (service account) — no client
// can create or change these entries.
export interface CloneImageEntry {
  /** Position of the slot in the Showcase item's `imageSlots` (blank-label
   * entries excluded). Uploads are keyed by this, never by label. */
  slotIndex: number;
  /** The slot's label when the image was received (for display / matching). */
  slotLabel: string;
  /** Telegram message id of the message the image was sent as. */
  telegramMessageId: number;
  /** Telegram file_id of the uploaded document ("" if Telegram omitted it). */
  telegramFileId: string;
  /** The customer's file name, cleaned (no path parts, extension matches the
   * verified image type). */
  originalFilename: string;
  /** ISO timestamp the image was received. */
  uploadedAt: string;
  /**
   * True only for an entry written by upload-clone-image.js after Telegram
   * actually accepted the image. PHASE 12's firestore.rules also lets the
   * order's OWNER append an entry to `cloneImages` (a client-visible record
   * of an upload attempt), but that rule can never set this to true — so an
   * owner-written entry always has `verified: false` here. Every place that
   * decides whether a slot is filled, whether the order is complete, or
   * what counts as "received" must check this flag and ignore entries where
   * it is false; it is not just display detail.
   */
  verified: boolean;
}

// One purchase (or, before payment, one bookmark) of a Showcase item.
// Persisted as one document per order in the top-level Firestore
// collection `orders` (see src/lib/ordersPersistence.ts and
// docs/PHASE_4_HANDOFF.md). Unlike ShowcaseItem, `id` is ALSO stored in
// the document body (the Phase 4 brief lists it as a field, and
// firestore.rules pins it to the document id).
export interface Order {
  id: string;
  /** Owner. Always the signed-in account that created the order. */
  uid: string;
  showcaseItemId: string;
  /** Snapshot of the Showcase item's title at the time it was added —
   * lets an order keep displaying a name after the Supervisor pauses
   * (hides) the item, since regular users can no longer read a hidden
   * item's document. Set once at creation, never edited. */
  showcaseItemTitle: string;
  /** null until the user picks a paid path. */
  type: OrderType | null;
  status: OrderStatus;
  /** Whole Naira (NOT kobo) — same unit as ShowcaseItem.priceCode/priceUrl.
   * null until `type` is chosen and priced. */
  amount: number | null;
  /** Paystack's transaction reference. null until paid. */
  paystackReference: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** PHASE 6: the intake answers for a `type: "url"` order. Absent/null
   * until the customer submits the form. Optional so code that builds an
   * Order by hand (createOrder) doesn't need to mention it. */
  cloneDetails?: CloneDetails | null;
  /** PHASE 11: the AI intake conversation's answers. Absent/null on every
   * order that predates Phase 11 (those keep `cloneDetails`, unchanged) and
   * until the AI intake completes. Never written by the browser. */
  cloneDetailsV2?: CloneDetailsV2 | null;
  /** PHASE 12: the images received so far for a custom-URL order's image
   * slots (in the order they arrived). Absent/empty until the first upload.
   * Never written by the browser. */
  cloneImages?: CloneImageEntry[];
}

// PHASE 8 — Domains: manual-fulfillment domain name requests, attached to
// a paid `type: "url"` Order once it reaches `in_progress`/`delivered`
// (persisted as one document per request in the top-level Firestore
// collection `domainRequests` — see src/lib/domainRequestsPersistence.ts
// and docs/PHASE_8_HANDOFF.md). `id` is ALSO stored in the document body
// (same convention as Order/ChatNeriboMessage).
export type DomainRequestStatus = "submitted" | "checked" | "awaiting_payment" | "paid";

// One candidate's manually-checked availability/price, set by the
// Supervisor from Operations -> Domains Management. `pricing` on a
// DomainRequest is always the SAME LENGTH as `candidates` and parallel to
// it by index (pricing[i] describes candidates[i]) — enforced by
// firestore.rules, not just convention, so a client can never send a
// pricing array that doesn't line up with what was actually submitted.
export interface DomainPricingEntry {
  domain: string;
  available: boolean;
  /** Whole Naira (NOT kobo), same convention as ShowcaseItem/Order. null
   * while unchecked or when `available` is false. */
  price: number | null;
}

export interface DomainRequest {
  id: string;
  /** Owner. Always the signed-in account that created the request. */
  uid: string;
  /** The eligible `orders/{id}` document (type "url", status
   * "in_progress" or "delivered") this request was submitted against. */
  orderId: string;
  /** 2-5 candidate domain names the user typed in, as submitted. */
  candidates: string[];
  status: DomainRequestStatus;
  /** Empty until the Supervisor checks availability/price. Parallel to
   * `candidates` by index once set (see DomainPricingEntry above). */
  pricing: DomainPricingEntry[];
  /** NOT in the Phase 8 brief's field list — added because the user picks
   * ONE available candidate to actually pay for, and this is what
   * initialize.js/webhook.js read to know which one. Set by the owner
   * (src/lib/domainRequestsPersistence.ts's chooseDomain) only while
   * `status === "awaiting_payment"`, and only to a candidate that
   * `pricing` marks available with a price — firestore.rules enforces
   * both. null until chosen. */
  chosenDomain: string | null;
  /** Paystack's transaction reference. null until paid. */
  paystackReference: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

// PHASE 7 — Chat Neribo: one-way messages from the Supervisor (or, for a
// paid code order, the system) to ONE user. Persisted as one document per
// message in the top-level `chatNeriboMessages` collection (see
// src/lib/chatNeriboPersistence.ts and docs/PHASE_7_HANDOFF.md). `id` is
// ALSO stored in the document body (same convention as Order). Nothing
// here is client-creatable: firestore.rules forbids every client create,
// and a user may only flip `acknowledged` on their own messages.
export interface ChatNeriboMessage {
  id: string;
  /** Recipient. */
  uid: string;
  /** Plain text (rendered with whitespace preserved, never as markup). */
  text: string;
  /** Optional http(s) link — e.g. a deployment or payment link. */
  linkUrl: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** Set true by the recipient's "Got it" button. */
  acknowledged: boolean;
  /** "supervisor" = typed in Operations -> Chat Neribo;
   * "code-purchase" = the automatic message sent when a code order is paid. */
  source: "supervisor" | "code-purchase";
  /** The order an automatic message is about; null for Supervisor messages. */
  orderId: string | null;
}

export interface AppSettings {
  colorMode: "Dark" | "Midnight" | "Light" | "System";
  fontStyle: "Default" | "Sans Modern" | "Monospace" | "Editorial";
  fontSize: "Small" | "Default" | "Large";
  voice: "bold-male" | "calm-female" | "nigerian";
  notifications: boolean;
  privacy: boolean;
  sharing: boolean;
  capabilitiesCount: number;
  // Capabilities gated behind Premium: webGrounding, liveSearch,
  // visualArtifact, preview. deepResearch/multimodal/voiceMode stay free.
  capabilities: {
    webGrounding: boolean;
    liveSearch: boolean;
    visualArtifact: boolean;
    preview: boolean;
    deepResearch: boolean;
    multimodal: boolean;
    voiceMode: boolean;
  };
  // Only permissions the app can genuinely back with a real browser API or
  // an existing feature (file attach, Notification API). No fake toggles.
  permissions: {
    filesAndImages: boolean;
    notifications: "default" | "granted" | "denied" | "unsupported";
  };
}

// "orders" / "live" / "showcase" were "projects" / "code" / "artifacts"
// before Phase 1 of the Showcase/Orders build. Usage-analytics screen_view
// events recorded BEFORE that rename still hold the old strings in
// Firestore — src/hooks/useUsageAnalytics.ts's SCREEN_LABELS keeps the old
// keys so that history still reads correctly.
export type ActiveNav =
  | "chat"
  | "orders"
  | "live"
  | "showcase"
  | "chatNeribo"
  | "domains"
  | "settings"
  | "operations";
// "chatNeribo" (Phase 7) is the regular-user, READ-ONLY feed of one-way
// messages from the Supervisor — see src/components/ChatNeriboView.tsx.
// "domains" (Phase 8) is the regular-user domain-name-request page — see
// src/components/DomainsView.tsx. Only reachable by a user with at least
// one eligible ("url" order at "in_progress"/"delivered") order, and only
// while the sitewide "Domains enabled" switch is on.

// Which page of the Operations dashboard is showing. Lives alongside
// ActiveNav rather than folded into it — ActiveNav answers "which top-level
// app area", this answers "which page within Operations", the same way a
// URL's path and its query/sub-route are separate concerns. Kept as its
// own type (not nested in OperationsView) so App.tsx can hold the state
// and OperationsSidebar can read/set it without importing OperationsView.
export type OperationsSection =
  | "dashboard"
  | "users"
  | "conversations"
  | "feedback"
  | "events"
  | "actions"
  | "appSettings"
  | "aiModel"
  | "systemConsole"
  | "deviceSettings"
  | "deleted"
  | "showcaseManagement"
  | "ordersManagement"
  | "chatNeribo"
  | "domainsManagement";

// One row of functions/api/device/list.js's response — a device the
// signed-in Supervisor account has registered for Device PIN protection.
// Distinct from AppSettings.permissions/colorMode (which are this
// device's chat-app preferences, stored in localStorage): this describes
// server-known state about ANY of the account's devices, most of which
// aren't the one currently rendering this page.
export interface RegisteredDevice {
  deviceId: string;
  deviceLabel: string;
  userAgent: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  hasPin: boolean;
}

// Which tool card is open on the System Console landing page (Phase 1 of
// the System Console restructure). null (handled at the call site, not
// part of this type) means "showing the landing grid, no tool open" —
// this type only enumerates the six tools that can be opened.
export type SystemConsoleToolId =
  | "diagnostics"
  | "applicationErrors"
  | "bugManagement"
  | "activityMonitor"
  | "usageAnalytics"
  | "securityMonitor"
  | "accountAccess"
  | "subscriptions";

// ---------------------------------------------------------------------
// Neribo Operations (Actions page — account-management actions)
// ---------------------------------------------------------------------
// One resolved account, as returned by
// functions/api/admin/resolve-account.js. Never constructed with
// placeholder data on the client — every field comes from that backend
// response, which itself re-reads Firebase Auth + Firestore live.
export interface OperationsResolvedAccount {
  uid: string;
  email: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  suspended: boolean;
  flagged: boolean;
  lastKnownIp: string | null;
  ipBanned: boolean;
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 9 — Users page)
// ---------------------------------------------------------------------
// One row of the Operations Users table: a Firebase Auth user merged
// with their Firestore profile/quota data. Returned by
// functions/api/admin/list-users.js — see that file for exactly how each
// field is derived/defaulted. Never constructed with placeholder data on
// the client; every field here comes from the backend response.
export interface OperationsUserRow {
  uid: string;
  email: string;
  emailVerified: boolean;
  /** Epoch-milliseconds string from Firebase Auth, or null. */
  createdAt: string | null;
  /** Epoch-milliseconds string from Firebase Auth, or null. */
  lastLoginAt: string | null;
  nickname: string;
  plan: "free" | "pro";
  chatUsage: {
    used: number;
    limit: number;
    bonusLimit: number;
    resetAt: string | null;
    /** Authoritative last-successful-payment timestamp (Paystack
     * charge.success), or null if this account has never paid. See
     * functions/api/payments/webhook.js and
     * functions/_shared/quota.js's normalizeState. */
    paidAt: string | null;
    /** Set once Paystack confirms this subscription is cancelled (see
     * functions/api/payments/webhook.js's setPlan) — null if this
     * account never subscribed, or if it's currently on pro. */
    cancelledAt: string | null;
  };
  imageUsage: {
    used: number;
    limit: number;
    resetAt: string | null;
  };
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 10 — Conversations panel)
// ---------------------------------------------------------------------
// One row of the Operations Conversations table: a real
// users/{uid}/chats/{chatId} document read via a collection group query
// (see src/components/operations/ConversationsPanel.tsx), reshaped for
// display. `messages` is kept in full (not just the preview) so the
// optional click-to-expand view can show the whole conversation without
// a second fetch — the summary list itself only ever renders a preview
// of the most recent message, never the full array.
export interface OperationsConversationRow {
  /** Firestore document id (the chatId). */
  id: string;
  /** Owning account's uid, read from the doc ref's parent.parent.id —
   * never parsed out of any other field. */
  uid: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 11 — Feedback + Events panels)
// ---------------------------------------------------------------------
// One row of the Operations Feedback table: a real operationsFeedback/{id}
// document (see src/lib/feedbackPersistence.ts for exactly how/when the
// client writes these — one immutable record per 👍/👎 tap). Read live via
// src/components/operations/FeedbackPanel.tsx.
export interface OperationsFeedbackRecord {
  /** Firestore document id. */
  id: string;
  uid: string;
  chatId: string;
  messageId: string;
  type: "up" | "down";
  timestamp: string;
  model?: string;
}

// One row of the Operations Events table: a real operationsEvents/{id}
// document. Written from two places with the same shape — the client
// (src/lib/errorHandling.ts's persistEvent) and the backend
// (functions/_shared/operationsEvents.js's reportOperationsEvent) — so
// `category`/`severity` are kept as plain strings here rather than tied
// to src/lib/errorHandling.ts's client-only ErrorCategory union, since a
// server-authored record may use values outside that union. Read live via
// src/components/operations/EventsPanel.tsx.
export interface OperationsEventRecord {
  /** Firestore document id. */
  id: string;
  category: string;
  context: string;
  message: string;
  severity: string;
  timestamp: string;
  status?: number;
  requestId?: string;
  conversationId?: string;
  uid?: string;
  /** Raw, Supervisor-only technical diagnostic detail (provider error
   * body, request/correlation ids, model, stack, etc.) — see
   * functions/_shared/operationsEvents.js and functions/_shared/redact.js.
   * Distinct from `message` above, which is always the same safe string
   * shown to the ordinary user; every value here is already redacted and
   * length-capped server-side before it's ever written. A plain map of
   * string values so a new diagnostic field can be added at any call
   * site without a type change here. */
  technical?: Record<string, string>;
}

// One row of the System Console Notifications feed: a real
// notifications/{id} document (see src/lib/notifications.ts's notify()
// for the only write path, and src/hooks/useNotifications.ts for the
// live read side). The sole audience is Supervisor accounts, so unlike
// OperationsEventRecord there's no per-role targeting — `readBy` simply
// tracks which Supervisor uids have seen it, since more than one
// Supervisor account may exist and each should have an independent
// read state. `severity` is a fixed, small enum (unlike
// OperationsEventRecord's plain string) because every writer of this
// collection is trusted first-party code (this app's own later phases
// calling notify()), not a mix of client and server sources.
export interface OperationsNotificationRecord {
  /** Firestore document id. */
  id: string;
  /** Short machine-readable source tag, e.g. "bug-report", "activity-spike". */
  type: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  createdAt: string;
  /** Optional in-app destination a click should navigate to later. */
  link?: string;
  /** Uids of Supervisor accounts that have marked this notification read. */
  readBy: string[];
}

// ---------------------------------------------------------------------
// Neribo Operations — Deleted section (Deleted → Messages / Deleted → Users)
// ---------------------------------------------------------------------
// One archived message, written just before the conversation containing
// it is actually deleted (see src/lib/chatPersistence.ts's
// archiveDeletedThread(), called from deleteThreadDoc() for every
// deletion path). The underlying users/{uid}/chats/{chatId} document is
// still genuinely removed — this is a *copy* preserved in a separate,
// Supervisor-only top-level collection (`deletedMessages`), not a
// soft-delete flag on the live data. One doc per message (not per
// conversation) so each message can carry its own metadata and render
// as its own row, the same granularity ConversationsPanel already shows
// messages at.
export interface DeletedMessageRecord {
  /** Firestore document id, `${uid}_${conversationId}_${messageId}`. */
  id: string;
  /** The message's own original author account. */
  uid: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: ChatMessage["role"];
  content: string;
  imageUrl?: string;
  /** The message's own original timestamp (ChatMessage.timestamp), distinct from deletedAt below. */
  messageTimestamp?: string;
  conversationCreatedAt?: string;
  conversationUpdatedAt?: string;
  /** When this archive record was written — i.e. the moment of deletion. */
  deletedAt: string;
  /** Short machine-readable source tag, e.g. "user_deleted_conversation". */
  reason: string;
}

// One archived account, written by functions/api/admin/delete-account.js
// just before it calls Identity Toolkit to actually delete the Firebase
// Auth account (see that file for the exact write). The Auth account
// really is deleted — this is a preserved *record* of who it was, in a
// separate Supervisor-only top-level collection (`deletedAccounts`),
// written server-side with the trusted service account so it can never
// be forged or skipped by a client. Only the metadata that's already
// safe for a Supervisor to see elsewhere (Operations Users/Actions
// pages already show email, createdAt, lastLoginAt, disabled) — no
// password, token, or other credential material ever existed for us to
// capture in the first place.
export interface DeletedAccountRecord {
  /** Firestore document id — the deleted account's original uid. */
  id: string;
  uid: string;
  email: string;
  displayName?: string;
  /** Epoch-milliseconds string from Firebase Auth, or null — same shape as OperationsUserRow.createdAt. */
  createdAt: string | null;
  /** Epoch-milliseconds string from Firebase Auth, or null. */
  lastLoginAt: string | null;
  /** Whether the account was disabled at the moment it was deleted. */
  wasDisabled: boolean;
  /** When this archive record was written — i.e. the moment of deletion. */
  deletedAt: string;
  /** The Supervisor uid who triggered the deletion. */
  deletedBy: string;
  /** Short machine-readable source tag, e.g. "admin_deleted_account". */
  reason: string;
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 3 of the System Console — Diagnostics)
// ---------------------------------------------------------------------
// One row of the System Console Diagnostics feed: a real
// diagnosticsEvents/{id} document. Deliberately a SEPARATE collection
// from OperationsEventRecord/operationsEvents above, not a second
// writer onto it. operationsEvents already captures every failure that
// passes through src/lib/errorHandling.ts's toSafeMessage (auth,
// network, firestore, ai, file, share, media, generic — surfaced on the
// Events page); Diagnostics exists specifically to catch what never
// reaches a try/catch at all — a crashed render tree, a truly uncaught
// JS error, an unhandled promise rejection — plus raw failed requests
// to this app's own functions/api/* backend, including call sites
// (like the Operations Actions page's src/lib/operationsActions.ts,
// which by design throws its own pre-sanitized Error rather than going
// through toSafeMessage) whose failures never reach operationsEvents
// today. Written by src/lib/diagnostics.ts's reportDiagnostic(); read
// live by src/hooks/useDiagnostics.ts / DiagnosticsSection.tsx. See
// firestore.rules' diagnosticsEvents block for why `create` is
// intentionally open even to signed-out requests, unlike
// operationsEvents.
export interface DiagnosticRecord {
  /** Firestore document id. */
  id: string;
  category: "render-crash" | "uncaught-error" | "unhandled-rejection" | "network";
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  /** Short machine tag: the crashed component tree for a render crash,
   * the file:line:col for an uncaught error, or the request path for a
   * network failure. */
  context: string;
  timestamp: string;
  /** HTTP status, present only when category is "network" and a
   * response actually came back (absent for a request that never got
   * one at all — offline, DNS, CORS). */
  status?: number;
  uid?: string;
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 4 of the System Console — Bug Management)
// ---------------------------------------------------------------------
// One row of the System Console Bug Management triage list: a real
// bugRecords/{id} document. Deliberately a SEPARATE collection from
// diagnosticsEvents above, matching this project's existing "raw events
// vs. curated record" convention (operationsEvents/diagnosticsEvents
// are raw and append-only; this is the curated, Supervisor-triaged
// record built on top of them, the same relationship operationsEvents
// has to operationsAuditLog). One document per deterministic
// fingerprint (see src/lib/bugFingerprint.ts) — never one document per
// raw diagnostic. Written by src/lib/bugManagement.ts's
// upsertBugAggregate() (live rollup, called from
// src/hooks/useBugRollup.ts) for the aggregate fields, and by that same
// file's updateBugStatus()/updateBugPriority() (direct Supervisor
// triage actions) for `status`/`priority`. Read live by
// src/hooks/useBugRecords.ts / BugManagementSection.tsx. See
// firestore.rules' bugRecords block for why writes are Supervisor-only
// end to end, unlike diagnosticsEvents' open `create`.
export interface BugRecord {
  /** Firestore document id — a short deterministic hash of `fingerprint`
   * (see src/lib/bugFingerprint.ts's hashFingerprintId), so the same
   * recurring error always maps to the same document instead of a
   * lookup query. */
  id: string;
  /** The deterministic grouping key this bug was created from —
   * category + normalized context + normalized message, obvious
   * variable parts (ids, numbers) stripped so near-duplicate raw
   * diagnostics collapse into one bug. Stored (not just hashed into the
   * id) so a Supervisor or a future migration can see exactly why two
   * diagnostics were — or weren't — grouped together. */
  fingerprint: string;
  category: DiagnosticRecord["category"];
  status: "new" | "investigating" | "in-progress" | "fixed" | "verified" | "closed" | "ignored";
  priority: "urgent" | "high" | "medium" | "low";
  /** How many matching raw diagnostics have been seen. Monotonic — see
   * upsertBugAggregate's own comment for why this can only ever grow,
   * never regress, even though the live rollup only ever looks at a
   * bounded recent window of diagnosticsEvents. */
  occurrenceCount: number;
  /** ISO timestamp of the earliest matching diagnostic seen so far. */
  firstSeen: string;
  /** ISO timestamp of the most recent matching diagnostic seen so far. */
  lastSeen: string;
  /** Message text of the most recent matching diagnostic — a readable
   * representative sample, not every occurrence's raw text. */
  sampleMessage: string;
  /** Context (source) of the most recent matching diagnostic. */
  sampleContext: string;
  /** The highest DiagnosticRecord.severity seen across every matching
   * occurrence so far — used to pick a sensible default `priority` when
   * the bug is first created; never used to silently override a
   * Supervisor's own later priority choice. */
  highestSeverity: DiagnosticRecord["severity"];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 5 of the System Console — Activity Monitor)
// ---------------------------------------------------------------------
// One row of the System Console Activity Monitor: a real
// activitySessions/{id} document — one per sign-in. Deliberately a
// SEPARATE collection from operationsEvents/operationsAuditLog, not a
// repurposing of either: operationsEvents is a generic sanitized
// error/event stream (client- and server-authored) and
// operationsAuditLog is a server-only audit trail of privileged
// Supervisor actions — neither is about ordinary user sign-ins.
// Written by src/lib/activityMonitor.ts's recordSignIn(), a lightweight
// best-effort client-side write fired once per fresh sign-in from
// src/App.tsx's onAuthStateChanged listener — Neribo has no
// server-side login hook to extend instead (see that file). Follows
// operationsFeedback's existing "authenticated client creates its own
// record, ownership checked against request.resource.data.uid" rule
// shape (see firestore.rules' activitySessions block), scoped to the
// signed-in account's own uid so no client can write a session record
// for anyone else. Read live by src/hooks/useActivitySessions.ts /
// ActivityMonitorSection.tsx, Supervisor-only.
export interface ActivitySessionRecord {
  /** Firestore document id. */
  id: string;
  uid: string;
  /** The signed-in account's email at the moment of sign-in, when
   * available (firebaseUser.email) — omitted rather than fabricated
   * for accounts without one. */
  email?: string;
  /** Coarse, best-effort UA-based classification — see
   * src/lib/activityMonitor.ts's detectDeviceType(). Never anything
   * more specific (no OS/browser fingerprinting). */
  deviceType: "mobile" | "tablet" | "desktop" | "unknown";
  createdAt: string;
}

// ---------------------------------------------------------------------
// Neribo Operations (PHASE 6 of the System Console — Usage Analytics)
// ---------------------------------------------------------------------
// Observational behavior analytics — deliberately separate from, and
// never overlapping with, the per-user quota system (src/lib/usage.ts,
// users/{uid}/usage). Two collections, written by
// src/lib/usageAnalytics.ts and read live by
// src/hooks/useUsageAnalytics.ts / UsageAnalyticsSection.tsx.
//
// usageSessions/{id} — one document per continuous period of app use.
// Created once at session start, then patched in place (never
// recreated): `lastHeartbeat` while the tab stays open/visible,
// `endedAt` on the way out. "Currently active" is derived on the read
// side from heartbeat freshness, not from `endedAt` alone, since a
// closed tab can't always fire it (same best-effort caveat as
// ActivitySessionRecord's write path).
export interface UsageSessionRecord {
  /** Firestore document id. */
  id: string;
  uid: string;
  startedAt: string;
  lastHeartbeat: string;
  /** Present only once the session has been (best-effort) closed out. */
  endedAt?: string;
}

/** One queued screen view or interaction inside a UsageEventBatch. Never
 * carries message content, prompts, or any personal/sensitive data —
 * `value` is a nav-section name (ActiveNav) for "screen_view", or a
 * model id (src/lib/models.ts) for "message_sent"/"image_generated". */
export interface UsageEventEntry {
  type: "screen_view" | "message_sent" | "image_generated";
  value: string;
  at: string;
}

// usageEvents/{id} — screen views and interactions are never written
// one Firestore document per event. src/lib/usageAnalytics.ts queues
// them client-side and flushes the whole queue as a single document
// (on an interval, when the queue fills, or best-effort on page
// hide/unload) — the "batched, throttled tracker" the phase brief
// calls for, so ordinary use never floods Firestore with per-click
// writes.
export interface UsageEventBatch {
  /** Firestore document id. */
  id: string;
  uid: string;
  sessionId: string;
  flushedAt: string;
  events: UsageEventEntry[];
}

// ---------------------------------------------------------------------
// Neribo Operations (System Console — Security Monitor, new section)
// ---------------------------------------------------------------------
// One row of the Security Monitor event list: a real security_events/{id}
// document. Origin/referer mismatch alone is a SIGNAL, never proof of an
// attack by itself — `severity` and `authOutcome` are what a Supervisor
// should actually weigh. Written exclusively by the trusted backend
// (functions/_shared/securityMonitor.js); status transitions go through
// functions/api/admin/update-security-event.js, never a direct client
// write — see firestore.rules' security_events block. Read live by
// src/hooks/useSecurityEvents.ts / SecurityMonitorSection.tsx.
export interface SecurityEventRecord {
  /** Firestore document id. */
  id: string;
  /** e.g. "/api/admin/set-flag". */
  endpoint: string;
  method: string;
  /** Present when the request sent an Origin header. */
  origin?: string;
  /** Present when the request sent a Referer header. */
  referer?: string;
  /** "missing" when neither header was present; "mismatch" when present
   * but not on the approved-origins allowlist. */
  matchResult: "missing" | "mismatch";
  /** The endpoint's own real auth outcome for this request — never
   * derived from the origin check itself. */
  authOutcome: "unauthenticated" | "unauthorized" | "authorized";
  /** Best-effort caller identity, present only when a valid token was
   * decoded (i.e. authOutcome is "unauthorized" or "authorized"). */
  authUid?: string;
  authEmail?: string;
  /** Caller IP from Cloudflare's own CF-Connecting-IP header — see
   * functions/_shared/ipBans.js's getClientIp for why this, and never a
   * client-suppliable header, is trustworthy. May overlap with an
   * existing bannedIps entry; this never bans/unbans anything itself. */
  ip?: string;
  userAgent?: string;
  severity: "warning" | "critical";
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
  updatedAt?: string;
  updatedByUid?: string;
}

// security_settings/allowlist — the single document holding the
// Supervisor-configured list of approved frontend origins that
// security_events above is compared against. Written only by
// functions/api/admin/set-security-origins.js; read live by
// src/hooks/useSecuritySettings.ts. An empty/missing list means nothing
// is approved yet — every admin-API request is flagged as a signal
// until a Supervisor configures this, rather than trusting anything by
// default.
export interface SecuritySettingsRecord {
  origins: string[];
  updatedAt?: string;
  updatedByUid?: string;
}

// ---------------------------------------------------------------------
// Neribo Operations "System Console" — Account Access tool
// ---------------------------------------------------------------------
// One row of the "Recent Authentication Failures" list — a real
// operationsAuditLog/{id} document, filtered to just the two
// failure-shaped actions (see functions/_shared/operationsAudit.js's
// file header for the full action enum). Deliberately NOT a new type
// wrapping a new collection — this reads the SAME audit trail
// suspend/flag/ban actions already write to, just a different slice of
// it, which is why every field below is optional/best-effort rather
// than the guaranteed shape a dedicated collection could promise.
export interface AuthFailureRecord {
  /** Firestore document id. */
  id: string;
  action: "password_login_fail" | "device_pin_unlock_fail" | string;
  /** Attempted email for a password failure; absent for a PIN failure
   * (pin-verify.js records no email at all — see
   * src/hooks/useAuthFailures.ts, which is where "Unknown" comes from). */
  targetEmail?: string;
  targetUid?: string;
  targetIp?: string;
  /** record-login-failure.js's fixed reasonCode for a password failure
   * (e.g. "wrong-password", "other"); absent for a PIN failure, whose
   * "wrong pin" label is derived from `action` alone. */
  reason?: string;
  result: "failure" | "success";
  timestamp: string;
}
