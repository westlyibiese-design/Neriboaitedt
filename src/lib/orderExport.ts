// Supervisor CSV export of custom-URL intake submissions.
//
// Pure module: no Firebase, no React, no network. It only turns Order
// documents (plus a little optional context the caller already loaded) into
// CSV text and hands that text to the browser. Loading the data lives in
// src/lib/orderExportData.ts; the buttons live in
// src/components/operations/OrdersManagementPanel.tsx (Supervisor-only —
// firestore.rules is the real gate on every read this feature makes).
//
// WHAT COUNTS AS A "SUBMISSION": a custom-URL order that carries intake data —
// AI-intake answers (`cloneDetailsV2`), the older fixed-form answers
// (`cloneDetails`), or at least one VERIFIED image entry (`cloneImages`).
//
// IMAGES: exactly as everywhere else in the app, the image bytes live only in
// Telegram. Firestore keeps the customer's cleaned file name (`originalFilename`)
// on each `cloneImages` entry, and that stored name is what is exported —
// never a URL, never an upload. Only `verified` entries count (Telegram
// accepted the image); when a slot was replaced, the latest entry is the
// current image and earlier ones are listed separately as "replaced".
//
// CSV FORMAT: UTF-8 with a BOM (so Excel shows ₦ and accented names
// correctly), CRLF row endings, RFC 4180 quoting. Any text cell that begins
// with = + - @ (or a tab / carriage return) gets a leading apostrophe so a
// customer-typed value can never run as a spreadsheet formula when the
// Supervisor opens the file.

import type { CloneImageEntry, DomainRequest, Order, OrderStatus } from "../types";

/** Everything beyond the Order itself, all optional and best-effort. */
export interface OrderExportContext {
  /** uid -> account email. */
  emailByUid?: Map<string, string>;
  /** Showcase item id -> its deployed preview link. */
  liveUrlByItem?: Map<string, string>;
  /** order id -> domain requests filed against it. */
  domainRequestsByOrder?: Map<string, DomainRequest[]>;
  /** Readable status label (kept as a callback so this module imports nothing
   * at runtime). */
  statusLabel: (status: OrderStatus) => string;
}

// ---------------------------------------------------------------------------
// Selecting submissions
// ---------------------------------------------------------------------------

function verifiedImages(order: Order): CloneImageEntry[] {
  return (order.cloneImages ?? []).filter((e) => e.verified);
}

/** True when the order carries anything the intake collected. */
export function isIntakeSubmission(order: Order): boolean {
  return Boolean(order.cloneDetailsV2 || order.cloneDetails || verifiedImages(order).length > 0);
}

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

// Control characters that have no place in a cell (tab and newlines are kept).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One RFC 4180 field. Numbers pass through untouched; strings are
 * normalized, formula-guarded and quoted when they need it. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value).replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** `2026-09-24 01:33:00` (UTC) — unambiguous, sortable, and Excel reads it as a
 * date. Unparseable input is passed through rather than hidden. */
function formatUtc(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------------
// Turning one Order into export-ready pieces
// ---------------------------------------------------------------------------

interface IntakeAnswer {
  question: string;
  answer: string;
}

interface SubmissionView {
  order: Order;
  email: string;
  serviceType: string;
  statusText: string;
  liveUrl: string;
  requestedDomains: string;
  chosenDomain: string;
  domainStatus: string;
  intakeFormat: string;
  submittedAt: string;
  answers: IntakeAnswer[];
  images: CloneImageEntry[];
  replacedImages: CloneImageEntry[];
}

const NO_NAME = "(no name saved)";

function imageName(entry: CloneImageEntry): string {
  return entry.originalFilename || NO_NAME;
}

function slotName(entry: CloneImageEntry): string {
  return entry.slotLabel || `Slot ${entry.slotIndex + 1}`;
}

/** The old fixed-form answers, in the same order and wording the Supervisor
 * panel shows them. */
function legacyAnswers(order: Order): IntakeAnswer[] {
  const d = order.cloneDetails;
  if (!d) return [];
  return [
    { question: "Site / business name", answer: d.siteName },
    { question: "What the site is for", answer: d.purpose },
    { question: "Sections / pages", answer: d.sections },
    { question: "Branding", answer: d.branding },
    { question: "Example sites", answer: d.exampleSites.join("\n") },
    { question: "Contact for follow-up", answer: d.contact },
  ];
}

function describe(order: Order, ctx: OrderExportContext): SubmissionView {
  const v2 = order.cloneDetailsV2 ?? null;
  const legacy = legacyAnswers(order);

  let intakeFormat = "";
  let submittedAt = "";
  const answers: IntakeAnswer[] = [];
  if (v2) {
    intakeFormat = "AI intake";
    submittedAt = v2.submittedAt;
    answers.push(...v2.answers.map((a) => ({ question: a.question || "Customer message", answer: a.answer })));
  }
  if (legacy.length > 0) {
    // Both shapes on one order is unusual (old orders are never migrated) but
    // possible; export everything rather than silently dropping one.
    intakeFormat = v2 ? "AI intake + legacy form" : "Legacy form";
    submittedAt = submittedAt || order.cloneDetails?.submittedAt || "";
    answers.push(...legacy.map((a) => (v2 ? { ...a, question: `Legacy form - ${a.question}` } : a)));
  }

  // One current image per slot (a later array position wins, matching the
  // Supervisor panel); superseded entries are kept as "replaced".
  const latest = new Map<number, CloneImageEntry>();
  const replaced: CloneImageEntry[] = [];
  for (const entry of verifiedImages(order)) {
    const previous = latest.get(entry.slotIndex);
    if (previous) replaced.push(previous);
    latest.set(entry.slotIndex, entry);
  }
  const images = Array.from(latest.values()).sort((a, b) => a.slotIndex - b.slotIndex);

  const requests = ctx.domainRequestsByOrder?.get(order.id) ?? [];
  const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

  return {
    order,
    email: ctx.emailByUid?.get(order.uid) ?? "",
    serviceType: order.type === "url" ? "Custom URL" : order.type === "code" ? "Raw code" : "None chosen",
    statusText: ctx.statusLabel(order.status),
    liveUrl: ctx.liveUrlByItem?.get(order.showcaseItemId) ?? "",
    requestedDomains: unique(requests.flatMap((r) => r.candidates)).join(" | "),
    chosenDomain: unique(requests.map((r) => r.chosenDomain ?? "")).join(" | "),
    domainStatus: unique(requests.map((r) => r.status)).join(" | "),
    intakeFormat,
    submittedAt,
    answers,
    images,
    replacedImages: replaced,
  };
}

// Excel and Google Sheets cap a cell at 32,767 characters and silently cut
// anything past it. A long intake (up to 60 answers of 1,500 characters) can
// exceed that, so answers are packed into as few cells as fit under this
// budget — always split BETWEEN answers, never mid-answer.
const MAX_CELL_CHARS = 30000;

/** "Q1: …\nA1: …" blocks separated by a blank line — readable inside one
 * cell. Returns one string per cell (almost always exactly one, and at least
 * one even when there are no answers). */
function answersBlocks(answers: IntakeAnswer[]): string[] {
  const blocks: string[] = [];
  let current = "";
  answers.forEach((a, i) => {
    const entry = `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`;
    if (current && current.length + 2 + entry.length > MAX_CELL_CHARS) {
      blocks.push(current);
      current = entry;
    } else {
      current = current ? `${current}\n\n${entry}` : entry;
    }
  });
  blocks.push(current);
  return blocks;
}

// ---------------------------------------------------------------------------
// The two CSV layouts
// ---------------------------------------------------------------------------

const ALL_HEADERS = [
  "Order ID",
  "Customer Email",
  "Customer UID",
  "Item Title",
  "Service Type",
  "Order Status",
  "Amount (NGN)",
  "Paystack Reference",
  "Preview Link",
  "Requested Domains",
  "Chosen Domain",
  "Domain Request Status",
  "Intake Type",
  "Submitted At (UTC)",
  "Order Created (UTC)",
  "Order Updated (UTC)",
  "Answer Count",
  "Intake Answers",
];
const IMAGE_HEADERS = ["Image Count", "Image Filenames", "Image Slots (Slot: Filename)", "Replaced Image Filenames"];

/** All submissions as ONE table: a header row, then one row per submission.
 * Several image names share one cell, joined by " | ", so the row count and
 * column count never change. Callers filter with isIntakeSubmission first. */
export function buildAllSubmissionsCsv(orders: Order[], ctx: OrderExportContext): string {
  const views = orders.map((order) => {
    const v = describe(order, ctx);
    return { v, blocks: answersBlocks(v.answers) };
  });
  const answerColumns = views.reduce((max, x) => Math.max(max, x.blocks.length), 1);
  const extraAnswerHeaders = Array.from({ length: answerColumns - 1 }, (_, i) => `Intake Answers (part ${i + 2})`);
  const rows: unknown[][] = [[...ALL_HEADERS, ...extraAnswerHeaders, ...IMAGE_HEADERS]];
  for (const { v, blocks } of views) {
    const order = v.order;
    rows.push([
      order.id,
      v.email,
      order.uid,
      order.showcaseItemTitle,
      v.serviceType,
      v.statusText,
      order.amount,
      order.paystackReference,
      v.liveUrl,
      v.requestedDomains,
      v.chosenDomain,
      v.domainStatus,
      v.intakeFormat,
      formatUtc(v.submittedAt),
      formatUtc(order.createdAt),
      formatUtc(order.updatedAt),
      v.answers.length,
      ...Array.from({ length: answerColumns }, (_, i) => blocks[i] ?? ""),
      v.images.length,
      v.images.map(imageName).join(" | "),
      v.images.map((e) => `${slotName(e)}: ${imageName(e)}`).join(" | "),
      v.replacedImages.map((e) => `${slotName(e)}: ${imageName(e)}`).join(" | "),
    ]);
  }
  return toCsv(rows);
}

/** ONE submission as a vertical Field / Value sheet — every detail on its own
 * line (each answer, each image), which reads far better for a single record
 * than a one-row table with a giant answers cell. */
export function buildSingleSubmissionCsv(order: Order, ctx: OrderExportContext): string {
  const v = describe(order, ctx);
  const rows: unknown[][] = [
    ["Field", "Value"],
    ["Order ID", order.id],
    ["Customer Email", v.email],
    ["Customer UID", order.uid],
    ["Item Title", order.showcaseItemTitle],
    ["Service Type", v.serviceType],
    ["Order Status", v.statusText],
    ["Amount (NGN)", order.amount],
    ["Paystack Reference", order.paystackReference],
    ["Preview Link", v.liveUrl],
    ["Requested Domains", v.requestedDomains],
    ["Chosen Domain", v.chosenDomain],
    ["Domain Request Status", v.domainStatus],
    ["Intake Type", v.intakeFormat],
    ["Submitted At (UTC)", formatUtc(v.submittedAt)],
    ["Order Created (UTC)", formatUtc(order.createdAt)],
    ["Order Updated (UTC)", formatUtc(order.updatedAt)],
    ["Answer Count", v.answers.length],
  ];
  v.answers.forEach((a, i) => rows.push([`Q${i + 1}: ${a.question}`, a.answer]));
  rows.push(["Image Count", v.images.length]);
  v.images.forEach((e, i) => rows.push([`Image ${i + 1} - ${slotName(e)}`, imageName(e)]));
  v.replacedImages.forEach((e) => rows.push([`Replaced image - ${slotName(e)}`, imageName(e)]));
  return toCsv(rows);
}

// ---------------------------------------------------------------------------
// File names + browser download
// ---------------------------------------------------------------------------

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function allSubmissionsFilename(date: Date = new Date()): string {
  return `neribo-intake-submissions-${dateStamp(date)}.csv`;
}

export function singleSubmissionFilename(order: Order, date: Date = new Date()): string {
  const safeId = order.id.replace(/[^A-Za-z0-9_-]/g, "_") || "order";
  return `neribo-intake-${safeId}-${dateStamp(date)}.csv`;
}

/** Hands already-built CSV text to the browser as a file download. */
export function downloadCsvFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
