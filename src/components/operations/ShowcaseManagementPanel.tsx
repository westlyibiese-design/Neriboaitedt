// src/components/operations/ShowcaseManagementPanel.tsx
import React, { useRef, useState } from "react";
import {
  Shapes,
  Plus,
  Pencil,
  Loader2,
  CheckCircle2,
  XCircle,
  UploadCloud,
  FileCheck2,
  ChevronUp,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { ImageSlotDef, ShowcaseItem } from "../../types";
import {
  SHOWCASE_INTAKE_LIMITS,
  isValidHttpUrl,
  newShowcaseItemId,
  saveShowcaseItem,
} from "../../lib/showcasePersistence";
import {
  SHOWCASE_FILE_INPUT_ACCEPT,
  uploadShowcaseFile,
  validateShowcaseFile,
} from "../../lib/showcaseFilesApi";

// Field limits mirror firestore.rules' isValidShowcaseItem — kept in sync
// by hand, since the rules file can't import from here. The rules are the
// real enforcement; these only give the Supervisor a friendly message
// before a save would be rejected.
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_FILE_REF = 500;
const MAX_LIVE_URL = 2000;

// PHASE 10 — custom-URL intake fields (detailsBrief + imageSlots). Limits
// come from SHOWCASE_INTAKE_LIMITS (src/lib/showcasePersistence.ts), which
// mirrors firestore.rules' isValidShowcaseItem.
const INTAKE = SHOWCASE_INTAKE_LIMITS;

/** One editable image-slot row. `key` exists only so React can keep each
 * row's inputs attached to the right slot while rows are moved or removed
 * (an array index would not survive that); it is never saved. */
interface SlotForm {
  key: string;
  label: string;
  description: string;
}

let slotKeyCounter = 0;
const nextSlotKey = () => `slot-${++slotKeyCounter}`;

/** Raw form state — every field a string/boolean exactly as typed, parsed
 * and validated only on save. */
interface FormState {
  title: string;
  description: string;
  priceCode: string;
  priceUrl: string;
  liveUrl: string;
  fileRef: string;
  detailsBrief: string;
  imageSlots: SlotForm[];
  active: boolean;
}

const EMPTY_FORM: FormState = {
  title: "",
  description: "",
  priceCode: "",
  priceUrl: "",
  liveUrl: "",
  fileRef: "",
  detailsBrief: "",
  imageSlots: [],
  active: true,
};

function formFromItem(item: ShowcaseItem): FormState {
  return {
    title: item.title,
    description: item.description,
    priceCode: item.priceCode != null ? String(item.priceCode) : "",
    priceUrl: item.priceUrl != null ? String(item.priceUrl) : "",
    liveUrl: item.liveUrl ?? "",
    fileRef: item.fileRef ?? "",
    detailsBrief: item.detailsBrief ?? "",
    imageSlots: (item.imageSlots ?? []).map((slot) => ({
      key: nextSlotKey(),
      label: slot.label,
      description: slot.description,
    })),
    active: item.active,
  };
}

// Control characters (except tab / newline), zero-width and bidirectional
// override characters. Pasted text sometimes carries them; they can make
// text display as something it isn't. ZWJ/ZWNJ (U+200D/U+200C) are kept so
// emoji survive.
const UNSAFE_TEXT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** The brief keeps its line breaks and paragraphs; only line-ending
 * variants are normalized, unsafe characters stripped, and the ends trimmed. */
function cleanBrief(raw: string): string {
  return raw.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(UNSAFE_TEXT_CHARS, "").trim();
}

/** Slot labels/descriptions are one-liners: any run of whitespace or line
 * breaks becomes a single space. */
function cleanSingleLine(raw: string): string {
  return raw.replace(/[\s\u0085]+/g, " ").replace(UNSAFE_TEXT_CHARS, "").trim();
}

/** Cleans and checks the slot rows. A row left completely blank (an "Add"
 * that was never filled in) is dropped silently. Everything else is
 * validated with a message that names the slot's position in the list. */
function buildImageSlots(
  rows: SlotForm[]
): { ok: true; value: ImageSlotDef[] } | { ok: false; error: string } {
  const value: ImageSlotDef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const label = cleanSingleLine(rows[i].label);
    const description = cleanSingleLine(rows[i].description);
    if (!label && !description) continue;
    const where = `Image slot ${i + 1}`;
    if (!label) return { ok: false, error: `${where} needs a label (or clear its description and remove it).` };
    if (label.length > INTAKE.slotLabel) {
      return { ok: false, error: `${where}: the label must be ${INTAKE.slotLabel} characters or fewer.` };
    }
    if (description.length > INTAKE.slotDescription) {
      return { ok: false, error: `${where}: the description must be ${INTAKE.slotDescription} characters or fewer.` };
    }
    const dedupeKey = label.toLowerCase();
    if (seen.has(dedupeKey)) {
      return { ok: false, error: `${where}: another slot is already labeled "${label}". Give each slot its own label.` };
    }
    seen.add(dedupeKey);
    value.push({ label, description });
  }
  if (value.length > INTAKE.maxImageSlots) {
    return { ok: false, error: `An item can have at most ${INTAKE.maxImageSlots} image slots.` };
  }
  return { ok: true, value };
}

/** One-line summary of an item's intake setup, for the item list. */
function describeIntake(item: ShowcaseItem): string {
  const slotCount = item.imageSlots?.length ?? 0;
  const brief = item.detailsBrief ? `brief written (${item.detailsBrief.length.toLocaleString()} chars)` : "no brief";
  const slots = slotCount === 0 ? "no image slots" : `${slotCount} image slot${slotCount === 1 ? "" : "s"}`;
  return `${brief} · ${slots}`;
}

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}

/** Blank -> null ("not offered"); otherwise a whole Naira amount > 0.
 * Returns `undefined` for anything else so the caller can flag it. */
function parsePrice(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const INPUT_CLASSES =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

const ICON_BUTTON_CLASSES =
  "p-1.5 rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-40";

const Switch: React.FC<{
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={onChange}
    disabled={disabled}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
      checked ? "bg-emerald-600" : "bg-[var(--muted)]"
    }`}
  >
    <span
      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-5" : "translate-x-0.5"
      }`}
    />
  </button>
);

interface ShowcaseManagementPanelProps {
  /** Every Showcase item, active or not. null until the first load
   * finishes (App.tsx owns the load — see its showcase effect). */
  items: ShowcaseItem[] | null;
  loadError: string;
  /** Called with the saved item after every successful write so App.tsx's
   * copy of the list stays current without a refetch. */
  onItemSaved: (item: ShowcaseItem) => void;
}

/**
 * Operations -> Showcase Management (Phase 1 of the Showcase/Orders
 * build). Lets the Supervisor add a Showcase item, edit one, and switch
 * it active/inactive. Deliberately NOT here: file upload (`fileRef` is a
 * plain typed-in placeholder until Phase 2) and deleting items (pause
 * them instead — later phases' Orders will reference item ids).
 *
 * Gated entirely by its parent, OperationsView — same pattern as
 * FeedbackPanel/EventsPanel: only ever mounted once useIsOperations()
 * confirms `isOperations: true`. That's a client-side courtesy only; the
 * real enforcement is firestore.rules' `showcaseItems` block, which
 * rejects every write from a non-Supervisor account regardless of what
 * this UI does. This panel also never reads the sitewide "Showcase
 * enabled" switch, so curation keeps working while Showcase is paused
 * for users.
 *
 * PHASE 10: for an item that offers the custom-URL service (a custom-URL
 * price is entered) the form also edits `detailsBrief` (free-text brief of
 * what the Supervisor needs to know to build that kind of site) and
 * `imageSlots` (an ordered list of labeled images the buyer will be asked
 * for). Nothing user-facing reads them yet (Phases 11–12).
 */
export const ShowcaseManagementPanel: React.FC<ShowcaseManagementPanelProps> = ({
  items,
  loadError,
  onItemSaved,
}) => {
  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // The Firestore doc id this form's uploads are namespaced under in
  // Supabase Storage (`${showcaseItemId}/${filename}` — see
  // docs/SUPABASE_CONTRACT.md). For a new item this is generated the
  // moment the form opens (newShowcaseItemId() is a local id, no network
  // round trip — same call Save already used before Phase 2) so a file
  // can be uploaded before the item is ever saved; handleSave below
  // reuses this exact id rather than generating a second one, or the
  // uploaded file's path would point at an id that was never persisted.
  const [formItemId, setFormItemId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  // Last signed URL returned by an upload in THIS session — immediate
  // confirmation only, never persisted (Phase 5 mints a fresh one on
  // demand instead). Cleared whenever the form reopens or a new upload
  // starts, so it never lingers as a stale link for a different file.
  const [lastUploadUrl, setLastUploadUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openNew = () => {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setFormError("");
    setResult(null);
    setFormItemId(newShowcaseItemId());
    setUploadError("");
    setLastUploadUrl("");
  };

  const openEdit = (item: ShowcaseItem) => {
    setEditingId(item.id);
    setForm(formFromItem(item));
    setFormError("");
    setResult(null);
    setFormItemId(item.id);
    setUploadError("");
    setLastUploadUrl("");
  };

  const closeForm = () => {
    setEditingId(null);
    setFormError("");
    setFormItemId(null);
    setUploadError("");
    setLastUploadUrl("");
  };

  const handleFileSelected = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || !formItemId || uploading) return;

    const validationError = validateShowcaseFile(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    setUploading(true);
    setUploadError("");
    setLastUploadUrl("");
    try {
      const { path, url } = await uploadShowcaseFile(formItemId, file, form.fileRef);
      setField("fileRef", path);
      setLastUploadUrl(url);
    } catch (err) {
      console.error("[Neribo:operations-showcase] file upload failed:", err);
      setUploadError(err instanceof Error ? err.message : "Couldn't upload this file. Please try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormError("");
  };

  // PHASE 10 — image-slot rows. Each handler builds a fresh array (never
  // mutates the old one) so React state stays consistent.
  const addSlot = () => {
    setForm((prev) =>
      prev.imageSlots.length >= INTAKE.maxImageSlots
        ? prev
        : { ...prev, imageSlots: [...prev.imageSlots, { key: nextSlotKey(), label: "", description: "" }] }
    );
    setFormError("");
  };

  const updateSlot = (key: string, patch: Partial<Pick<SlotForm, "label" | "description">>) => {
    setForm((prev) => ({
      ...prev,
      imageSlots: prev.imageSlots.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
    }));
    setFormError("");
  };

  const removeSlot = (key: string) => {
    setForm((prev) => ({ ...prev, imageSlots: prev.imageSlots.filter((slot) => slot.key !== key) }));
    setFormError("");
  };

  const moveSlot = (key: string, delta: -1 | 1) => {
    setForm((prev) => {
      const from = prev.imageSlots.findIndex((slot) => slot.key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.imageSlots.length) return prev;
      const next = [...prev.imageSlots];
      [next[from], next[to]] = [next[to], next[from]];
      return { ...prev, imageSlots: next };
    });
    setFormError("");
  };

  // The intake fields are only shown (and only edited) while a custom-URL
  // price is entered — a code-only item has no use for them.
  const showIntakeFields = form.priceUrl.trim() !== "";

  const handleSave = async () => {
    if (editingId === null || saving) return;

    const title = form.title.trim();
    const description = form.description.trim();
    const liveUrl = form.liveUrl.trim();
    const fileRef = form.fileRef.trim();
    const priceCode = parsePrice(form.priceCode);
    const priceUrl = parsePrice(form.priceUrl);

    if (!title) return setFormError("A title is required.");
    if (title.length > MAX_TITLE) return setFormError(`Title must be ${MAX_TITLE} characters or fewer.`);
    if (description.length > MAX_DESCRIPTION) {
      return setFormError(`Description must be ${MAX_DESCRIPTION} characters or fewer.`);
    }
    if (priceCode === undefined) {
      return setFormError("Code price must be a whole Naira amount above 0, or blank if not offered.");
    }
    if (priceUrl === undefined) {
      return setFormError("Custom URL price must be a whole Naira amount above 0, or blank if not offered.");
    }
    if (liveUrl) {
      // Lowercase-scheme check mirrors firestore.rules' regex, which is
      // case-sensitive; isValidHttpUrl alone would accept "HTTPS://…".
      if (!/^https?:\/\//.test(liveUrl) || !isValidHttpUrl(liveUrl)) {
        return setFormError("Live URL must start with http:// or https:// and be a valid link.");
      }
      if (liveUrl.length > MAX_LIVE_URL) return setFormError("Live URL is too long.");
    }
    if (fileRef.length > MAX_FILE_REF) {
      return setFormError(`File reference must be ${MAX_FILE_REF} characters or fewer.`);
    }

    const now = new Date().toISOString();
    const existing = editingId === "new" ? null : items?.find((i) => i.id === editingId) ?? null;
    if (editingId !== "new" && !existing) {
      return setFormError("This item is no longer in the list. Close this form and reopen it.");
    }

    // PHASE 10 — custom-URL intake fields. Validated and rewritten only when
    // the form shows them (a custom-URL price is entered). When the price is
    // blank they are hidden, so a save leaves whatever is already stored
    // exactly as it was: clearing the price must not silently delete a
    // carefully written brief, and a customer who already paid for this
    // item's custom-URL service may still need it. (A new item has nothing
    // stored, so it saves null.)
    let detailsBrief: string | null = existing?.detailsBrief ?? null;
    let imageSlots: ImageSlotDef[] | null = existing?.imageSlots ?? null;
    if (priceUrl !== null) {
      const brief = cleanBrief(form.detailsBrief);
      if (brief.length > INTAKE.detailsBrief) {
        return setFormError(
          `The requirements brief must be ${INTAKE.detailsBrief.toLocaleString()} characters or fewer (it is ${brief.length.toLocaleString()}).`
        );
      }
      const slots = buildImageSlots(form.imageSlots);
      if ("error" in slots) return setFormError(slots.error);
      detailsBrief = brief || null;
      imageSlots = slots.value.length > 0 ? slots.value : null;
    }

    const item: ShowcaseItem = {
      // Reuse the id generated when the form opened (formItemId) rather
      // than minting a fresh one here — any file already uploaded this
      // session was stored under formItemId, and a mismatch would leave
      // fileRef pointing at a path under an id this item never actually
      // has.
      id: existing ? existing.id : formItemId ?? newShowcaseItemId(),
      title,
      description,
      priceCode,
      priceUrl,
      active: form.active,
      fileRef: fileRef || null,
      liveUrl: liveUrl || null,
      detailsBrief,
      imageSlots,
      createdAt: existing ? existing.createdAt || now : now,
      updatedAt: now,
    };

    setSaving(true);
    setFormError("");
    try {
      await saveShowcaseItem(item);
      onItemSaved(item);
      setResult({ ok: true, message: existing ? "Item updated." : "Item added." });
      closeForm();
    } catch (err) {
      console.error("[Neribo:operations-showcase] save failed:", err);
      setFormError("Couldn't save this item. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (item: ShowcaseItem) => {
    if (togglingId) return;
    const updated: ShowcaseItem = { ...item, active: !item.active, updatedAt: new Date().toISOString() };
    setTogglingId(item.id);
    setResult(null);
    try {
      await saveShowcaseItem(updated);
      onItemSaved(updated);
      setResult({
        ok: true,
        message: updated.active ? `"${item.title}" is now visible to users.` : `"${item.title}" is now hidden from users.`,
      });
    } catch (err) {
      console.error("[Neribo:operations-showcase] toggle failed:", err);
      setResult({ ok: false, message: "Couldn't change this item's visibility. Please try again." });
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <Shapes className="h-5 w-5 text-[var(--fg-1)]" />
            Showcase Management
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Operations-only. Add and edit the projects users see in Showcase and Live.
          </p>
        </div>
        {editingId === null && (
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-xs hover:opacity-90 transition-colors shadow-sm"
          >
            <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
            <span>Add item</span>
          </button>
        )}
      </div>

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

      {editingId !== null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--card-foreground)]">
            {editingId === "new" ? "Add Showcase item" : "Edit Showcase item"}
          </h3>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">Title</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              placeholder="e.g. Restaurant ordering site"
              maxLength={MAX_TITLE}
              className={INPUT_CLASSES}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="What this project is and what the buyer gets."
              rows={3}
              maxLength={MAX_DESCRIPTION}
              className={`${INPUT_CLASSES} resize-none`}
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Code price (₦)
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={form.priceCode}
                onChange={(e) => setField("priceCode", e.target.value)}
                placeholder="Blank = raw code not offered"
                className={INPUT_CLASSES}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Custom URL price (₦)
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={form.priceUrl}
                onChange={(e) => setField("priceUrl", e.target.value)}
                placeholder="Blank = custom site not offered"
                className={INPUT_CLASSES}
              />
            </label>
          </div>

          {showIntakeFields && (
            <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3.5">
              <div className="space-y-0.5">
                <h4 className="text-xs font-semibold text-[var(--card-foreground)]">Custom URL intake</h4>
                <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                  Optional. Anyone signed in can read what you write here, so keep private notes out of it.
                </p>
              </div>

              <label className="block space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  What do you need to know to build this?
                </span>
                <textarea
                  value={form.detailsBrief}
                  onChange={(e) => setField("detailsBrief", e.target.value)}
                  placeholder="e.g. What is the business called? Which pages does it need? Any brand colours or a logo? Which sites do they like?"
                  rows={8}
                  className={`${INPUT_CLASSES} resize-y`}
                />
                <span className="flex items-start justify-between gap-3 text-[11px] text-[var(--muted-foreground)]">
                  <span>Write it exactly as you'd want it asked — as much or as little as you need.</span>
                  <span
                    className={`shrink-0 tabular-nums ${
                      form.detailsBrief.length > INTAKE.detailsBrief ? "text-rose-300" : ""
                    }`}
                  >
                    {form.detailsBrief.length.toLocaleString()}/{INTAKE.detailsBrief.toLocaleString()}
                  </span>
                </span>
              </label>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                    Image slots
                  </span>
                  <span className="text-[11px] tabular-nums text-[var(--muted-foreground)]">
                    {form.imageSlots.length}/{INTAKE.maxImageSlots}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                  Images the buyer will be asked to provide, in this order — for example "Logo", "Hero Photo",
                  "Interior Shot". Optional.
                </p>

                {form.imageSlots.length > 0 && (
                  <ol className="space-y-2">
                    {form.imageSlots.map((slot, index) => (
                      <li
                        key={slot.key}
                        className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-[var(--muted-foreground)]">
                            Slot {index + 1}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => moveSlot(slot.key, -1)}
                              disabled={index === 0}
                              aria-label={`Move slot ${index + 1} up`}
                              className={ICON_BUTTON_CLASSES}
                            >
                              <ChevronUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveSlot(slot.key, 1)}
                              disabled={index === form.imageSlots.length - 1}
                              aria-label={`Move slot ${index + 1} down`}
                              className={ICON_BUTTON_CLASSES}
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeSlot(slot.key)}
                              aria-label={`Remove slot ${index + 1}`}
                              className={ICON_BUTTON_CLASSES}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          value={slot.label}
                          onChange={(e) => updateSlot(slot.key, { label: e.target.value })}
                          maxLength={INTAKE.slotLabel}
                          placeholder='Label, e.g. "Logo"'
                          aria-label={`Slot ${index + 1} label`}
                          className={INPUT_CLASSES}
                        />
                        <textarea
                          value={slot.description}
                          onChange={(e) => updateSlot(slot.key, { description: e.target.value })}
                          maxLength={INTAKE.slotDescription}
                          rows={2}
                          placeholder="What it's for, e.g. Square PNG, shown in the site header"
                          aria-label={`Slot ${index + 1} description`}
                          className={`${INPUT_CLASSES} resize-none`}
                        />
                      </li>
                    ))}
                  </ol>
                )}

                <button
                  type="button"
                  onClick={addSlot}
                  disabled={form.imageSlots.length >= INTAKE.maxImageSlots}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>
                    {form.imageSlots.length >= INTAKE.maxImageSlots
                      ? `Maximum of ${INTAKE.maxImageSlots} slots reached`
                      : "Add image slot"}
                  </span>
                </button>
              </div>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
              Live preview URL
            </span>
            <input
              type="url"
              value={form.liveUrl}
              onChange={(e) => setField("liveUrl", e.target.value)}
              placeholder="https://my-demo.pages.dev"
              className={`${INPUT_CLASSES} font-mono`}
            />
            <span className="block text-[11px] text-[var(--muted-foreground)]">
              Shown on the Live page. Leave blank to show "Preview coming soon".
            </span>
          </label>

          <div className="block space-y-1.5">
            <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
              Deliverable file
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept={SHOWCASE_FILE_INPUT_ACCEPT}
              onChange={(e) => void handleFileSelected(e.target.files)}
              disabled={uploading || saving}
              className="hidden"
              id="showcase-file-input"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor="showcase-file-input"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 cursor-pointer ${
                  uploading || saving ? "opacity-50 pointer-events-none" : ""
                }`}
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                <span>{uploading ? "Uploading…" : form.fileRef ? "Replace file" : "Upload file"}</span>
              </label>
              {form.fileRef && !uploading && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-300 break-all">
                  <FileCheck2 className="h-3.5 w-3.5 shrink-0" />
                  {form.fileRef}
                </span>
              )}
            </div>
            {lastUploadUrl && !uploading && (
              <a
                href={lastUploadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[11px] text-[var(--fg-1)] underline break-all w-fit"
              >
                Open uploaded file
              </a>
            )}
            {uploadError && (
              <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-rose-950/20 text-rose-300 border border-rose-900/50">
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
            <span className="block text-[11px] text-[var(--muted-foreground)]">
              Zip, HTML, or image, up to 40 MB. The Supervisor sees this path; regular users only ever
              get a signed download link.
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div>
              <div className="text-sm text-[var(--card-foreground)]">Visible to users</div>
              <div className="text-[11px] text-[var(--muted-foreground)]">
                Off = hidden from Showcase and Live (only you can see it here).
              </div>
            </div>
            <Switch
              checked={form.active}
              onChange={() => setField("active", !form.active)}
              label="Visible to users"
            />
          </div>

          {formError && (
            <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-rose-950/20 text-rose-300 border border-rose-900/50">
              <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={closeForm}
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving || !form.title.trim()}
              className="px-4 py-2 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}

      {!loadError && items === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading Showcase items…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && items !== null && items.length === 0 && editingId === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          No Showcase items yet. Use "Add item" to post your first one.
        </div>
      )}

      {!loadError && items !== null && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--card-foreground)] break-words">
                      {item.title || "(untitled)"}
                    </span>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        item.active
                          ? "bg-emerald-950/40 text-emerald-300 border-emerald-900/50"
                          : "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]"
                      }`}
                    >
                      {item.active ? "Active" : "Hidden"}
                    </span>
                  </div>
                  {item.description && (
                    <p className="text-xs text-[var(--muted-foreground)] line-clamp-2 break-words">
                      {item.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
                    <span>Code: {item.priceCode != null ? formatNaira(item.priceCode) : "not offered"}</span>
                    <span>Custom URL: {item.priceUrl != null ? formatNaira(item.priceUrl) : "not offered"}</span>
                    <span className="break-all">Live: {item.liveUrl ? item.liveUrl : "none yet"}</span>
                    {item.priceUrl != null && <span>Intake: {describeIntake(item)}</span>}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Switch
                    checked={item.active}
                    onChange={() => void handleToggleActive(item)}
                    disabled={togglingId !== null || saving || editingId !== null}
                    label={`${item.title || "Item"} visible to users`}
                  />
                  <button
                    onClick={() => openEdit(item)}
                    disabled={saving || editingId !== null}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--secondary)] hover:opacity-90 text-xs text-[var(--secondary-foreground)] disabled:opacity-50"
                  >
                    <Pencil className="h-3 w-3" />
                    <span>Edit</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
