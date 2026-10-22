// Data loading for the Supervisor intake-submission export (see
// src/lib/orderExport.ts for the CSV side).
//
// Read-only. Every read here is Supervisor-only in firestore.rules (`orders`,
// `domainRequests`, `showcaseItems` inactive items, and the list-users
// endpoint behind the email roster), so a non-Supervisor account gets a
// permission error, never data. Nothing is written anywhere.
//
// "Export all" deliberately does NOT reuse the Orders Management panel's
// on-screen list: that list is a paged realtime feed (200 at a time, plus
// whatever the search/status filters hide), so exporting it would silently
// miss submissions. Instead this reads the whole `orders` collection fresh,
// up to the same MAX_FEED_LIMIT ceiling the feed itself uses.

import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "./firebase";
import { DomainRequest, Order } from "../types";
import { toOrder, ORDER_STATUS_LABELS } from "./ordersPersistence";
import { toDomainRequest } from "./domainRequestsPersistence";
import { loadAllShowcaseItems } from "./showcasePersistence";
import { fetchOperationsUserEmails } from "./operationsUsersCache";
import { MAX_FEED_LIMIT } from "../hooks/useRealtimeFeed";
import type { OrderExportContext } from "./orderExport";

/** Every order (newest first), read fresh. `truncated` is true only if the
 * collection is at least as large as the safety ceiling. */
export async function loadAllOrdersForExport(): Promise<{ orders: Order[]; truncated: boolean }> {
  const snap = await getDocs(
    query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(MAX_FEED_LIMIT))
  );
  const orders = snap.docs.map((d) => toOrder(d.id, d.data()));
  return { orders, truncated: snap.size >= MAX_FEED_LIMIT };
}

async function loadDomainRequests(orderId: string | null): Promise<Map<string, DomainRequest[]>> {
  const base = collection(db, "domainRequests");
  const snap = await getDocs(
    orderId === null ? query(base, limit(MAX_FEED_LIMIT)) : query(base, where("orderId", "==", orderId))
  );
  const byOrder = new Map<string, DomainRequest[]>();
  snap.forEach((d) => {
    const request = toDomainRequest(d.id, d.data());
    byOrder.set(request.orderId, [...(byOrder.get(request.orderId) ?? []), request]);
  });
  return byOrder;
}

/**
 * The extra columns' data: account emails, each item's preview link, and the
 * order's domain requests. All best-effort — if one source fails the export
 * still goes ahead with that column blank, and the failure comes back as a
 * warning for the panel to show. `orderId` narrows the domain-request read to
 * one order (single export); null reads them all.
 */
export async function loadExportContext(
  orderId: string | null
): Promise<{ context: OrderExportContext; warnings: string[] }> {
  const [emails, items, domains] = await Promise.allSettled([
    fetchOperationsUserEmails(),
    loadAllShowcaseItems(),
    loadDomainRequests(orderId),
  ]);

  const warnings: string[] = [];
  const context: OrderExportContext = {
    statusLabel: (status) => ORDER_STATUS_LABELS[status] ?? status,
  };

  if (emails.status === "fulfilled") context.emailByUid = emails.value;
  else {
    console.error("[Neribo:orderExport] Couldn't load the user roster:", emails.reason);
    warnings.push("customer emails");
  }

  if (items.status === "fulfilled") {
    context.liveUrlByItem = new Map(items.value.filter((i) => i.liveUrl).map((i) => [i.id, i.liveUrl as string]));
  } else {
    console.error("[Neribo:orderExport] Couldn't load the Showcase items:", items.reason);
    warnings.push("preview links");
  }

  if (domains.status === "fulfilled") context.domainRequestsByOrder = domains.value;
  else {
    console.error("[Neribo:orderExport] Couldn't load the domain requests:", domains.reason);
    warnings.push("domain requests");
  }

  return { context, warnings };
}
