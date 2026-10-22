import React, { useState } from "react";
import { Plus, ExternalLink, Clock, Loader2, ArrowRight, Download } from "lucide-react";
import { Order, OrderType, ShowcaseItem } from "../types";
import { useShowcaseEnabled } from "../hooks/useShowcaseEnabled";
import { useCheckoutEnabled } from "../hooks/useCheckoutEnabled";
import { createOrder, getOrderPill, updateOrderChoice } from "../lib/ordersPersistence";
import { startShowcaseCheckout, PaymentsApiError } from "../lib/paymentsApi";
import { getOrderDownload, OrdersApiError } from "../lib/ordersDownloadApi";
import { DEPLOY_GUIDE } from "../data/deployGuide";
import { toSafeMessage } from "../lib/errorHandling";
import { OrderIntakeChat, SubmittedAnswersToggle, SubmittedDetailsToggle } from "./OrderIntake";
import { OrderImageUpload } from "./OrderImageUpload";

// Workspace views for the three regular-user nav areas — renamed in
// Phase 1 of the Showcase/Orders build:
//   ProjectsView  -> OrdersView    (nav "Projects"  -> "Orders")
//   CodeView      -> LiveView      (nav "Code"      -> "Live")
//   ArtifactsView -> ShowcaseView  (nav "Artifacts" -> "Showcase")
// The file itself keeps its name (Workspaces.tsx) on purpose.

// 1. Orders Workspace View
//
// PHASE 4: real orders. `orders` is the signed-in account's own
// `orders` documents, live from Firestore (App.tsx subscribes through
// src/lib/ordersPersistence.ts's subscribeToOrders), so a payment that
// the Paystack webhook confirms while this page is open flips its pill
// from "Payment pending" to "Paid" / "Awaiting your details" on its own.
// This replaced Phase 1's local, in-memory "New Project" cards — nothing
// here is created by typing into a form any more: an order comes only
// from "Add to Orders" on a Showcase item.
//
// An order's lifecycle as this view shows it:
//   Added (type null)  ->  choose "Get raw code" / "Get custom URL"
//   Payment pending    ->  Paystack -> webhook ->  Paid  (code)
//                                               or Awaiting your details (url)
//   ... later phases: In progress -> Delivered.
//
// PHASE 6: a "url" order at "awaiting_details" shows the guided intake form
// (src/components/OrderIntake.tsx); submitting it saves `cloneDetails` and
// moves the order to "in_progress". A "code" order never sees the form.
// PHASE 11: that form is now an AI-driven chat (OrderIntakeChat). Once the
// server has validated the conversation it writes `cloneDetailsV2` and moves
// the order to "awaiting_images" (the Showcase item defines image slots) or
// straight to "in_progress" (it doesn't). Orders submitted before Phase 11
// keep their old `cloneDetails`, shown exactly as before.
// PHASE 12: at "awaiting_images" the card shows the per-slot image upload
// (src/components/OrderImageUpload.tsx). The images go to Telegram through
// functions/api/orders/upload-clone-image.js — never to Supabase — and once
// every slot has one the server moves the order to "in_progress".
//
// The two checkout buttons only ever: (1) record the chosen `type` and
// its Showcase price on the order, then (2) ask
// functions/api/payments/initialize.js to start Paystack. Step 2 sends
// just the order id — the amount charged is read server-side from the
// Showcase item, never from anything here.
const CHECKOUT_PAUSED_MESSAGE = "Checkout is temporarily paused. Please check back soon.";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface OrderOffer {
  type: OrderType;
  label: string;
  price: number;
}

// The paid options this Showcase item currently offers (a null price means
// "not offered" — same convention as the Showcase page's price chips).
function offersFor(item: ShowcaseItem): OrderOffer[] {
  const offers: OrderOffer[] = [];
  if (item.priceCode != null) offers.push({ type: "code", label: "Get raw code", price: item.priceCode });
  if (item.priceUrl != null) offers.push({ type: "url", label: "Get custom URL", price: item.priceUrl });
  return offers;
}

// PHASE 5: shown on a "paid" order of type "code" — calls
// functions/api/orders/get-download.js for a fresh, short-lived signed
// URL (never constructed client-side), opens it in a new tab, and offers
// the static deploy guide (src/data/deployGuide.ts) alongside it so a
// code-only buyer has both the file and instructions. Its own
// loading/error state, same pattern as OrderCard's checkout handling
// below, so a slow or failed download never disturbs the rest of the
// card.
const CodeDownloadSection: React.FC<{ orderId: string }> = ({ orderId }) => {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    setError("");
    try {
      const { url } = await getOrderDownload(orderId);
      window.open(url, "_blank", "noopener,noreferrer");
      setShowGuide(true);
    } catch (err) {
      setError(
        err instanceof OrdersApiError ? err.message : toSafeMessage(err, "network", "orders-download")
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={downloading}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-colors shadow-sm"
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          <span>Download</span>
        </button>
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          className="px-4 py-2 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90"
        >
          {showGuide ? "Hide deploy guide" : "How do I deploy this?"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {showGuide && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3.5">
          {DEPLOY_GUIDE.map((platform) => (
            <div key={platform.title} className="space-y-1">
              <p className="text-xs font-semibold text-[var(--card-foreground)]">{platform.title}</p>
              <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                {platform.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const OrderCard: React.FC<{
  order: Order;
  // null = the Showcase list hasn't loaded yet; undefined-ish "not found"
  // is expressed by `itemsLoaded` with `item === null`.
  item: ShowcaseItem | null;
  itemsLoaded: boolean;
  checkoutEnabled: boolean;
}> = ({ order, item, itemsLoaded, checkoutEnabled }) => {
  const [busyType, setBusyType] = useState<OrderType | "reset" | null>(null);
  const [error, setError] = useState("");
  // PHASE 6 / 11: set the moment the intake chat sends a message. The live
  // orders listener flips `status` (to "in_progress", or "awaiting_images"
  // in Phase 11) as soon as the server writes the completed intake — which
  // can be before the reply reaches this browser — so without this the chat
  // would unmount and the customer would never see the one-time
  // confirmation. It keeps the chat mounted for the rest of this card's
  // life; after a reload the branches below show the saved answers instead.
  const [intakeStarted, setIntakeStarted] = useState(false);
  // PHASE 12: same idea for the image upload. The server flips the order to
  // "in_progress" the moment it records the LAST image, which can be before
  // that request's reply reaches this browser; this keeps the upload panel
  // mounted so the customer sees its confirmation instead of it vanishing.
  const [imagesStarted, setImagesStarted] = useState(false);

  const pill = getOrderPill(order);
  const title = order.showcaseItemTitle || item?.title || "Showcase item";
  const busy = busyType !== null;

  const handleCheckout = async (type: OrderType, price: number) => {
    setBusyType(type);
    setError("");
    try {
      // Step 1: record the chosen path + its price on the order. Skipped
      // when the order already says exactly this (a retry after an
      // abandoned checkout). firestore.rules only accepts an amount equal
      // to the Showcase item's real price for this type.
      if (order.type !== type || order.amount !== price) {
        await updateOrderChoice(order.id, { type, amount: price });
      }
      // Step 2: start Paystack. Sends only the order id + type; the
      // server derives the amount. On success the browser is redirected
      // away, so there is nothing to reset below on the happy path.
      await startShowcaseCheckout(order.id, type);
      // The browser is navigating to Paystack. If the person comes back
      // via the back button (the page can be restored from cache with this
      // state intact), don't leave the buttons stuck on a spinner.
      window.setTimeout(() => setBusyType(null), 10000);
    } catch (err) {
      setError(
        err instanceof PaymentsApiError
          ? err.message
          : toSafeMessage(err, "firestore", "orders-checkout")
      );
      setBusyType(null);
    }
  };

  const handleChangeOption = async () => {
    setBusyType("reset");
    setError("");
    try {
      await updateOrderChoice(order.id, { type: null, amount: null });
    } catch (err) {
      setError(toSafeMessage(err, "firestore", "orders-change-option"));
    } finally {
      setBusyType(null);
    }
  };

  const renderPayment = () => {
    if (!itemsLoaded) {
      return <p className="text-xs text-[var(--muted-foreground)]">Loading purchase options…</p>;
    }
    if (!item) {
      return (
        <p className="text-xs text-[var(--muted-foreground)]">
          This item is no longer available to buy.
        </p>
      );
    }
    const offers = offersFor(item);
    if (offers.length === 0) {
      return (
        <p className="text-xs text-[var(--muted-foreground)]">
          Purchase options aren't available for this item yet.
        </p>
      );
    }

    // Checkout already started for one path (type is set): offer to pay
    // (again — e.g. after closing the Paystack page) or to switch.
    if (order.type !== null) {
      const chosen = offers.find((o) => o.type === order.type);
      if (!chosen) {
        return (
          <div className="space-y-2">
            <p className="text-xs text-[var(--muted-foreground)]">
              The option you picked is no longer offered.
            </p>
            <button
              type="button"
              onClick={() => void handleChangeOption()}
              disabled={busy || !checkoutEnabled}
              className="px-4 py-2 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              Choose again
            </button>
          </div>
        );
      }
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCheckout(chosen.type, chosen.price)}
            disabled={busy || !checkoutEnabled}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-colors shadow-sm"
          >
            {busyType === chosen.type ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowRight className="h-3.5 w-3.5" />
            )}
            <span>
              Continue to pay · {formatNaira(chosen.price)}
            </span>
          </button>
          {offers.length > 1 && (
            <button
              type="button"
              onClick={() => void handleChangeOption()}
              disabled={busy || !checkoutEnabled}
              className="px-4 py-2 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              {busyType === "reset" ? "Updating…" : "Choose a different option"}
            </button>
          )}
        </div>
      );
    }

    // Nothing chosen yet (type === null): one button per offered path.
    return (
      <div className="flex flex-wrap items-center gap-2">
        {offers.map((offer) => (
          <button
            key={offer.type}
            type="button"
            onClick={() => void handleCheckout(offer.type, offer.price)}
            disabled={busy || !checkoutEnabled}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-colors shadow-sm"
          >
            {busyType === offer.type && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>
              {offer.label} · {formatNaira(offer.price)}
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="rounded-2xl bg-[var(--card)] border border-[var(--border)]/80 p-5 space-y-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-[var(--card-foreground)] break-words min-w-0">
          {title}
        </h3>
        <span
          className={`shrink-0 px-2.5 py-0.5 rounded-full border text-[11px] font-semibold ${pill.classes}`}
        >
          {pill.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
        {order.createdAt && <span>Added {formatDate(order.createdAt)}</span>}
        {order.type && (
          <span>{order.type === "code" ? "Raw code" : "Custom URL"}</span>
        )}
        {order.amount != null && <span>{formatNaira(order.amount)}</span>}
      </div>

      {order.status === "pending_payment" && (
        <div className="space-y-2 pt-1">
          {renderPayment()}
          {!checkoutEnabled && (
            <p className="text-xs text-amber-300">{CHECKOUT_PAUSED_MESSAGE}</p>
          )}
        </div>
      )}

      {/* PHASE 9: a paid code order keeps its Download control for its whole
          life. The first download moves it paid -> delivered server-side
          (get-download.js), and a Supervisor may also set in_progress /
          delivered by hand — one block for all three statuses, so the
          component (and its open deploy guide) isn't remounted when the
          live listener flips the status mid-download. */}
      {order.type === "code" &&
        (order.status === "paid" || order.status === "in_progress" || order.status === "delivered") && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
              {order.status === "paid"
                ? "Payment received — your file is ready to download."
                : order.status === "delivered"
                  ? "Delivered — you can download your file again any time."
                  : "Your file is ready to download."}
            </p>
            <CodeDownloadSection orderId={order.id} />
          </div>
        )}
      {order.status === "paid" && order.type !== "code" && (
        <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
          Payment received. Your download will be available here soon.
        </p>
      )}
      {order.type === "url" &&
        (order.status === "awaiting_details" ||
          (intakeStarted && (order.status === "in_progress" || order.status === "awaiting_images"))) && (
          <div className="pt-1">
            <OrderIntakeChat order={order} onSubmitStart={() => setIntakeStarted(true)} />
          </div>
        )}
      {/* PHASE 12: the intake conversation is complete and the Showcase item
          needs images — the per-slot upload (replaces Phase 11's "not ready
          yet" placeholder). Kept mounted after the status flips to
          "in_progress" (imagesStarted) so its confirmation is seen. The saved
          answers toggle is only added here when the chat above isn't already
          showing it (i.e. after a reload). */}
      {order.type === "url" &&
        (order.status === "awaiting_images" || (imagesStarted && order.status === "in_progress")) && (
          <div className="space-y-2.5">
            <OrderImageUpload order={order} onUploadStart={() => setImagesStarted(true)} />
            {!intakeStarted && order.cloneDetailsV2 && <SubmittedAnswersToggle details={order.cloneDetailsV2} />}
          </div>
        )}
      {order.status === "awaiting_details" && order.type !== "url" && (
        <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
          Payment received. We'll ask for the details of your custom site here next.
        </p>
      )}
      {order.status === "in_progress" &&
        order.type !== "code" &&
        !(order.type === "url" && (intakeStarted || imagesStarted)) && (
        <div className="space-y-2.5">
          <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
            We're working on your order.
          </p>
          {order.type === "url" && order.cloneDetails && (
            <SubmittedDetailsToggle details={order.cloneDetails} />
          )}
          {order.type === "url" && order.cloneDetailsV2 && (
            <SubmittedAnswersToggle details={order.cloneDetailsV2} />
          )}
        </div>
      )}
      {order.status === "delivered" && order.type !== "code" && (
        <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
          Your order has been delivered.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
};

export const OrdersView: React.FC<{
  // Live Firestore orders for this account. null = not loaded yet.
  orders: Order[] | null;
  ordersLoadError: string;
  // Active Showcase items (App.tsx loads these when Orders is open) — the
  // source of the prices shown on the checkout buttons. null = not loaded.
  items: ShowcaseItem[] | null;
  itemsLoadError: string;
  onBrowseShowcase: () => void;
}> = ({ orders, ordersLoadError, items, itemsLoadError, onBrowseShowcase }) => {
  const { enabled: checkoutEnabled } = useCheckoutEnabled();

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight">
          Orders
        </h2>
        <p className="text-xs text-[var(--muted-foreground)]">
          Your Showcase orders and their status.
        </p>
      </div>

      {!checkoutEnabled && (
        <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
          {CHECKOUT_PAUSED_MESSAGE}
        </div>
      )}

      {ordersLoadError && (
        <div className="rounded-2xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {ordersLoadError}
        </div>
      )}

      {!ordersLoadError && orders === null && (
        <div className="flex items-center justify-center py-16 text-[var(--muted-foreground)] text-sm">
          Loading…
        </div>
      )}

      {!ordersLoadError && orders !== null && orders.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--muted-foreground)] text-sm text-center">
          <span>No orders yet.</span>
          <button
            type="button"
            onClick={onBrowseShowcase}
            className="px-4 py-2 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90"
          >
            Browse Showcase
          </button>
        </div>
      )}

      {!ordersLoadError && orders !== null && orders.length > 0 && (
        <>
          {itemsLoadError && (
            <div className="rounded-2xl border border-rose-900/50 bg-rose-950/20 px-4 py-3 text-xs text-rose-300">
              {itemsLoadError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                item={items?.find((candidate) => candidate.id === order.showcaseItemId) ?? null}
                itemsLoaded={items !== null}
                checkoutEnabled={checkoutEnabled}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// Shared by LiveView and ShowcaseView. Both are switched off together by
// the sitewide "Showcase enabled" toggle (Operations -> App Settings, see
// src/hooks/useShowcaseEnabled.ts). Renders its children only once the
// switch is known to be on — while it's still loading it shows a neutral
// placeholder rather than flashing content at a user it's about to be
// hidden from. This gates what a REGULAR user sees only; the Supervisor's
// ShowcaseManagementPanel never goes through it, so curation continues
// while Showcase is paused.
const ShowcaseGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { enabled, loading } = useShowcaseEnabled();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-16 text-[var(--muted-foreground)] text-sm">
        Loading…
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-16 text-center text-[var(--muted-foreground)] text-sm">
        Showcase is temporarily unavailable. Please check back soon.
      </div>
    );
  }

  return <>{children}</>;
};

// Status lines shared by LiveView and ShowcaseView. `items` is null until
// App.tsx's first Showcase load finishes.
const ShowcaseListStatus: React.FC<{
  items: ShowcaseItem[] | null;
  loadError: string;
  emptyMessage: string;
}> = ({ items, loadError, emptyMessage }) => {
  if (loadError) {
    return (
      <div className="rounded-2xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
        {loadError}
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--muted-foreground)] text-sm">
        Loading…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--muted-foreground)] text-sm">
        {emptyMessage}
      </div>
    );
  }
  return null;
};

// 2. Live Workspace View
//
// Lists every ACTIVE Showcase item with its deployed preview link. This
// replaced the old scratch-pad "Code Studio" (a textarea with Run/Copy
// buttons, unconnected to anything) — none of that code is reused.
// `items` is already active-only (App.tsx loads regular accounts' items
// through loadActiveShowcaseItems, and firestore.rules refuses anything
// else); the `.filter` below is a second, cheap guard, not the real one.
// An active item with no `liveUrl` yet is still listed, as "Preview coming
// soon". The link opens in a new tab rather than an iframe — arbitrary
// third-party-hosted demos often refuse to be embedded.
export const LiveView: React.FC<{
  items: ShowcaseItem[] | null;
  loadError: string;
}> = ({ items, loadError }) => {
  const activeItems = items ? items.filter((item) => item.active) : null;

  return (
    <ShowcaseGate>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-4">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight">Live</h2>
          <p className="text-xs text-[var(--muted-foreground)]">
            Live previews of every project in Showcase.
          </p>
        </div>

        <ShowcaseListStatus
          items={activeItems}
          loadError={loadError}
          emptyMessage="No live previews yet."
        />

        {!loadError && activeItems !== null && activeItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {activeItems.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl bg-[var(--card)] border border-[var(--border)]/80 p-5 space-y-3 shadow-sm flex flex-col justify-between"
              >
                <h3 className="text-base font-semibold text-[var(--card-foreground)] break-words">
                  {item.title}
                </h3>
                {item.liveUrl ? (
                  <a
                    href={item.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Open live preview</span>
                  </a>
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--elevated)] text-[var(--muted-foreground)] font-medium text-xs">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Preview coming soon</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </ShowcaseGate>
  );
};

// 3. Showcase View
//
// The curated portfolio Westly posts himself (Operations -> Showcase
// Management). Each active item shows its title, description, and
// whichever prices are offered, plus (Phase 4) a free "Add to Orders"
// button. Adding is only a bookmark — it creates an order with status
// "pending_payment" and charges nothing; paying happens later, from
// Orders. If the item is already in the user's Orders the button becomes
// "In your Orders" and opens Orders instead (one bookmark per item).
// Nothing here is ever created automatically — the old "Artifacts" view
// was fed by code blocks in chat replies, and that auto-population is
// gone (see App.tsx's handleSendMessage).
const AddToOrdersButton: React.FC<{
  uid: string;
  item: ShowcaseItem;
  orders: Order[] | null;
  checkoutEnabled: boolean;
  onOpenOrders: () => void;
}> = ({ uid, item, orders, checkoutEnabled, onOpenOrders }) => {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const existing = orders?.some((order) => order.showcaseItemId === item.id) ?? false;

  const handleAdd = async () => {
    setAdding(true);
    setError("");
    try {
      // The live orders listener (App.tsx) picks the new order up, which
      // flips this button to "In your Orders" on its own.
      await createOrder(uid, { id: item.id, title: item.title });
    } catch (err) {
      setError(toSafeMessage(err, "firestore", "add-to-orders"));
    } finally {
      setAdding(false);
    }
  };

  if (existing) {
    return (
      <button
        type="button"
        onClick={onOpenOrders}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)] font-semibold text-xs hover:opacity-90 transition-colors"
      >
        <span>In your Orders</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void handleAdd()}
        disabled={adding || orders === null || !checkoutEnabled}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-colors shadow-sm"
      >
        {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 stroke-[2.5]" />}
        <span>Add to Orders</span>
      </button>
      {!checkoutEnabled && (
        <p className="text-xs text-amber-300">{CHECKOUT_PAUSED_MESSAGE}</p>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
};

export const ShowcaseView: React.FC<{
  items: ShowcaseItem[] | null;
  loadError: string;
  uid: string;
  // The account's live orders — null until loaded.
  orders: Order[] | null;
  onOpenOrders: () => void;
}> = ({ items, loadError, uid, orders, onOpenOrders }) => {
  const activeItems = items ? items.filter((item) => item.active) : null;
  const { enabled: checkoutEnabled } = useCheckoutEnabled();

  return (
    <ShowcaseGate>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-4">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight">Showcase</h2>
          <p className="text-xs text-[var(--muted-foreground)]">
            Projects and templates you can get.
          </p>
        </div>

        <ShowcaseListStatus
          items={activeItems}
          loadError={loadError}
          emptyMessage="Nothing in Showcase yet."
        />

        {!loadError && activeItems !== null && activeItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {activeItems.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl bg-[var(--card)] border border-[var(--border)]/80 p-5 space-y-3 shadow-sm flex flex-col"
              >
                <h3 className="text-base font-semibold text-[var(--card-foreground)] break-words">
                  {item.title}
                </h3>
                {item.description && (
                  <p className="text-xs text-[var(--muted-foreground)] leading-relaxed whitespace-pre-wrap break-words">
                    {item.description}
                  </p>
                )}
                {(item.priceCode != null || item.priceUrl != null) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {item.priceCode != null && (
                      <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--elevated)] text-[var(--card-foreground)]">
                        Code · {formatNaira(item.priceCode)}
                      </span>
                    )}
                    {item.priceUrl != null && (
                      <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--elevated)] text-[var(--card-foreground)]">
                        Custom site · {formatNaira(item.priceUrl)}
                      </span>
                    )}
                  </div>
                )}
                <div className="pt-1 mt-auto">
                  <AddToOrdersButton
                    uid={uid}
                    item={item}
                    orders={orders}
                    checkoutEnabled={checkoutEnabled}
                    onOpenOrders={onOpenOrders}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ShowcaseGate>
  );
};

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}
