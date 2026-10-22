// Firestore persistence for Showcase items (Phase 1 of the Showcase/Orders
// build).
//
// One document per item in the top-level `showcaseItems` collection (see
// src/types.ts's ShowcaseItem). Modeled directly on
// src/lib/chatPersistence.ts — same load/save/delete-doc shape, same
// retry-then-throw contract, same "this file owns HOW, App.tsx / the
// Operations panel own WHEN" split. (The brief called this file
// showcasePersistence.js; it's .ts because chatPersistence — and the rest
// of src/lib — is TypeScript. Same module, same shape.)
//
// This file is the single place that talks to `showcaseItems`.
//
// Security: enforced server-side by firestore.rules' `showcaseItems`
// block, never here. In short — a Supervisor can read and write
// everything; any other signed-in account can read ONLY items with
// `active == true`, and can never write. That's why the two loaders below
// are separate functions: Firestore rules aren't filters, so the
// regular-user loader MUST send `where("active", "==", true)` itself or
// the whole query is rejected. Calling loadAllShowcaseItems from a
// non-Supervisor session simply fails with permission-denied — it can
// never return an inactive item.

import { collection, deleteDoc, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import { db } from "./firebase";
import { ImageSlotDef, ShowcaseItem } from "../types";

const COLLECTION = "showcaseItems";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

/** PHASE 10 limits for the custom-URL intake fields. Mirrored LITERALLY in
 * firestore.rules' isValidShowcaseItem (the real gate) — change both
 * together, and see the note there on why maxImageSlots is 12. Same idea as
 * CLONE_DETAILS_LIMITS in ordersPersistence.ts. Lengths are counted in
 * characters; the client's `.length` counts UTF-16 units, which is never
 * smaller, so anything the client accepts, the rules accept. */
export const SHOWCASE_INTAKE_LIMITS = {
  /** detailsBrief: 1..8000 characters when present (else null). */
  detailsBrief: 8000,
  /** imageSlots: 1..12 entries when present (else null). */
  maxImageSlots: 12,
  /** ImageSlotDef.label: 1..60 characters. */
  slotLabel: 60,
  /** ImageSlotDef.description: 0..300 characters (may be empty). */
  slotDescription: 300,
} as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemsCollection() {
  return collection(db, COLLECTION);
}

/** A fresh Firestore auto-id for a new item. Generated locally (no
 * network round trip) so the panel can build the full ShowcaseItem
 * before its first save. */
export function newShowcaseItemId(): string {
  return doc(itemsCollection()).id;
}

function asNullablePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** True only for a well-formed http:// or https:// URL. Used both when the
 * Supervisor enters a `liveUrl` (ShowcaseManagementPanel) and when items
 * are loaded (below), so a `javascript:`/`data:` URL — however it got
 * into the document — can never reach the Live page's link `href`. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function asNullableHttpUrl(value: unknown): string | null {
  const str = asNullableString(value);
  return str && isValidHttpUrl(str.trim()) ? str.trim() : null;
}

/** PHASE 10: tolerant read of the `imageSlots` array. Drops any entry that
 * isn't a { label: non-blank string, description: string } object rather than
 * crashing the page (the rules never let a malformed entry in, but a
 * hand-edited doc could hold one). Returns null for "no usable slots".
 * Deliberately does NOT cap the count: silently dropping slots on load would
 * lose data on the next save; the Supervisor form flags an over-long list
 * instead. */
function asImageSlots(value: unknown): ImageSlotDef[] | null {
  if (!Array.isArray(value)) return null;
  const slots: ImageSlotDef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { label, description } = entry as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) continue;
    slots.push({ label, description: typeof description === "string" ? description : "" });
  }
  return slots.length > 0 ? slots : null;
}

/** Turns a raw Firestore document into a well-formed ShowcaseItem,
 * tolerating a hand-edited or partially-filled doc rather than crashing
 * the page that renders it. `active` fails CLOSED — anything other than
 * a literal `true` is treated as inactive. */
function toShowcaseItem(id: string, data: Record<string, unknown>): ShowcaseItem {
  return {
    id,
    title: typeof data.title === "string" ? data.title : "",
    description: typeof data.description === "string" ? data.description : "",
    priceCode: asNullablePrice(data.priceCode),
    priceUrl: asNullablePrice(data.priceUrl),
    active: data.active === true,
    fileRef: asNullableString(data.fileRef),
    liveUrl: asNullableHttpUrl(data.liveUrl),
    // PHASE 10. Absent on every item created before this phase -> null.
    // These MUST be carried here as well as in saveShowcaseItem: the panel's
    // Active/Hidden switch re-saves `{ ...item }`, so a loader that dropped
    // them would erase them on the next toggle.
    detailsBrief: asNullableString(data.detailsBrief),
    imageSlots: asImageSlots(data.imageSlots),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
  };
}

// Newest first. Sorted here rather than with orderBy() so the
// `where("active", "==", true)` query needs no composite index.
function newestFirst(a: ShowcaseItem, b: ShowcaseItem): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Loads every ACTIVE item — what a regular account sees in Showcase and
 * Live. The `where("active", "==", true)` is required by firestore.rules
 * (see the file header), not just a convenience.
 */
export async function loadActiveShowcaseItems(): Promise<ShowcaseItem[]> {
  const snap = await getDocs(query(itemsCollection(), where("active", "==", true)));
  const items: ShowcaseItem[] = [];
  snap.forEach((d) => items.push(toShowcaseItem(d.id, d.data())));
  return items.sort(newestFirst);
}

/**
 * Loads every item, active or not — Supervisor only (the Showcase
 * Management panel). Rejected by firestore.rules for any other account.
 */
export async function loadAllShowcaseItems(): Promise<ShowcaseItem[]> {
  const snap = await getDocs(itemsCollection());
  const items: ShowcaseItem[] = [];
  snap.forEach((d) => items.push(toShowcaseItem(d.id, d.data())));
  return items.sort(newestFirst);
}

/**
 * Upserts one item as a single document. Retries a couple of times on
 * transient failures before giving up (same contract as
 * chatPersistence.saveThread). Supervisor only, per firestore.rules.
 *
 * The document body is built field by field (never spread from the
 * caller's object) so it can only ever contain the eleven fields the rules
 * allow (nine from Phase 1 + `detailsBrief` and `imageSlots` from Phase 10)
 * — `id` lives in the document path, not the body — and every optional
 * field is written as an explicit null rather than omitted or `undefined`
 * (which Firestore rejects). An empty `imageSlots` array is written as null
 * (the rules reject an empty list; null is the single "none" value).
 */
export async function saveShowcaseItem(item: ShowcaseItem): Promise<void> {
  const body = {
    title: item.title,
    description: item.description,
    priceCode: item.priceCode ?? null,
    priceUrl: item.priceUrl ?? null,
    active: item.active,
    fileRef: item.fileRef ?? null,
    liveUrl: item.liveUrl ?? null,
    detailsBrief: item.detailsBrief ?? null,
    imageSlots:
      item.imageSlots && item.imageSlots.length > 0
        ? item.imageSlots.map((slot) => ({ label: slot.label, description: slot.description }))
        : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await setDoc(doc(itemsCollection(), item.id), body);
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[showcasePersistence] Saving item "${item.id}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Deletes one item's document. Retries like saveShowcaseItem.
 *
 * NOTE: nothing in Phase 1's UI calls this — the management panel
 * deliberately only offers "active" on/off, not deletion, since later
 * phases' Orders will reference item ids and an item that has been
 * ordered should be paused, not erased. It exists so the persistence
 * module has the same load/save/delete shape as chatPersistence.ts.
 */
export async function deleteShowcaseItemDoc(itemId: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await deleteDoc(doc(itemsCollection(), itemId));
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[showcasePersistence] Deleting item "${itemId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}
