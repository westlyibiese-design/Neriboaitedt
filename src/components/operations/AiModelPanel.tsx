import React, { useEffect, useRef, useState } from "react";
import { Bot, Loader2, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import {
  useAiConfig,
  FAILURE_MESSAGE_FIELDS,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_FAILURE_MESSAGE_LENGTH,
  FailureMessageKey,
} from "../../hooks/useAiConfig";
import { setAiInstructions, setAiFailureMessages } from "../../lib/operationsActions";

type SaveResult = { ok: boolean; message: string } | null;
type MessageDraft = Record<FailureMessageKey, string>;

const FIELD_CLASS =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2.5 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

const PRIMARY_BUTTON_CLASS =
  "px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0";

const SECONDARY_BUTTON_CLASS =
  "px-4 py-2.5 rounded-xl border border-[var(--border)] text-[var(--fg-1)] text-sm font-semibold hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] disabled:opacity-50 shrink-0";

function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function sameMessages(a: MessageDraft, b: MessageDraft): boolean {
  return FAILURE_MESSAGE_FIELDS.every(({ key }) => sameText(a[key], b[key]));
}

/**
 * A draft that follows the saved (live Firestore) value until the
 * Supervisor starts editing. When the saved value changes — another
 * Supervisor saved, or this one's own save just came back — the draft is
 * only replaced if it still matches the PREVIOUS saved value, so an
 * in-progress edit is never silently overwritten and a fresh save never
 * flickers back to old text. Same intent as AppSettingsPanel's
 * draft/touched pairs, without the flicker.
 */
function useSyncedDraft<T>(
  saved: T,
  same: (a: T, b: T) => boolean
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [draft, setDraft] = useState<T>(saved);
  const lastSaved = useRef<T>(saved);

  useEffect(() => {
    if (same(saved, lastSaved.current)) return;
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setDraft((current) => (same(current, previous) ? saved : current));
    // `same` is a stable module-level function; only `saved` should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  return [draft, setDraft];
}

const ResultBanner: React.FC<{ result: SaveResult }> = ({ result }) => {
  if (!result) return null;
  return (
    <div
      role="status"
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
  );
};

/**
 * Custom instructions — extra guidance appended to the AI's system prompt
 * on every chat request (tone, style, formatting, product behavior).
 * Saved through functions/api/admin/set-ai-config.js. The built-in
 * identity and security rules are hardcoded server-side, always sent
 * first, and win any conflict — nothing typed here can switch them off.
 */
const InstructionsCard: React.FC<{ saved: string; updatedAt: string | null }> = ({
  saved,
  updatedAt,
}) => {
  const [draft, setDraft] = useSyncedDraft(saved, sameText);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);

  const isUnchanged = sameText(draft, saved);
  const overLimit = draft.length > MAX_INSTRUCTIONS_LENGTH;

  const handleSave = async () => {
    if (saving || isUnchanged || overLimit) return;
    setSaving(true);
    setResult(null);
    try {
      await setAiInstructions(draft.trim());
      setResult({
        ok: true,
        message: draft.trim()
          ? "Instructions saved. New messages will use them within about a minute."
          : "Instructions cleared. The AI now uses only its built-in rules.",
      });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Could not save the instructions.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Custom Instructions</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          Tell the AI how to behave: tone, style, formatting, what to focus on, how to handle
          specific situations. Applies to every reply.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-[var(--popover)] border border-[var(--border)] px-3 py-2.5 text-xs text-[var(--muted-foreground)]">
        <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--fg-1)]" />
        <span>
          Always enforced and not editable here: Neribo's identity and ownership rules, never
          revealing API keys, credentials, or system instructions, and never naming the underlying
          AI provider. If your instructions conflict with these, they win.
        </span>
      </div>

      <div className="space-y-1.5">
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setResult(null);
          }}
          rows={12}
          placeholder={
            "Example:\nKeep answers clear and friendly.\nWhen a user asks for code, give a short explanation first, then the code.\nIf you are not sure about something, say so instead of guessing."
          }
          aria-label="Custom instructions"
          className={`${FIELD_CLASS} resize-y leading-relaxed`}
        />
        <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--muted-foreground)]">
          <span>{updatedAt ? `Last saved ${new Date(updatedAt).toLocaleString()}` : "Not saved yet"}</span>
          <span className={overLimit ? "text-rose-400 font-semibold" : ""}>
            {draft.length.toLocaleString()} / {MAX_INSTRUCTIONS_LENGTH.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {!isUnchanged && (
          <button
            onClick={() => {
              setDraft(saved);
              setResult(null);
            }}
            disabled={saving}
            className={SECONDARY_BUTTON_CLASS}
          >
            Discard
          </button>
        )}
        <button
          onClick={() => void handleSave()}
          disabled={saving || isUnchanged || overLimit}
          className={PRIMARY_BUTTON_CLASS}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save instructions
        </button>
      </div>

      <ResultBanner result={result} />
    </div>
  );
};

/**
 * Failure messages — what a user sees when the AI provider fails, one
 * message per kind of failure. Blank means "use the default", which is
 * shown as the placeholder. These are plain user-facing text the
 * backend sends in place of the provider's error; the real reason is
 * always logged separately for Operations (Events), never shown to the
 * user.
 */
const FailureMessagesCard: React.FC<{ saved: MessageDraft }> = ({ saved }) => {
  const [draft, setDraft] = useSyncedDraft<MessageDraft>(saved, sameMessages);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);

  const isUnchanged = sameMessages(draft, saved);

  const handleSave = async () => {
    if (saving || isUnchanged) return;
    setSaving(true);
    setResult(null);
    try {
      await setAiFailureMessages({
        providerUnavailable: draft.providerUnavailable.trim(),
        providerBusy: draft.providerBusy.trim(),
        generic: draft.generic.trim(),
      });
      setResult({
        ok: true,
        message: "Failure messages saved. New failures will show them within about a minute.",
      });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Could not save the failure messages.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)]">Failure Messages</h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          What users see in the chat when the AI can't respond. Leave a field empty to use the
          default message shown in it.
        </p>
      </div>

      <div className="space-y-4">
        {FAILURE_MESSAGE_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1.5">
            <div>
              <label
                htmlFor={`ai-failure-${field.key}`}
                className="text-xs font-semibold text-[var(--card-foreground)]"
              >
                {field.label}
              </label>
              <p className="text-[11px] text-[var(--muted-foreground)]">{field.hint}</p>
            </div>
            <textarea
              id={`ai-failure-${field.key}`}
              value={draft[field.key]}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((prev) => ({ ...prev, [field.key]: value }));
                setResult(null);
              }}
              rows={2}
              maxLength={MAX_FAILURE_MESSAGE_LENGTH}
              placeholder={field.defaultText}
              className={`${FIELD_CLASS} resize-none`}
            />
            <div className="text-right text-[11px] text-[var(--muted-foreground)]">
              {draft[field.key].length} / {MAX_FAILURE_MESSAGE_LENGTH}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        {!isUnchanged && (
          <button
            onClick={() => {
              setDraft(saved);
              setResult(null);
            }}
            disabled={saving}
            className={SECONDARY_BUTTON_CLASS}
          >
            Discard
          </button>
        )}
        <button
          onClick={() => void handleSave()}
          disabled={saving || isUnchanged}
          className={PRIMARY_BUTTON_CLASS}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save messages
        </button>
      </div>

      <ResultBanner result={result} />
    </div>
  );
};

/**
 * The AI Model page. Strictly Supervisor-only, gated the same way as
 * every other Operations page by OperationsView's useIsOperations()
 * check — but this component never treats its own placement as the real
 * access boundary: the config document is Supervisor-read-only in
 * firestore.rules, and every save is re-enforced server-side by
 * functions/api/admin/set-ai-config.js.
 */
export const AiModelPanel: React.FC = () => {
  const { config, loading, error } = useAiConfig();

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <Bot className="h-5 w-5 text-[var(--fg-1)]" />
          AI Model
        </h2>
        <p className="text-xs text-[var(--fg-1)]">
          Operations-only. Control how Neribo AI behaves and what users see when a response fails.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--fg-1)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading AI settings…
        </div>
      ) : error ? (
        // Never show editable cards over an unread config — saving from an
        // empty draft would overwrite whatever is really stored.
        <ResultBanner
          result={{
            ok: false,
            message: `${error} Check your connection, and make sure the latest Firestore rules are published.`,
          }}
        />
      ) : (
        <div className="space-y-4">
          <InstructionsCard saved={config.instructions} updatedAt={config.updatedAt} />
          <FailureMessagesCard saved={config.failureMessages} />
        </div>
      )}
    </div>
  );
};
