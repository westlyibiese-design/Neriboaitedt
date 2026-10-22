// src/components/operations/OrdersManagementPanel.tsx
import React, { useEffect, useMemo, useState } from "react";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { ClipboardList, Download, Loader2, Pencil, Search, CheckCircle2, XCircle } from "lucide-react";
import { ImageSlotDef, Order, OrderStatus } from "../../types";
import { db } from "../../lib/firebase";
import { useRealtimeFeed } from "../../hooks/useRealtimeFeed";
import { fetchOperationsUserEmails } from "../../lib/operationsUsersCache";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  getOrderPill,
  toOrder,
  updateOrderStatusAsSupervisor,
} from "../../lib/ordersPersistence";
import { toSafeMessage } from "../../lib/errorHandling";
import { loadAllShowcaseItems } from "../../lib/showcasePersistence";
import { LoadMoreFooter } from "./LoadMoreFooter";
import { CloneDetailsReadOnly, CloneDetailsV2ReadOnly } from "../OrderIntake";
import {
  allSubmissionsFilename,
  buildAllSubmissionsCsv,
  buildSingleSubmissionCsv,
  downloadCsvFile,
  isIntakeSubmission,
  singleSubmissionFilename,
} from "../../lib/orderExport";
import { loadAllOrdersForExport, loadExportContext } from "../../lib/orderExportData";

// Keep in sync with firestore.rules' Supervisor-override check
// (paystackReference is capped at 100 characters there).
const MAX_REFERENCE = 100;

type StatusFilter = "all" | OrderStatus;

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}

const EXPORT_BUTTON_CLASSES =
  "shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--secondary)] hover:opacity-90 text-xs text-[var(--secondary-foreground)] disabled:opacity-50";

const INPUT_CLASSES =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

/**
 * PHASE 12: which of an order's image slots have been received (customer
 * images are stored in Telegram, not in the app). Renders nothing for an order
 * that has neither received an image nor is waiting for one.
 *
 * Only `verified` entries are shown as received. firestore.rules also lets an
 * order's owner append an entry to `cloneImages` themselves, but only
 * functions/api/orders/upload-clone-image.js can ever set `verified: true`
 * (and only after Telegram actually accepted the image) — an unverified entry
 * would mean a customer's own browser claimed an upload the team never
 * received, which is exactly what this checklist must not show as done.
 *
 * PHASE 14: a slot can now have MORE THAN ONE verified entry (the customer
 * replaced an image before the order completed) — every historical entry
 * stays in Firestore as an audit trail, but this list shows exactly ONE row
 * per slot, using the latest entry, so a legitimate correction never looks
 * like a duplicate/conflicting upload. A small "· replaced" note marks a
 * slot that has more than one verified entry in its history.
 */
const OrderImagesList: React.FC<{ order: Order; imageSlots: ImageSlotDef[] | null | undefined }> = ({
  order,
  imageSlots,
}) => {
  const verified = (order.cloneImages ?? []).filter((e) => e.verified);
  const waiting = order.status === "awaiting_images";
  if (verified.length === 0 && !waiting) return null;

  // One entry per slot (the latest — a later array position wins), plus how
  // many verified entries that slot actually has (>1 means it was replaced).
  const byIndex = new Map(verified.map((e) => [e.slotIndex, e]));
  const countByIndex = new Map<number, number>();
  for (const e of verified) countByIndex.set(e.slotIndex, (countByIndex.get(e.slotIndex) ?? 0) + 1);
  const entries = Array.from(byIndex.values()).sort((a, b) => a.slotIndex - b.slotIndex);

  const slots = (imageSlots ?? []).map((s) => ({ ...s, label: s.label.trim() })).filter((s) => s.label);
  const slotsKnown = slots.length > 0;
  // Received entries that don't line up with a slot on the item any more
  // (e.g. the slot list was edited after the upload).
  const orphans = slotsKnown ? entries.filter((e) => e.slotIndex >= slots.length) : [];
  const receivedCount = slotsKnown ? slots.filter((_, i) => byIndex.has(i)).length : entries.length;

  return (
    <details open={waiting} className="rounded-lg bg-[var(--popover)] border border-[var(--border)] px-3 py-2.5">
      <summary className="cursor-pointer select-none text-xs font-semibold text-[var(--card-foreground)]">
        Customer images (in Telegram) ·{" "}
        {slotsKnown ? `${receivedCount} of ${slots.length} received` : `${entries.length} received`}
      </summary>
      <div className="pt-3 space-y-2">
        <ul className="space-y-1.5">
          {slotsKnown
            ? slots.map((slot, i) => {
                const entry = byIndex.get(i);
                const replaced = (countByIndex.get(i) ?? 0) > 1;
                return (
                  <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-[11px]">
                    {entry ? (
                      <CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0 text-emerald-400" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 mt-px shrink-0 text-amber-400" />
                    )}
                    <span className="font-medium text-[var(--card-foreground)] break-words">{slot.label}</span>
                    {entry ? (
                      <span className="text-[var(--muted-foreground)] break-all">
                        Received{entry.originalFilename ? ` · ${entry.originalFilename}` : ""}
                        {entry.uploadedAt ? ` · ${formatTimestamp(entry.uploadedAt)}` : ""}
                        {replaced ? " · replaced" : ""}
                      </span>
                    ) : (
                      <span className="text-amber-300">Not received yet</span>
                    )}
                  </li>
                );
              })
            : entries.map((entry) => {
                const replaced = (countByIndex.get(entry.slotIndex) ?? 0) > 1;
                return (
                  <li key={entry.slotIndex} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-[11px]">
                    <CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0 text-emerald-400" />
                    <span className="font-medium text-[var(--card-foreground)] break-words">
                      {entry.slotLabel || `Slot ${entry.slotIndex + 1}`}
                    </span>
                    <span className="text-[var(--muted-foreground)] break-all">
                      Received{entry.originalFilename ? ` · ${entry.originalFilename}` : ""}
                      {entry.uploadedAt ? ` · ${formatTimestamp(entry.uploadedAt)}` : ""}
                      {replaced ? " · replaced" : ""}
                    </span>
                  </li>
                );
              })}
          {orphans.map((entry) => (
            <li key={`orphan-${entry.slotIndex}`} className="flex flex-wrap items-start gap-x-2 text-[11px]">
              <CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0 text-[var(--muted-foreground)]" />
              <span className="font-medium text-[var(--card-foreground)] break-words">
                {entry.slotLabel || `Slot ${entry.slotIndex + 1}`}
              </span>
              <span className="text-[var(--muted-foreground)] break-all">
                Received (no longer a slot on the item){entry.originalFilename ? ` · ${entry.originalFilename}` : ""}
              </span>
            </li>
          ))}
        </ul>
        {!slotsKnown && waiting && (
          <p className="text-[11px] text-[var(--muted-foreground)]">
            {imageSlots === undefined
              ? "Loading the item's slot list…"
              : "The item's slot list isn't available, so slots not yet received can't be listed."}
          </p>
        )}
        <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed break-all">
          The images are in your Telegram chat, not in the app. Search Telegram for{" "}
          <span className="font-mono text-[var(--card-foreground)]">{order.id}</span> to find them — each caption
          names the order, item and slot.
        </p>
      </div>
    </details>
  );
};

/**
 * One order row plus its manual status override. Deliberately its own
 * component so each row has independent editing/saving/result state —
 * overriding one order can never disturb an in-progress edit of another.
 *
 * PHASE 6: an order carrying `cloneDetails` (a custom-URL customer's
 * answers to the intake form) also shows them here, read-only — open by
 * default while the order is "In progress", collapsed once it moves on —
 * so the Supervisor can see exactly what was asked for without a
 * separate panel. Nothing here can edit them.
 *
 * PHASE 11: an order can instead carry `cloneDetailsV2` — the question/answer
 * pairs from the AI intake conversation. Both shapes coexist in the same
 * collection forever (old orders are never migrated), so each is shown by its
 * own block when present: old orders render exactly as before, new ones
 * render as a question/answer list, and it's open by default while the order
 * is "Awaiting images" or "In progress".
 *
 * PHASE 12: an order that has received customer images shows a simple
 * checklist: each of the Showcase item's image slots and whether it has been
 * received, with the customer's original file name. The images themselves live
 * in Telegram (a deliberate exception to the Supabase-for-files rule) — this
 * list only tells you what to look for; open the Telegram chat and search for
 * the order id, which is in every image's caption. There is no in-app image
 * viewer or Telegram download proxy (out of scope for Phase 12).
 *
 * The override writes straight to Firestore through
 * updateOrderStatusAsSupervisor; firestore.rules is the real gate (a
 * Supervisor may change ONLY status / paystackReference / updatedAt, and
 * only to one of the six valid statuses). The live listener above then
 * pushes the saved order back into this list, so there's nothing to
 * refresh by hand.
 */
const OrderRow: React.FC<{
  order: Order;
  email: string | undefined;
  // The order's Showcase item's image slots (Phase 10), so a slot that hasn't
  // been received yet can be listed as missing. undefined = the items haven't
  // loaded (or failed); null = the item has no slots / no longer exists.
  imageSlots: ImageSlotDef[] | null | undefined;
  // Supervisor CSV export of this one submission. `exporting` is true while
  // ANY export is running (so two downloads can't overlap); `exportingThis`
  // marks this row's own for its spinner.
  onExport: () => void;
  exporting: boolean;
  exportingThis: boolean;
}> = ({ order, email, imageSlots, onExport, exporting, exportingThis }) => {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<OrderStatus>(order.status);
  const [reference, setReference] = useState(order.paystackReference ?? "");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const pill = getOrderPill(order);

  const openEditor = () => {
    setStatus(order.status);
    setReference(order.paystackReference ?? "");
    setResult(null);
    setEditing(true);
  };

  const trimmedReference = reference.trim();
  const referenceChanged = trimmedReference !== (order.paystackReference ?? "");
  const unchanged = status === order.status && !referenceChanged;

  const handleSave = async () => {
    if (unchanged) return;
    if (trimmedReference.length > MAX_REFERENCE) {
      setResult({ ok: false, message: `The Paystack reference can be at most ${MAX_REFERENCE} characters.` });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      await updateOrderStatusAsSupervisor(
        order.id,
        status,
        // Only send the reference when it actually changed; an empty box
        // clears it (null).
        referenceChanged ? (trimmedReference || null) : undefined
      );
      setResult({ ok: true, message: `Status set to "${ORDER_STATUS_LABELS[status]}".` });
      setEditing(false);
    } catch (err) {
      setResult({ ok: false, message: toSafeMessage(err, "firestore", "orders-status-override") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--card-foreground)] break-words">
              {order.showcaseItemTitle || "(untitled item)"}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${pill.classes}`}>
              {ORDER_STATUS_LABELS[order.status]}
              {order.status === "pending_payment" && order.type === null ? " · nothing chosen" : ""}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
            <span className="break-all" title={order.uid}>
              {email ?? `uid: ${order.uid}`}
            </span>
            <span>
              {order.type === "code" ? "Raw code" : order.type === "url" ? "Custom URL" : "No option chosen"}
            </span>
            <span>{order.amount != null ? formatNaira(order.amount) : "No amount"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
            <span className="break-all">Order: {order.id}</span>
            <span className="break-all">Ref: {order.paystackReference ?? "—"}</span>
            <span className="whitespace-nowrap">Added {formatTimestamp(order.createdAt)}</span>
            <span className="whitespace-nowrap">Updated {formatTimestamp(order.updatedAt)}</span>
          </div>
        </div>

        <div className="shrink-0 flex flex-wrap items-center justify-end gap-1.5">
          {isIntakeSubmission(order) && (
            <button
              onClick={onExport}
              disabled={exporting}
              title="Download this submission as a CSV file"
              className={EXPORT_BUTTON_CLASSES}
            >
              {exportingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              <span>Export CSV</span>
            </button>
          )}
          {!editing && (
            <button
              onClick={openEditor}
              className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--secondary)] hover:opacity-90 text-xs text-[var(--secondary-foreground)]"
            >
              <Pencil className="h-3 w-3" />
              <span>Override status</span>
            </button>
          )}
        </div>
      </div>

      {order.cloneDetailsV2 && (
        <details
          open={order.status === "awaiting_images" || order.status === "in_progress"}
          className="rounded-lg bg-[var(--popover)] border border-[var(--border)] px-3 py-2.5"
        >
          <summary className="cursor-pointer select-none text-xs font-semibold text-[var(--card-foreground)]">
            Submitted site details (AI intake)
          </summary>
          <div className="pt-3">
            <CloneDetailsV2ReadOnly details={order.cloneDetailsV2} />
          </div>
        </details>
      )}

      {order.cloneDetails ? (
        <details
          open={order.status === "in_progress" && !order.cloneDetailsV2}
          className="rounded-lg bg-[var(--popover)] border border-[var(--border)] px-3 py-2.5"
        >
          <summary className="cursor-pointer select-none text-xs font-semibold text-[var(--card-foreground)]">
            Submitted site details
          </summary>
          <div className="pt-3">
            <CloneDetailsReadOnly details={order.cloneDetails} />
          </div>
        </details>
      ) : (
        order.status === "in_progress" &&
        order.type === "url" &&
        !order.cloneDetailsV2 && (
          <p className="text-[11px] text-[var(--muted-foreground)]">
            No site details on this order — its status was set by hand, so the customer hasn't submitted
            the intake form.
          </p>
        )
      )}

      <OrderImagesList order={order} imageSlots={imageSlots} />

      {editing && (
        <div className="rounded-lg bg-[var(--popover)] border border-[var(--border)] p-3 space-y-2.5">
          <p className="text-[11px] text-[var(--muted-foreground)]">
            Manual override — for edge cases such as a payment that succeeded at Paystack but whose
            webhook never landed. This changes the order's status directly and doesn't contact
            Paystack.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Status
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as OrderStatus)}
                disabled={saving}
                className={INPUT_CLASSES}
              >
                {ORDER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {ORDER_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Paystack reference (optional)
              </span>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                disabled={saving}
                maxLength={MAX_REFERENCE}
                placeholder="e.g. T123456789"
                className={`${INPUT_CLASSES} font-mono`}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving || unchanged}
              className="px-4 py-2 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
            result.ok
              ? "bg-emerald-950/20 text-emerald-300 border border-emerald-900/50"
              : "bg-rose-950/20 text-rose-300 border border-rose-900/50"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
};

/**
 * Operations -> Orders Management (Phase 4 of the Showcase/Orders build).
 * Every order across ALL users, live, newest first, with a manual status
 * override per order. Follows ShowcaseManagementPanel's panel pattern
 * (Supervisor-only, gated by OperationsView's useIsOperations() check;
 * firestore.rules' `orders` block is the real enforcement — only a
 * Supervisor can list other accounts' orders or change a status).
 *
 * Reads through useRealtimeFeed (like EventsPanel/FeedbackPanel) so a
 * webhook-driven change — e.g. an order flipping to "paid" while this
 * page is open — appears without a refresh, and so a large history can be
 * paged with "Load more" instead of being loaded in one go.
 */
export const OrdersManagementPanel: React.FC = () => {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  // uid -> email, from the same cached roster the Conversations and Users
  // panels use. Best-effort: a failure just leaves rows showing the uid.
  const [emails, setEmails] = useState<Map<string, string>>(new Map());
  // itemId -> that item's image slots (Phase 10), loaded once so an order
  // still waiting on images can list which slots are missing. undefined =
  // not loaded yet / failed (rows then show only what was received).
  const [slotsByItem, setSlotsByItem] = useState<Map<string, ImageSlotDef[] | null> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchOperationsUserEmails()
      .then((map) => {
        if (!cancelled) setEmails(map);
      })
      .catch((err) => {
        console.error("[Neribo:ordersManagement] Couldn't load the user roster:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadAllShowcaseItems()
      .then((items) => {
        if (!cancelled) setSlotsByItem(new Map(items.map((i) => [i.id, i.imageSlots ?? null])));
      })
      .catch((err) => {
        console.error("[Neribo:ordersManagement] Couldn't load the Showcase items' image slots:", err);
        // Rows then say the slot list isn't available instead of waiting forever.
        if (!cancelled) setSlotsByItem(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    data: orders,
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    loadAll,
  } = useRealtimeFeed<Order>(
    (limitCount) => query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(limitCount)),
    (docSnap) => toOrder(docSnap.id, docSnap.data()),
    [],
    "We couldn't load orders right now. Please try again.",
    "orders-management"
  );

  // Supervisor CSV export. `exportingKey` is "all" or the order id being
  // exported (null = idle); one export at a time.
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const warningText = (warnings: string[]) =>
    warnings.length > 0 ? ` (Couldn't load ${warnings.join(", ")} — those columns are blank.)` : "";

  const handleExportOne = async (order: Order) => {
    if (exportingKey) return;
    setExportingKey(order.id);
    setExportNotice(null);
    try {
      const { context, warnings } = await loadExportContext(order.id);
      downloadCsvFile(singleSubmissionFilename(order), buildSingleSubmissionCsv(order, context));
      setExportNotice({ ok: true, message: `Exported the submission for order ${order.id}.${warningText(warnings)}` });
    } catch (err) {
      setExportNotice({ ok: false, message: toSafeMessage(err, "firestore", "orders-export-one") });
    } finally {
      setExportingKey(null);
    }
  };

  const handleExportAll = async () => {
    if (exportingKey) return;
    setExportingKey("all");
    setExportNotice(null);
    try {
      // Read fresh rather than reusing the on-screen list, which is paged and
      // filtered — see src/lib/orderExportData.ts.
      const { orders: allOrders, truncated } = await loadAllOrdersForExport();
      const submissions = allOrders.filter(isIntakeSubmission);
      if (submissions.length === 0) {
        setExportNotice({ ok: false, message: "There are no intake submissions to export yet." });
        return;
      }
      const { context, warnings } = await loadExportContext(null);
      downloadCsvFile(allSubmissionsFilename(), buildAllSubmissionsCsv(submissions, context));
      setExportNotice({
        ok: true,
        message:
          `Exported ${submissions.length} intake submission${submissions.length === 1 ? "" : "s"}.` +
          (truncated ? " The order history is very large, so the oldest orders may be missing." : "") +
          warningText(warnings),
      });
    } catch (err) {
      setExportNotice({ ok: false, message: toSafeMessage(err, "firestore", "orders-export-all") });
    } finally {
      setExportingKey(null);
    }
  };

  const filtered = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (filter !== "all" && order.status !== filter) return false;
      if (!q) return true;
      return (
        order.showcaseItemTitle.toLowerCase().includes(q) ||
        order.id.toLowerCase().includes(q) ||
        order.uid.toLowerCase().includes(q) ||
        (emails.get(order.uid) ?? "").toLowerCase().includes(q) ||
        (order.paystackReference ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, filter, search, emails]);

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-[var(--fg-1)]" />
            Orders Management
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Every user's orders, live. Override a status by hand when something needs fixing.
          </p>
        </div>
        <button
          onClick={() => void handleExportAll()}
          disabled={exportingKey !== null}
          title="Download every intake submission as one CSV file"
          className={EXPORT_BUTTON_CLASSES}
        >
          {exportingKey === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <span>Export all submissions</span>
        </button>
      </div>

      {exportNotice && (
        <div
          className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
            exportNotice.ok
              ? "bg-emerald-950/20 text-emerald-300 border border-emerald-900/50"
              : "bg-rose-950/20 text-rose-300 border border-rose-900/50"
          }`}
        >
          {exportNotice.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          <span>{exportNotice.message}</span>
        </div>
      )}

      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by item, email, uid, order id or reference"
            className={`${INPUT_CLASSES} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", ...ORDER_STATUSES] as StatusFilter[]).map((option) => (
            <button
              key={option}
              onClick={() => setFilter(option)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === option
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--secondary)] hover:bg-[var(--elevated)] text-[var(--secondary-foreground)]"
              }`}
            >
              {option === "all" ? "All" : ORDER_STATUS_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {!loadError && orders === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading orders…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && orders !== null && filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          {orders.length === 0 ? "No orders yet." : "No orders match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              email={emails.get(order.uid)}
              imageSlots={slotsByItem === undefined ? undefined : (slotsByItem.get(order.showcaseItemId) ?? null)}
              onExport={() => void handleExportOne(order)}
              exporting={exportingKey !== null}
              exportingThis={exportingKey === order.id}
            />
          ))}
        </div>
      )}

      {!loadError && orders !== null && (
        <LoadMoreFooter
          loadedCount={orders.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};
