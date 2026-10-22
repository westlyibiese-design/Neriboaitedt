import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, ImageIcon, Loader2, RotateCw, X } from "lucide-react";
import { Order } from "../types";
import {
  CLONE_IMAGE_ACCEPT,
  CLONE_IMAGE_MAX_BYTES,
  CloneImageApiError,
  CloneImageSlot,
  fetchCloneImageSlots,
  formatBytes,
  uploadCloneImage,
  validateImageFile,
} from "../lib/cloneImagesApi";

// PHASE 12 — per-slot image upload (routed to Telegram, NOT Supabase).
// PHASE 14 — a received slot can be REPLACED, not just locked; see below.
//
// Shown inside OrdersView's order card (src/components/Workspaces.tsx) for a
// `type: "url"` order whose status is "awaiting_images": the AI intake (Phase
// 11) is complete and the Showcase item defines image slots. This replaces
// Phase 11's "that step isn't ready yet" placeholder.
//
// HOW IT WORKS
//   - One control per slot, each labelled with the slot's label + description
//     (the list comes from the server, so it works even if the Supervisor
//     hides the item after purchase).
//   - The customer chooses an image for EVERY slot (with a thumbnail preview
//     and the chance to change it), and only then does "Send images" enable.
//     That is enforced here for clarity and again on the server, which is what
//     actually decides completeness: it moves the order to "in_progress" only
//     when every slot has a stored entry.
//   - "Send images" uploads the images one at a time. Each goes through
//     functions/api/orders/upload-clone-image.js, which verifies it, forwards
//     it to Telegram and records a pointer on the order. Images already
//     received AND NOT being replaced are skipped, so after a failure
//     "Try again" continues where it stopped instead of starting over.
//   - "Received" per slot is read from the live order (`order.cloneImages`,
//     via the orders listener), i.e. from what the server actually stored —
//     its LATEST verified entry, if the slot was ever replaced.
//   - A received slot shows a "Replace" button, for as long as the order is
//     still "awaiting_images": picking a new file for it behaves exactly
//     like picking one for an empty slot (preview, Change, remove) and is
//     sent as a replacement, not blocked as a duplicate. The moment the
//     order reaches "in_progress" this component stops rendering the
//     per-slot controls at all (the `finished` branch below) — every slot,
//     replaced or not, is then fully locked with nothing left to press.
//
// This component never talks to Telegram, never sees a bot token and never
// writes to Firestore — everything goes through src/lib/cloneImagesApi.ts.

const INPUT_ACCEPT = CLONE_IMAGE_ACCEPT;

interface Picked {
  file: File;
  previewUrl: string;
}

type LoadPhase = "loading" | "ready" | "loadError";

export const OrderImageUpload: React.FC<{
  order: Order;
  /** Called synchronously right before the first upload of this session starts.
   * The parent uses it to keep this component mounted: the live orders
   * listener flips `status` to "in_progress" the moment the server records the
   * last image — which can be before the HTTP response gets here — and without
   * this the confirmation below would be unmounted before it was ever shown. */
  onUploadStart: () => void;
}> = ({ order, onUploadStart }) => {
  const [slots, setSlots] = useState<CloneImageSlot[]>([]);
  const [maxBytes, setMaxBytes] = useState(CLONE_IMAGE_MAX_BYTES);
  const [phase, setPhase] = useState<LoadPhase>(order.status === "awaiting_images" ? "loading" : "ready");
  const [loadError, setLoadError] = useState<CloneImageApiError | null>(null);
  const [picked, setPicked] = useState<Record<number, Picked>>({});
  const [slotErrors, setSlotErrors] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState<{ index: number; percent: number } | null>(null);
  const [submitError, setSubmitError] = useState<CloneImageApiError | null>(null);
  // Slots the SERVER has confirmed in a response, by index -> file name. Only
  // fills the gap until the live listener delivers `order.cloneImages`.
  const [justSent, setJustSent] = useState<Record<number, string>>({});

  const aliveRef = useRef(true);
  const startedRef = useRef(false);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const p of Object.values(pickedRef.current)) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  // ---- what has been received (live from the order, plus this session) ----
  // Only `verified` entries count. firestore.rules (Phase 12) lets the owner
  // append a record to `cloneImages` too, but only the upload endpoint can
  // ever set `verified: true` (after Telegram actually accepted the image) —
  // so an unverified entry is treated exactly like no entry at all here.
  // PHASE 14: a slot can have more than one verified entry (a replacement
  // before the order completed) — iterating the array in order and letting a
  // later entry overwrite an earlier one in the Map naturally keeps only the
  // LATEST filename per slot.
  const receivedNames = new Map<number, string>();
  for (const e of order.cloneImages ?? []) {
    if (e.verified) receivedNames.set(e.slotIndex, e.originalFilename);
  }
  // This session's own just-confirmed result always wins over the live order
  // snapshot: right after a (first-time or replacement) upload, the listener
  // may not have delivered the new `cloneImages` entry yet, and for a
  // replacement the snapshot would still show the OLD filename until it does.
  for (const [k, name] of Object.entries(justSent)) {
    receivedNames.set(Number(k), name);
  }

  const finished = order.status === "in_progress";

  const loadSlots = async () => {
    setPhase("loading");
    setLoadError(null);
    try {
      const s = await fetchCloneImageSlots(order.id);
      if (!aliveRef.current) return;
      setSlots(s.slots);
      setMaxBytes(s.limits.maxBytes);
      setPhase("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(
        err instanceof CloneImageApiError ? err : new CloneImageApiError("SERVER_ERROR", "Something went wrong. Please try again.")
      );
      setPhase("loadError");
    }
  };

  useEffect(() => {
    // Nothing to load once the order has moved on (the confirmation needs no list).
    if (order.status === "awaiting_images") void loadSlots();
  }, [order.id]);

  // ---- choosing / removing ----
  const clearPicks = () => {
    for (const p of Object.values(pickedRef.current)) URL.revokeObjectURL(p.previewUrl);
    setPicked({});
  };

  const setSlotError = (index: number, message: string | null) =>
    setSlotErrors((prev) => {
      const next = { ...prev };
      if (message) next[index] = message;
      else delete next[index];
      return next;
    });

  const removePick = (index: number) => {
    setPicked((prev) => {
      const existing = prev[index];
      if (existing) URL.revokeObjectURL(existing.previewUrl);
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleChoose = (slot: CloneImageSlot, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    // Reset so choosing the same file again still fires `change`.
    e.target.value = "";
    if (!file) return;
    const problem = validateImageFile(file, maxBytes);
    if (problem) {
      setSlotError(slot.index, problem);
      return;
    }
    setSlotError(slot.index, null);
    setSubmitError(null);
    setPicked((prev) => {
      const existing = prev[slot.index];
      if (existing) URL.revokeObjectURL(existing.previewUrl);
      return { ...prev, [slot.index]: { file, previewUrl: URL.createObjectURL(file) } };
    });
  };

  // ---- sending ----
  const handleSubmit = async () => {
    if (submitting) return;
    if (!startedRef.current) {
      startedRef.current = true;
      onUploadStart();
    }
    setSubmitting(true);
    setSubmitError(null);

    // Snapshot: while submitting, the picker is disabled, so this can't change.
    const chosen = pickedRef.current;
    try {
      for (const slot of slots) {
        const pick = chosen[slot.index];
        // Nothing new chosen for this slot: either it was never touched, or
        // it's already received and the customer didn't choose a
        // replacement. PHASE 14: a received slot WITH a pick is sent as a
        // replacement, so (unlike before) an already-received slot is no
        // longer skipped outright here — only an empty pick is.
        if (!pick) continue;

        setSending({ index: slot.index, percent: 0 });
        try {
          const result = await uploadCloneImage(order.id, slot, pick.file, (percent) => {
            if (aliveRef.current) setSending({ index: slot.index, percent });
          });
          if (!aliveRef.current) return;
          setJustSent((prev) => ({ ...prev, [slot.index]: result.received.originalFilename || pick.file.name }));
          removePick(slot.index);
          if (result.allReceived) break;
        } catch (err) {
          if (!aliveRef.current) return;
          const apiErr =
            err instanceof CloneImageApiError
              ? err
              : new CloneImageApiError("SERVER_ERROR", "Something went wrong. Please try again.");
          const keepGoing = await handleUploadError(apiErr, slot, pick);
          if (!keepGoing) break;
        }
      }
    } finally {
      if (aliveRef.current) {
        setSubmitting(false);
        setSending(null);
      }
    }
  };

  /** Returns true if the loop should carry on to the next slot. */
  const handleUploadError = async (err: CloneImageApiError, slot: CloneImageSlot, pick: Picked): Promise<boolean> => {
    switch (err.code) {
      case "SLOT_ALREADY_RECEIVED":
        // It landed already (e.g. an earlier attempt whose reply was lost).
        setJustSent((prev) => ({ ...prev, [slot.index]: pick.file.name }));
        removePick(slot.index);
        return true;
      case "SLOTS_CHANGED":
        // The team edited the list of images: indexes may have shifted, so
        // start the choices over against the fresh list.
        clearPicks();
        await loadSlots();
        if (aliveRef.current) {
          setSubmitError(
            new CloneImageApiError(
              "SLOTS_CHANGED",
              "The list of images we need has just changed. Please choose your images again."
            )
          );
        }
        return false;
      case "UNSUPPORTED_TYPE":
      case "IMAGE_REJECTED":
      case "FILE_TOO_LARGE":
      case "EMPTY_FILE":
      case "INVALID_FILE":
        // This particular file can't be used: drop it so another can be chosen.
        removePick(slot.index);
        setSlotError(slot.index, err.message);
        return false;
      default:
        break;
    }
    setSubmitError(err);
    if (err.code === "NETWORK_ERROR") {
      // The connection dropped: the image may or may not have landed. The live
      // order will show it if it did; this just checks the order can still take
      // images, so a permanent problem isn't dressed up as "try again".
      try {
        await fetchCloneImageSlots(order.id);
      } catch (probe) {
        if (aliveRef.current && probe instanceof CloneImageApiError && !probe.retryable) setSubmitError(probe);
      }
    }
    return false;
  };

  // ---- derived view state ----
  const receivedCount = slots.filter((s) => receivedNames.has(s.index)).length;
  const chosenCount = slots.filter((s) => receivedNames.has(s.index) || picked[s.index]).length;
  const allChosen = slots.length > 0 && chosenCount === slots.length;
  const sendingPosition = sending ? slots.findIndex((s) => s.index === sending.index) + 1 : 0;
  // PHASE 14: `slots.length - receivedCount` (the old formula) is only
  // "not-yet-received slots" — it misses a replacement pick for a slot
  // that's already received, which handleSubmit sends too. Count what will
  // actually be sent directly, from `picked` itself.
  const pendingCount = Object.keys(picked).length;

  // ---- finished ----
  if (finished) {
    const list = slots.length > 0 ? slots : null;
    // Fallback for when no server-loaded slot list is available (e.g. the
    // page loaded straight into "in_progress"): dedupe the raw stored
    // entries down to one row per slot — a slot replaced before completion
    // (PHASE 14) can have more than one verified entry, and only the latest
    // should show here.
    const fallbackRows = list
      ? null
      : Array.from(
          (order.cloneImages ?? []).reduce((m, e) => {
            if (e.verified) m.set(e.slotIndex, e);
            return m;
          }, new Map<number, { slotLabel: string; originalFilename: string }>())
        )
          .sort(([a], [b]) => a - b)
          .map(([key, e]) => ({ key, label: e.slotLabel, name: e.originalFilename }));
    return (
      <div className="space-y-2.5">
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-3.5 py-3 text-xs text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">All images received — thank you!</p>
            <p className="leading-relaxed">We're working on your order.</p>
          </div>
        </div>
        {(list || (order.cloneImages ?? []).some((e) => e.verified)) && (
          <ul className="space-y-1 text-[11px] text-[var(--muted-foreground)]">
            {(list
              ? list.map((s) => ({ key: s.index, label: s.label, name: receivedNames.get(s.index) ?? "" }))
              : fallbackRows!
            ).map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-x-1.5 break-words">
                <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                <span className="font-medium text-[var(--card-foreground)]">{row.label}</span>
                {row.name && <span className="break-all">· {row.name}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- loading / load error ----
  if (phase === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--popover)] px-3.5 py-3 text-xs text-[var(--muted-foreground)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading your image list…</span>
      </div>
    );
  }
  if (phase === "loadError") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 px-3.5 py-3 text-xs text-rose-300"
      >
        <span className="min-w-0 break-words">
          {loadError?.code === "NO_IMAGE_SLOTS"
            ? "There aren't any images to upload for this order. The team will follow up if anything is needed."
            : (loadError?.message ?? "Something went wrong. Please try again.")}
        </span>
        {loadError?.retryable && (
          <button
            type="button"
            onClick={() => void loadSlots()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--secondary)] text-[11px] text-[var(--secondary-foreground)] hover:opacity-90"
          >
            <RotateCw className="h-3 w-3" />
            <span>Try again</span>
          </button>
        )}
      </div>
    );
  }

  const barPercent = slots.length > 0 ? Math.round((receivedCount / slots.length) * 100) : 0;

  return (
    <div className="space-y-3.5 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3.5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[var(--card-foreground)]">Upload your images</p>
          <p className="text-[11px] text-[var(--muted-foreground)]">
            {receivedCount} of {slots.length} received
          </p>
        </div>
        <div className="h-1 rounded-full bg-[var(--elevated)] overflow-hidden">
          <div className="h-full rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${barPercent}%` }} />
        </div>
        <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
          Choose one image for each item below, then send them together. PNG, JPEG, WebP or GIF, up to{" "}
          {formatBytes(maxBytes)} each. You can replace an image any time before your order moves to production.
        </p>
      </div>

      <ul className="space-y-2.5">
        {slots.map((slot) => {
          const receivedName = receivedNames.get(slot.index);
          const pick = picked[slot.index];
          const sendingPercent = sending && sending.index === slot.index ? sending.percent : null;
          const isSending = sendingPercent !== null;
          const error = slotErrors[slot.index];
          return (
            <li
              key={slot.index}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 space-y-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-semibold text-[var(--card-foreground)] break-words">{slot.label}</p>
                {slot.description && (
                  <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed break-words">
                    {slot.description}
                  </p>
                )}
              </div>

              {pick ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2.5">
                    <img
                      src={pick.previewUrl}
                      alt={`Preview of your image for ${slot.label}`}
                      className="h-12 w-12 shrink-0 rounded-md object-cover border border-[var(--border)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-[var(--card-foreground)] break-all">{pick.file.name}</p>
                      <p className="text-[11px] text-[var(--muted-foreground)]">{formatBytes(pick.file.size)}</p>
                    </div>
                    {isSending ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-blue-300 tabular-nums">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {sendingPercent}%
                      </span>
                    ) : (
                      <div className="shrink-0 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => inputRefs.current[slot.index]?.click()}
                          disabled={submitting}
                          className="px-2.5 py-1 rounded-full bg-[var(--secondary)] text-[11px] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() => removePick(slot.index)}
                          disabled={submitting}
                          aria-label={`Remove the image chosen for ${slot.label}`}
                          className="h-6 w-6 inline-flex items-center justify-center rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {isSending && (
                    <div className="h-1 rounded-full bg-[var(--elevated)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-600 transition-all duration-200"
                        style={{ width: `${sendingPercent}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : receivedName !== undefined ? (
                // PHASE 14: a received slot is no longer a dead end — the
                // customer can pick a replacement for as long as the order is
                // still awaiting_images (this component isn't even rendered
                // once it's "in_progress"; see the `finished` branch above).
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2 text-[11px] text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">Received{receivedName ? ` · ${receivedName}` : ""}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => inputRefs.current[slot.index]?.click()}
                    disabled={submitting}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-[var(--secondary)] text-[11px] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
                  >
                    Replace
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => inputRefs.current[slot.index]?.click()}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--secondary)] text-xs text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  <span>Choose image</span>
                </button>
              )}

              {/* One hidden input per slot; the buttons above open it. */}
              <input
                ref={(el) => {
                  inputRefs.current[slot.index] = el;
                }}
                type="file"
                accept={INPUT_ACCEPT}
                className="hidden"
                tabIndex={-1}
                aria-label={`Choose an image for ${slot.label}`}
                onChange={(e) => handleChoose(slot, e)}
              />

              {error && (
                <p role="alert" className="text-[11px] text-rose-300 break-words">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {submitError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300"
        >
          <span className="min-w-0 break-words">{submitError.message}</span>
          {submitError.retryable && (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--secondary)] text-[11px] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              <RotateCw className="h-3 w-3" />
              <span>Try again</span>
            </button>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || !allChosen}
          className="w-full px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitting
            ? `Sending image ${sendingPosition || 1} of ${slots.length}…`
            : `Send ${pendingCount === 1 ? "image" : "images"}`}
        </button>
        {!allChosen && !submitting && (
          <p className="text-[11px] text-[var(--muted-foreground)] text-center">
            Choose an image for every item to continue ({chosenCount} of {slots.length} chosen).
          </p>
        )}
        {submitting && (
          <p className="text-[11px] text-amber-300 text-center">Please keep this page open until every image is sent.</p>
        )}
      </div>
    </div>
  );
};
