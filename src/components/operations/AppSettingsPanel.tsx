import React, { useEffect, useState } from "react";
import { Settings2, Loader2, CheckCircle2, XCircle, Cpu } from "lucide-react";
import { useAppVersion } from "../../hooks/useAppVersion";
import { useModelDisplay } from "../../hooks/useModelDisplay";
import { useShowcaseEnabled } from "../../hooks/useShowcaseEnabled";
import { useCheckoutEnabled } from "../../hooks/useCheckoutEnabled";
import { useChatNeriboEnabled } from "../../hooks/useChatNeriboEnabled";
import { useDomainsEnabled } from "../../hooks/useDomainsEnabled";
import {
  setAppVersion,
  setCheckoutEnabled,
  setChatNeriboEnabled,
  setDomainsEnabled,
  setModelDisplay,
  setShowcaseEnabled,
} from "../../lib/operationsActions";
import { getDisplayModels, NeriboModel } from "../../lib/models";

/**
 * One row in the App Settings registry. Every setting on this page is
 * one of these — adding a future setting is "write a new
 * SettingRow-shaped component, add one entry to APP_SETTINGS below",
 * never a redesign of this page. Each setting owns its own Firestore
 * document (appConfig/{id}) and its own read hook and write endpoint,
 * the same isolation pattern as users/{uid}/meta/status vs.
 * meta/network — so settings can never clobber each other, and removing
 * or changing one never risks another.
 */
interface AppSettingDefinition {
  id: string;
  render: () => React.ReactNode;
}

const APP_SETTINGS: AppSettingDefinition[] = [
  { id: "app-version", render: () => <AppVersionSetting /> },
  { id: "models", render: () => <ModelsSetting /> },
  { id: "showcase-enabled", render: () => <ShowcaseEnabledSetting /> },
  { id: "checkout-enabled", render: () => <CheckoutEnabledSetting /> },
  { id: "chat-neribo-enabled", render: () => <ChatNeriboEnabledSetting /> },
  { id: "domains-enabled", render: () => <DomainsEnabledSetting /> },
  // Future settings go here, e.g.:
  // { id: "maintenance-mode", render: () => <MaintenanceModeSetting /> },
];

/**
 * The App Version setting — reads the live value via useAppVersion()
 * (the same hook every public surface uses, so what a Supervisor sees
 * here is exactly what users see) and saves through
 * functions/api/admin/set-app-version.js, the only path allowed to
 * write appConfig/version (see firestore.rules).
 */
const AppVersionSetting: React.FC = () => {
  const currentVersion = useAppVersion();
  const [draft, setDraft] = useState(currentVersion);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Keep the draft in sync with the live value — but only while the
  // Supervisor hasn't started editing, so an in-progress edit is never
  // silently overwritten by a listener update (e.g. another Supervisor
  // saving at the same time).
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setDraft(currentVersion);
  }, [currentVersion, touched]);

  const isUnchanged = draft.trim() === currentVersion;

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed || isUnchanged) return;
    setSaving(true);
    setResult(null);
    try {
      await setAppVersion(trimmed);
      setResult({ ok: true, message: "App version updated." });
      setTouched(false);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save the version." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">App Version</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          Shown throughout the public app. Updating it here reflects everywhere automatically.
        </p>
      </div>

      <div className="text-xs text-[var(--muted-foreground)]">
        Current: <span className="font-mono text-[var(--card-foreground)]">{currentVersion}</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTouched(true);
            setResult(null);
          }}
          placeholder="e.g. V1.0.4"
          className="flex-1 rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2.5 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] font-mono"
        />
        <button
          onClick={() => void handleSave()}
          disabled={saving || !draft.trim() || isUnchanged}
          className="px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>
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
    </div>
  );
};

/**
 * The Showcase enabled setting — the sitewide on/off switch for the
 * Showcase and Live pages. Reads the live value via useShowcaseEnabled()
 * (the same hook the public pages use, so what a Supervisor sees here is
 * exactly what users get) and saves through
 * functions/api/admin/set-showcase-enabled.js, the only path allowed to
 * write appConfig/showcase-enabled (see firestore.rules).
 *
 * Turning it off never affects this Supervisor's own curation: the
 * Showcase Management panel doesn't read this flag at all.
 */
const ShowcaseEnabledSetting: React.FC = () => {
  const { enabled, loading } = useShowcaseEnabled();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleToggle = async () => {
    const next = !enabled;
    setSaving(true);
    setResult(null);
    try {
      await setShowcaseEnabled(next);
      setResult({
        ok: true,
        message: next ? "Showcase is now enabled for users." : "Showcase is now paused for users.",
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save this setting." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Showcase enabled</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          When off, users see Showcase and Live as temporarily unavailable. You can keep managing
          items in Showcase Management while it's paused.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[var(--muted-foreground)]">
          Currently:{" "}
          <span className="font-semibold text-[var(--card-foreground)]">
            {loading ? "Loading…" : enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Showcase enabled"
          onClick={() => void handleToggle()}
          disabled={loading || saving}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-emerald-600" : "bg-[var(--muted)]"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
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
    </div>
  );
};

/**
 * The Checkout enabled setting — the sitewide on/off switch for buying
 * anything from Showcase (Phase 4). Reads the live value via
 * useCheckoutEnabled() (the same hook the public Orders/Showcase pages
 * use, so what a Supervisor sees here is exactly what users get) and
 * saves through functions/api/admin/set-checkout-enabled.js, the only
 * path allowed to write appConfig/checkout-enabled (see firestore.rules).
 *
 * Turning it off pauses NEW purchases only: "Add to Orders" and both
 * checkout buttons are disabled for users, and initialize.js refuses to
 * start a payment. Orders itself stays visible, and a payment a user
 * already started at Paystack still completes (the webhook is never
 * gated by this flag) — so nobody who has already paid is left unfulfilled.
 */
const CheckoutEnabledSetting: React.FC = () => {
  const { enabled, loading } = useCheckoutEnabled();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleToggle = async () => {
    const next = !enabled;
    setSaving(true);
    setResult(null);
    try {
      await setCheckoutEnabled(next);
      setResult({
        ok: true,
        message: next ? "Checkout is now enabled for users." : "Checkout is now paused for users.",
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save this setting." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Checkout enabled</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          When off, users can't add items to Orders or pay, and see "checkout is temporarily
          paused". Orders stays visible, and payments already in progress still complete.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[var(--muted-foreground)]">
          Currently:{" "}
          <span className="font-semibold text-[var(--card-foreground)]">
            {loading ? "Loading…" : enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Checkout enabled"
          onClick={() => void handleToggle()}
          disabled={loading || saving}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-emerald-600" : "bg-[var(--muted)]"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
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
    </div>
  );
};

/**
 * The Models setting — lets the Supervisor edit the PUBLIC display info
 * (name/tag/description) for each of Neribo's three known models. The
 * model's `id` (its actual routing key — see functions/api/llm/chat/
 * completions.js's resolveModel() and src/lib/models.ts's
 * isImageGenerationModel/isProModel) is always shown read-only and is
 * never sent to the save endpoint: functions/api/admin/set-model-display.js
 * only accepts a fixed allowlist of IDs and only ever writes
 * name/tag/desc for whichever one matches. Editing a display name here
 * can never change which upstream model a request is routed to, break
 * Pro-gating, or reclassify a model between Chat and Art.
 *
 * Reads the live merged list via getDisplayModels() (NERIBO_MODELS +
 * useModelDisplay()'s Firestore overrides) — the exact same function
 * every public surface uses (ChatView's picker, the About panel), so
 * what a Supervisor edits here is a one-to-one match with what users see.
 */
const ModelsSetting: React.FC = () => {
  const overrides = useModelDisplay();
  const models = getDisplayModels(overrides);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Displayed Models</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          Edit the name, tag, and description users see for each model. This never changes which
          AI model actually powers a request.
        </p>
      </div>

      <div className="space-y-3">
        {models.map((model) => (
          <ModelDisplayRow key={model.id} model={model} />
        ))}
      </div>
    </div>
  );
};

/**
 * One editable model row within ModelsSetting. Deliberately its own
 * component (rather than inline in ModelsSetting's .map()) so each
 * model has fully independent draft/saving/result state — editing
 * one model can never interfere with an in-progress edit of any
 * other model.
 */
const ModelDisplayRow: React.FC<{ model: NeriboModel }> = ({ model }) => {
  const [name, setName] = useState(model.name);
  const [tag, setTag] = useState(model.tag);
  const [desc, setDesc] = useState(model.desc);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Same "don't clobber an in-progress edit" rule as AppVersionSetting's
  // draft/touched pair, applied to all three fields at once: if the
  // Supervisor hasn't started editing this row, keep it in sync with
  // live Firestore updates (e.g. another Supervisor saved a change).
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) {
      setName(model.name);
      setTag(model.tag);
      setDesc(model.desc);
    }
  }, [model.name, model.tag, model.desc, touched]);

  const isUnchanged = name.trim() === model.name && tag.trim() === model.tag && desc.trim() === model.desc;

  const handleChange = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setter(e.target.value);
    setTouched(true);
    setResult(null);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedTag = tag.trim();
    const trimmedDesc = desc.trim();
    if (!trimmedName || !trimmedTag || !trimmedDesc || isUnchanged) return;
    setSaving(true);
    setResult(null);
    try {
      await setModelDisplay(model.id, { name: trimmedName, tag: trimmedTag, desc: trimmedDesc });
      setResult({ ok: true, message: "Model display updated." });
      setTouched(false);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save this model." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg bg-[var(--popover)] border border-[var(--border)] p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
        <Cpu className="h-3 w-3" />
        <span>
          Internal ID (not editable): <span className="font-mono text-[var(--fg-1)]">{model.id}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input
          type="text"
          value={name}
          onChange={handleChange(setName)}
          placeholder="Display name"
          aria-label={`Display name for ${model.id}`}
          className="rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        />
        <input
          type="text"
          value={tag}
          onChange={handleChange(setTag)}
          placeholder="Tag"
          aria-label={`Tag for ${model.id}`}
          className="rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] sm:w-28"
        />
      </div>

      <textarea
        value={desc}
        onChange={handleChange(setDesc)}
        placeholder="Description"
        aria-label={`Description for ${model.id}`}
        rows={2}
        className="w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
      />

      <div className="flex items-center justify-end">
        <button
          onClick={() => void handleSave()}
          disabled={saving || !name.trim() || !tag.trim() || !desc.trim() || isUnchanged}
          className="px-4 py-2 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
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
    </div>
  );
};

/**
 * The App Settings page itself. Strictly Supervisor-only, gated the
 * same way as every other Operations page by OperationsView's
 * useIsOperations() check — this component never assumes its own
 * placement is the real access boundary; every write it can trigger is
 * re-enforced server-side regardless (functions/api/admin/set-app-version.js).
 */
/**
 * The Chat Neribo enabled setting — the sitewide on/off switch for the
 * regular-user "Chat Neribo" page (Phase 7). Reads the live value via
 * useChatNeriboEnabled() (the same hook App.tsx uses to hide the nav item)
 * and saves through functions/api/admin/set-chat-neribo-enabled.js, the only
 * path allowed to write appConfig/chat-neribo-enabled (see firestore.rules).
 *
 * Turning it off never affects this Supervisor's own Chat Neribo panel or
 * the send endpoint, and the automatic "code purchased" message is still
 * written — so nothing is lost while it's off.
 */
const ChatNeriboEnabledSetting: React.FC = () => {
  const { enabled, loading } = useChatNeriboEnabled();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleToggle = async () => {
    const next = !enabled;
    setSaving(true);
    setResult(null);
    try {
      await setChatNeriboEnabled(next);
      setResult({
        ok: true,
        message: next ? "Chat Neribo is now enabled for users." : "Chat Neribo is now paused for users.",
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save this setting." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Chat Neribo enabled</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          When off, users don't see "Chat Neribo" in their menu. You can keep sending messages
          from Operations → Chat Neribo — they queue up and appear as soon as it's back on.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[var(--muted-foreground)]">
          Currently:{" "}
          <span className="font-semibold text-[var(--card-foreground)]">
            {loading ? "Loading…" : enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Chat Neribo enabled"
          onClick={() => void handleToggle()}
          disabled={loading || saving}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-emerald-600" : "bg-[var(--muted)]"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
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
    </div>
  );
};

/**
 * The Domains enabled setting — the sitewide on/off switch for the
 * regular-user "Domains" nav item (Phase 8). Reads the live value via
 * useDomainsEnabled() (the same hook App.tsx/SidebarDrawer.tsx use to hide
 * the nav item) and saves through functions/api/admin/set-domains-enabled.js,
 * the only path allowed to write appConfig/domains-enabled (see
 * firestore.rules).
 *
 * DISPLAY-only, same as Showcase enabled: turning it off never affects
 * this Supervisor's own Domains Management panel, never blocks an
 * in-flight payment, and a request already `awaiting_payment` is untouched
 * — it just stops being reachable from the regular-user nav until this is
 * back on.
 */
const DomainsEnabledSetting: React.FC = () => {
  const { enabled, loading } = useDomainsEnabled();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleToggle = async () => {
    const next = !enabled;
    setSaving(true);
    setResult(null);
    try {
      await setDomainsEnabled(next);
      setResult({
        ok: true,
        message: next ? "Domains is now enabled for users." : "Domains is now hidden from users.",
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not save this setting." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Domains enabled</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          When off, users with an eligible order don't see "Domains" in their menu. Domains
          Management keeps working, and any request already awaiting payment is unaffected.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[var(--muted-foreground)]">
          Currently:{" "}
          <span className="font-semibold text-[var(--card-foreground)]">
            {loading ? "Loading…" : enabled ? "Enabled" : "Hidden"}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Domains enabled"
          onClick={() => void handleToggle()}
          disabled={loading || saving}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-emerald-600" : "bg-[var(--muted)]"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
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
    </div>
  );
};

export const AppSettingsPanel: React.FC = () => {
  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-[var(--fg-1)]" />
          App Settings
        </h2>
        <p className="text-xs text-[var(--fg-1)]">Operations-only. Changes here apply to the public app.</p>
      </div>

      <div className="space-y-4">
        {APP_SETTINGS.map((setting) => (
          <React.Fragment key={setting.id}>{setting.render()}</React.Fragment>
        ))}
      </div>
    </div>
  );
};
