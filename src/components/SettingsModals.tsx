import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Check,
  Lock,
  Sparkles,
  Clock3,
  Radio,
  Volume2,
  Play,
  Square,
  Bell,
  Paperclip,
  Share2,
  Copy,
  AlertTriangle,
} from "lucide-react";
import { AppSettings, UserAccount } from "../types";
import { NeriboLogo } from "./NeriboLogo";
import { useAppVersion } from "../hooks/useAppVersion";
import { useModelDisplay } from "../hooks/useModelDisplay";
import { getDisplayModels } from "../lib/models";
import { VoiceKey, VOICE_OPTIONS, pickVoice, subscribeToVoices } from "../lib/ttsVoice";

interface ModalWrapperProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const ModalWrapper: React.FC<ModalWrapperProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-[var(--popover)] border border-[var(--border)] rounded-3xl p-6 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--border)]/80 shrink-0">
          <h2 className="text-lg font-semibold text-[var(--popover-foreground)] tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] hover:bg-[var(--elevated)] transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto pt-4 space-y-4 pr-1">{children}</div>
      </div>
    </div>
  );
};

// 1. Upgrade Plan Modal
export const UpgradeModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentPlan: string;
  onSelectPlan: (plan: "Free" | "Pro" | "Team") => void;
}> = ({ isOpen, onClose, currentPlan, onSelectPlan }) => {
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Upgrade Neribo">
      <div className="space-y-4">
        <div className="text-center space-y-1 pb-2">
          <NeriboLogo variant="full" size="md" className="mx-auto mb-2" />
          <p className="text-sm text-[var(--muted-foreground)]">
            Select the tier tailored for your problem-solving velocity.
          </p>
        </div>

        {/* Pro Plan — ₦1,000/week, billed via Paystack (see
            functions/api/payments/initialize.js). This card is the
            Free-tier upsell/pricing view only — a Pro account is routed
            to SubscriptionModal below instead (see App.tsx's
            onOpenBilling), never shown this pricing card. */}
        <div className="p-4 rounded-2xl bg-[var(--muted)] border-2 border-blue-500/80 relative space-y-3">
          <div className="absolute -top-3 right-4 px-3 py-0.5 rounded-full bg-blue-600 text-white font-bold text-[11px] uppercase tracking-wider">
            Popular
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <h3 className="text-lg font-bold text-[var(--popover-foreground)]">Neribo Pro</h3>
              <p className="text-xs text-[var(--muted-foreground)]">For ambitious engineers and builders</p>
            </div>
            <div className="text-right">
              <span className="text-2xl font-black text-[var(--popover-foreground)]">₦1,000</span>
              <span className="text-xs text-[var(--muted-foreground)]">/week</span>
            </div>
          </div>
          <ul className="text-xs text-[var(--muted-foreground)] space-y-1.5">
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span>Web Grounding, Live Search, Visual Artifact & Preview</span>
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span>Access to Neribo.chat.pro, our advanced model</span>
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span>Interactive real-time artifacts & code runner</span>
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span>Low-latency speech & live voice mode</span>
            </li>
          </ul>
          <button
            onClick={() => onSelectPlan("Pro")}
            className="w-full py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md transition-colors"
          >
            Upgrade to Pro
          </button>
          <p className="text-[11px] text-[var(--muted-foreground)] text-center">
            Secure weekly billing via Paystack. Renews automatically.
          </p>
        </div>

        {/* Free Plan */}
        <div className="p-4 rounded-2xl bg-[var(--muted)]/60 border border-[var(--border)] space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-semibold text-[var(--popover-foreground)]">Neribo Standard</h3>
            <span className="text-sm font-semibold text-[var(--muted-foreground)]">₦0 Free</span>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            Standard conversational assistance with basic capabilities.
          </p>
        </div>
      </div>
    </ModalWrapper>
  );
};

// 1b. Subscription Status Modal — shown INSTEAD of UpgradeModal once the
// account is actually on Pro (see App.tsx's onOpenBilling routing), so a
// paying subscriber is never shown the pricing/upsell page they already
// bought, and the two are never mixed on one screen.
export const SubscriptionModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  renewsAt: string | null; // ISO timestamp from users/{uid}/usage/current's resetAt, or null if not loaded yet
  paidAt: string | null; // ISO timestamp from users/{uid}/usage/current's paidAt (last successful charge), or null
  paymentIssue: boolean; // true from invoice.payment_failed until the next successful charge or the natural downgrade
  cancelRequestedAt: string | null; // set once the user has cancelled (see functions/api/payments/cancel.js)
  // Performs the actual cancellation (see src/lib/paymentsApi.ts's
  // cancelSubscription). Expected to handle its own errors (toast, etc.)
  // and never reject — this component only needs to know when the
  // in-flight request has finished, not whether it succeeded.
  onCancelSubscription: () => Promise<void>;
}> = ({ isOpen, onClose, renewsAt, paidAt, paymentIssue, cancelRequestedAt, onCancelSubscription }) => {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Reset the confirm step whenever the modal is reopened, so a stale
  // "are you sure?" from a previous visit never lingers.
  useEffect(() => {
    if (isOpen) {
      setConfirming(false);
      setCancelling(false);
    }
  }, [isOpen]);

  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const paidLabel = paidAt ? shortDate(paidAt) : null;
  const expiresLabel = renewsAt ? shortDate(renewsAt) : null;
  const isCancelled = Boolean(cancelRequestedAt);

  const handleConfirmCancel = async () => {
    setCancelling(true);
    await onCancelSubscription();
    setCancelling(false);
    setConfirming(false);
  };

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Subscription">
      <div className="space-y-4">
        <div className="p-4 rounded-2xl bg-[var(--muted)] border border-blue-500/40 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-[var(--popover-foreground)]">Neribo Pro</h3>
              <p className="text-xs text-[var(--muted-foreground)]">₦1,000 / week</p>
            </div>
            {isCancelled ? (
              <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-semibold text-xs border border-amber-500/30">
                Cancelling
              </span>
            ) : (
              <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold text-xs border border-emerald-500/30">
                Active
              </span>
            )}
          </div>
          <div className="pt-2 border-t border-[var(--border)]/80">
            <p className="text-xs text-[var(--muted-foreground)] space-y-0.5">
              {paidLabel && expiresLabel ? (
                <>
                  <span className="block">
                    Paid: <span className="text-[var(--popover-foreground)] font-medium">{paidLabel}</span>
                  </span>
                  <span className="block">
                    {isCancelled ? "Access ends" : "Expires"}:{" "}
                    <span className="text-[var(--popover-foreground)] font-medium">{expiresLabel}</span>
                  </span>
                  {isCancelled && (
                    <span className="block pt-1 text-[var(--muted-foreground)]">
                      Won't renew after this date.
                    </span>
                  )}
                </>
              ) : (
                "Subscription details will appear here shortly."
              )}
            </p>
          </div>
        </div>

        {paymentIssue && !isCancelled && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/90">
              We couldn't process your last renewal payment.
              {expiresLabel ? ` If this isn't resolved by ${expiresLabel}, ` : " If this isn't resolved soon, "}
              your subscription will end automatically.
            </p>
          </div>
        )}

        {!isCancelled && (
          <div className="pt-1">
            {!confirming ? (
              <button
                onClick={() => setConfirming(true)}
                className="w-full py-2 rounded-full border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] hover:border-[var(--muted-foreground)] font-medium text-xs transition-colors"
              >
                Cancel subscription
              </button>
            ) : (
              <div className="p-3 rounded-xl bg-[var(--muted)] border border-[var(--border)] space-y-2.5">
                <p className="text-xs text-[var(--muted-foreground)]">
                  Cancel your Neribo Pro subscription?
                  {expiresLabel ? ` You'll keep access until ${expiresLabel}.` : ""}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={cancelling}
                    className="flex-1 py-2 rounded-full border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] font-medium text-xs transition-colors disabled:opacity-50"
                  >
                    Keep subscription
                  </button>
                  <button
                    onClick={handleConfirmCancel}
                    disabled={cancelling}
                    className="flex-1 py-2 rounded-full bg-red-600/90 hover:bg-red-600 text-white font-semibold text-xs transition-colors disabled:opacity-50"
                  >
                    {cancelling ? "Cancelling…" : "Yes, cancel"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-[var(--muted-foreground)] text-center">
          Billed automatically via Paystack.
        </p>
      </div>
    </ModalWrapper>
  );
};

// 2. Capabilities Modal
export const CapabilitiesModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  isPremium: boolean;
  onToggle: (key: keyof AppSettings["capabilities"]) => void;
  onRequirePremium: () => void;
}> = ({ isOpen, onClose, settings, isPremium, onToggle, onRequirePremium }) => {
  const caps: Array<{
    key: keyof AppSettings["capabilities"];
    label: string;
    desc: string;
    premium: boolean;
  }> = [
    {
      key: "webGrounding",
      label: "Web Grounding",
      desc: "Retrieve real-time citations and current world data.",
      premium: true,
    },
    {
      key: "liveSearch",
      label: "Live Search",
      desc: "Search the live web while you chat.",
      premium: true,
    },
    {
      key: "visualArtifact",
      label: "Visual Artifact",
      desc: "Render interactive UI components and SVG live.",
      premium: true,
    },
    {
      key: "preview",
      label: "Preview",
      desc: "Live preview of generated code and documents.",
      premium: true,
    },
    {
      key: "deepResearch",
      label: "Deep Research Agent",
      desc: "Autonomous multi-source deep investigations and synthesis.",
      premium: false,
    },
    {
      key: "multimodal",
      label: "Multimodal File Understanding",
      desc: "Inspect images, PDFs, code repositories, and datasets.",
      premium: false,
    },
    {
      key: "voiceMode",
      label: "Interactive Live Voice",
      desc: "Low-latency conversational voice engine.",
      premium: false,
    },
  ];

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Tools">
      <div className="space-y-3">
        <p className="text-xs text-[var(--muted-foreground)]">
          Enable or disable modular intelligence layers in Neribo.
        </p>
        <div className="divide-y divide-[var(--border)]/80 rounded-2xl bg-[var(--muted)] border border-[var(--border)] overflow-hidden">
          {caps.map((c) => {
            const locked = c.premium && !isPremium;
            return (
              <div
                key={c.key}
                className={`flex items-center justify-between p-3.5 ${
                  locked ? "cursor-pointer hover:bg-[var(--elevated)]/40" : ""
                }`}
                onClick={locked ? onRequirePremium : undefined}
                role={locked ? "button" : undefined}
              >
                <div className="pr-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-medium text-[var(--popover-foreground)]">{c.label}</span>
                    {c.premium && (
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300 text-[10px] font-semibold uppercase tracking-wide">
                        <Sparkles className="h-2.5 w-2.5" />
                        Premium
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--muted-foreground)]">{c.desc}</div>
                </div>
                {locked ? (
                  <Lock className="h-4 w-4 text-[var(--muted-foreground)] shrink-0" />
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(c.key);
                    }}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                      settings.capabilities[c.key] ? "bg-blue-600" : "bg-[var(--elevated)]"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ${
                        settings.capabilities[c.key] ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {!isPremium && (
          <p className="text-[11px] text-[var(--muted-foreground)]">
            Locked capabilities require Neribo Pro. Tap one to see upgrade options.
          </p>
        )}
      </div>
    </ModalWrapper>
  );
};

// 3. Connectors Modal — demo connectors removed (item 3). No fake
// integrations: just an honest "Coming Soon" state.
export const ConnectorsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Integration">
      <div className="flex flex-col items-center justify-center text-center py-10 px-4 space-y-3">
        <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-[var(--muted)] border border-[var(--border)]">
          <Clock3 className="h-6 w-6 text-[var(--muted-foreground)]" />
        </div>
        <h3 className="text-base font-semibold text-[var(--popover-foreground)]">Coming Soon</h3>
        <p className="text-sm text-[var(--muted-foreground)] max-w-xs">
          Connectors for tools like Drive, GitHub, and Slack are on the way. Nothing to
          set up here yet.
        </p>
      </div>
    </ModalWrapper>
  );
};

// 4. Color Mode Modal
export const ColorModeModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentMode: string;
  onSelect: (mode: "Dark" | "Midnight" | "Light" | "System") => void;
}> = ({ isOpen, onClose, currentMode, onSelect }) => {
  const modes: Array<"Dark" | "Midnight" | "Light" | "System"> = [
    "Dark",
    "Midnight",
    "Light",
    "System",
  ];
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Color Mode">
      <div className="space-y-2">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => {
              onSelect(m);
              onClose();
            }}
            className={`w-full flex items-center justify-between p-3.5 rounded-xl border text-sm font-medium transition-colors ${
              currentMode === m
                ? "bg-[var(--elevated)] border-blue-500 text-[var(--popover-foreground)]"
                : "bg-[var(--muted)] border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--elevated)]/60"
            }`}
          >
            <span>{m}</span>
            {currentMode === m && <Check className="h-4 w-4 text-blue-400" />}
          </button>
        ))}
      </div>
    </ModalWrapper>
  );
};

// 5. Font Style Modal (unchanged — not part of this request)
export const FontStyleModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentStyle: string;
  onSelect: (style: "Default" | "Sans Modern" | "Monospace" | "Editorial") => void;
}> = ({ isOpen, onClose, currentStyle, onSelect }) => {
  const fonts: Array<"Default" | "Sans Modern" | "Monospace" | "Editorial"> = [
    "Default",
    "Sans Modern",
    "Monospace",
    "Editorial",
  ];
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Font Style">
      <div className="space-y-2">
        {fonts.map((f) => (
          <button
            key={f}
            onClick={() => {
              onSelect(f);
              onClose();
            }}
            className={`w-full flex items-center justify-between p-3.5 rounded-xl border text-sm font-medium transition-colors ${
              currentStyle === f
                ? "bg-[var(--elevated)] border-blue-500 text-[var(--popover-foreground)]"
                : "bg-[var(--muted)] border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--elevated)]/60"
            }`}
          >
            <span>{f}</span>
            {currentStyle === f && <Check className="h-4 w-4 text-blue-400" />}
          </button>
        ))}
      </div>
    </ModalWrapper>
  );
};

// 5b. Font Size Modal (item 12) — real, visible effect via the
// `--ui-zoom` variable applied to the app shell (see index.css / App.tsx).
export const FontSizeModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentSize: "Small" | "Default" | "Large";
  onSelect: (size: "Small" | "Default" | "Large") => void;
}> = ({ isOpen, onClose, currentSize, onSelect }) => {
  const sizes: Array<{ key: "Small" | "Default" | "Large"; sample: string }> = [
    { key: "Small", sample: "text-xs" },
    { key: "Default", sample: "text-sm" },
    { key: "Large", sample: "text-base" },
  ];
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Font Size">
      <div className="space-y-2">
        {sizes.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              onSelect(s.key);
              onClose();
            }}
            className={`w-full flex items-center justify-between p-3.5 rounded-xl border font-medium transition-colors ${
              currentSize === s.key
                ? "bg-[var(--elevated)] border-blue-500 text-[var(--popover-foreground)]"
                : "bg-[var(--muted)] border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--elevated)]/60"
            }`}
          >
            <span className={s.sample}>{s.key}</span>
            {currentSize === s.key && <Check className="h-4 w-4 text-blue-400" />}
          </button>
        ))}
      </div>
    </ModalWrapper>
  );
};

// 6. Voice Selection Modal — 3 real, distinct voices with a genuine
// preview using the browser's built-in speech synthesis (item 6). No fake
// names or pretend audio: each preview really speaks through whichever
// system voice best matches the description, picked from the voices the
// visitor's own browser/OS actually provides.
// VOICE_OPTIONS/pickVoice now live in ../lib/ttsVoice so the chat
// "read aloud" playback in ChatView.tsx uses the exact same matching
// logic — previously that logic was duplicated only here, so a voice
// picked in Settings was never actually applied when a message played.

export const VoiceModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentVoice: VoiceKey;
  onSelect: (voice: VoiceKey) => void;
}> = ({ isOpen, onClose, currentVoice, onSelect }) => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [playingKey, setPlayingKey] = useState<VoiceKey | null>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;
    return subscribeToVoices(setVoices);
  }, [supported]);

  useEffect(() => {
    if (!isOpen && supported) {
      window.speechSynthesis.cancel();
      setPlayingKey(null);
    }
  }, [isOpen, supported]);

  const handlePreview = (option: (typeof VOICE_OPTIONS)[number]) => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    if (playingKey === option.key) {
      setPlayingKey(null);
      return;
    }
    const utter = new SpeechSynthesisUtterance(
      "Hi, I'm Neribo. This is a preview of this voice."
    );
    const voice = pickVoice(voices, option);
    if (voice) utter.voice = voice;
    utter.pitch = option.pitch;
    utter.rate = option.rate;
    utter.onend = () => setPlayingKey(null);
    utter.onerror = () => setPlayingKey(null);
    setPlayingKey(option.key);
    window.speechSynthesis.speak(utter);
  };

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Voice">
      <div className="space-y-2">
        {!supported && (
          <p className="text-xs text-amber-400">
            Speech preview isn't supported in this browser, but selection still works.
          </p>
        )}
        {VOICE_OPTIONS.map((v) => (
          <div
            key={v.key}
            className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-colors ${
              currentVoice === v.key
                ? "bg-[var(--elevated)] border-blue-500"
                : "bg-[var(--muted)] border-[var(--border)]"
            }`}
          >
            <button
              onClick={() => onSelect(v.key)}
              className="flex items-center gap-3 flex-1 text-left"
            >
              <Volume2 className="h-4 w-4 text-[var(--muted-foreground)] shrink-0" />
              <div>
                <div className="text-sm font-medium text-[var(--popover-foreground)]">{v.name}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{v.desc}</div>
              </div>
            </button>
            <div className="flex items-center gap-2 pl-2">
              <button
                type="button"
                disabled={!supported}
                onClick={() => handlePreview(v)}
                className="flex items-center justify-center h-8 w-8 rounded-full bg-[var(--elevated)] text-[var(--popover-foreground)] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Play preview"
                aria-label="Play preview"
              >
                {playingKey === v.key ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </button>
              {currentVoice === v.key && <Check className="h-4 w-4 text-blue-400" />}
            </div>
          </div>
        ))}
      </div>
    </ModalWrapper>
  );
};

// 7. Interactive Live Voice Mode Modal (unchanged — separate feature from
// the Voice setting above)
export const VoiceModeModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [isListening, setIsListening] = useState(true);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between p-8 bg-[var(--bg-0)]/95 backdrop-blur-2xl animate-in fade-in duration-300">
      <div className="w-full flex items-center justify-between">
        <NeriboLogo variant="full" size="sm" />
        <button
          onClick={onClose}
          className="p-2 rounded-full bg-[var(--elevated)] text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)]"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      {/* Central Pulsing Audio Orb */}
      <div className="flex flex-col items-center justify-center space-y-8">
        <div className="relative flex items-center justify-center">
          {/* Animated pulsing wave rings */}
          <div className="absolute h-48 w-48 rounded-full bg-blue-500/10 animate-ping duration-1000" />
          <div className="absolute h-36 w-36 rounded-full bg-amber-400/20 animate-pulse" />
          <div className="relative flex items-center justify-center h-28 w-28 rounded-full bg-gradient-to-tr from-blue-600 to-amber-400 shadow-2xl">
            <Radio className="h-10 w-10 text-white animate-bounce" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h3 className="font-serif text-2xl text-[var(--popover-foreground)] font-medium">
            Neribo Voice Active
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] max-w-xs">
            Speak naturally. Neribo is listening and will respond with voice.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={() => setIsListening(!isListening)}
          className={`px-6 py-3 rounded-full font-semibold text-sm transition-all ${
            isListening
              ? "bg-rose-600 text-white hover:bg-rose-500"
              : "bg-blue-600 text-white hover:bg-blue-500"
          }`}
        >
          {isListening ? "Mute Microphone" : "Resume Speaking"}
        </button>
        <button
          onClick={onClose}
          className="px-6 py-3 rounded-full bg-[var(--elevated)] text-[var(--popover-foreground)] text-sm hover:opacity-80"
        >
          End Voice Session
        </button>
      </div>
    </div>
  );
};

// 8. About Modal
export const AboutModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const appVersion = useAppVersion();
  const modelDisplayOverrides = useModelDisplay();
  const coreModelsLabel = getDisplayModels(modelDisplayOverrides)
    .map((m) => m.name)
    .join(" • ");
  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="About Neribo">
      <div className="space-y-4 text-center">
        <NeriboLogo variant="full" size="lg" className="mx-auto" />
        <p className="font-serif text-lg text-[var(--popover-foreground)] italic">
          "The AI for problem solvers"
        </p>

        <div className="rounded-xl bg-[var(--muted)] border border-[var(--border)] p-4 text-left space-y-2 text-xs text-[var(--muted-foreground)]">
          <div className="flex justify-between py-1 border-b border-[var(--border)]">
            <span className="text-[var(--muted-foreground)]">Version</span>
            <span className="font-mono text-[var(--popover-foreground)]">{appVersion}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-[var(--border)]">
            <span className="text-[var(--muted-foreground)]">Design System</span>
            <span className="text-[var(--popover-foreground)]">Neribo Editorial Dark</span>
          </div>
          <div className="flex justify-between py-1 border-b border-[var(--border)]">
            <span className="text-[var(--muted-foreground)]">Core Models</span>
            <span className="text-[var(--popover-foreground)]">{coreModelsLabel}</span>
          </div>
          <div className="flex justify-between py-1">
            <span className="text-[var(--muted-foreground)]">Status</span>
            <span className="text-emerald-400 font-semibold">All Systems Operational</span>
          </div>
        </div>

        <p className="text-[12px] text-[var(--muted-foreground)] leading-relaxed">
          Neribo combines state-of-the-art computational reasoning with a clean,
          distraction-free interface built for focused execution.
        </p>
      </div>
    </ModalWrapper>
  );
};

// 9. Profile Modal (item 11) — Name/Nickname sourced from the real
// authenticated account, never hardcoded/demo text. Nickname is editable
// and saved to the account's Firestore profile doc.
export const ProfileModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserAccount;
  onSaveNickname: (nickname: string) => void;
}> = ({ isOpen, onClose, currentUser, onSaveNickname }) => {
  const [nicknameInput, setNicknameInput] = useState(currentUser.nickname || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setNicknameInput(currentUser.nickname || "");
      setSaved(false);
    }
  }, [isOpen, currentUser.nickname]);

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Profile">
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3.5 rounded-xl bg-[var(--muted)] border border-[var(--border)]">
          {currentUser.avatarType === "image" && currentUser.avatarValue ? (
            <img
              src={currentUser.avatarValue}
              alt={currentUser.name}
              className="h-11 w-11 rounded-full object-cover shrink-0"
            />
          ) : (
            <div
              className="flex items-center justify-center h-11 w-11 rounded-full text-[var(--popover-foreground)] font-bold shrink-0"
              style={{ backgroundColor: currentUser.bgColor || "#475569" }}
            >
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--popover-foreground)] truncate">{currentUser.name}</div>
            <div className="text-xs text-[var(--muted-foreground)] truncate">{currentUser.email}</div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--muted-foreground)]">Full name</label>
          <div className="w-full py-3 px-4 rounded-xl bg-[var(--muted)] border border-[var(--border)] text-[var(--popover-foreground)] text-sm">
            {currentUser.name}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--muted-foreground)]">What should we call you?</label>
          <input
            type="text"
            value={nicknameInput}
            onChange={(e) => {
              setNicknameInput(e.target.value);
              setSaved(false);
            }}
            placeholder="Nickname"
            maxLength={40}
            className="w-full py-3 px-4 rounded-xl bg-[var(--muted)] border border-[var(--border)] text-[var(--popover-foreground)] text-sm placeholder-[var(--placeholder)] focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <button
          onClick={() => {
            onSaveNickname(nicknameInput.trim());
            setSaved(true);
          }}
          className="w-full py-3 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-sm hover:opacity-90 active:scale-[0.98] transition-all"
        >
          {saved ? "Saved" : "Save nickname"}
        </button>
      </div>
    </ModalWrapper>
  );
};

// 10. Permissions Modal (item 4) — only permissions the app can genuinely
// back: Notification API for Notifications, and the existing file-attach
// flow for Files and Images. Nothing fake.
export const PermissionsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  permissions: AppSettings["permissions"];
  onUpdatePermissions: (
    updater: (prev: AppSettings["permissions"]) => AppSettings["permissions"]
  ) => void;
}> = ({ isOpen, onClose, permissions, onUpdatePermissions }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notificationsSupported = typeof window !== "undefined" && "Notification" in window;

  // Keep the stored value honest: the browser is the source of truth for
  // Notification permission, so sync it in whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    const real = notificationsSupported ? Notification.permission : "unsupported";
    if (real !== permissions.notifications) {
      onUpdatePermissions((prev) => ({ ...prev, notifications: real as any }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleRequestNotifications = async () => {
    if (!notificationsSupported) return;
    const result = await Notification.requestPermission();
    onUpdatePermissions((prev) => ({ ...prev, notifications: result }));
  };

  const handleFilePicked: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onUpdatePermissions((prev) => ({ ...prev, filesAndImages: true }));
    }
    e.target.value = "";
  };

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Permissions">
      <div className="space-y-3">
        {/* Files and Images */}
        <div className="p-3.5 rounded-2xl bg-[var(--muted)] border border-[var(--border)] space-y-2.5">
          <div className="flex items-start gap-3">
            <Paperclip className="h-4.5 w-4.5 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-[var(--popover-foreground)]">Files and Images</div>
              <p className="text-xs text-[var(--muted-foreground)]">
                Your browser grants file access the moment you attach something in
                chat — there's no separate permission to switch on. Use the button
                below to confirm it works on this device.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between pl-7">
            <span
              className={`text-xs font-medium ${
                permissions.filesAndImages ? "text-emerald-400" : "text-[var(--muted-foreground)]"
              }`}
            >
              {permissions.filesAndImages ? "Verified on this device" : "Not verified yet"}
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 rounded-full bg-[var(--elevated)] text-[var(--popover-foreground)] text-xs font-semibold hover:opacity-80 transition-colors"
            >
              Test file access
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.txt,.md,.csv,.json"
              className="hidden"
              onChange={handleFilePicked}
            />
          </div>
        </div>

        {/* Notifications */}
        <div className="p-3.5 rounded-2xl bg-[var(--muted)] border border-[var(--border)] space-y-2.5">
          <div className="flex items-start gap-3">
            <Bell className="h-4.5 w-4.5 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-[var(--popover-foreground)]">Notifications</div>
              <p className="text-xs text-[var(--muted-foreground)]">
                Let Neribo notify you when a response finishes in the background.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between pl-7">
            {!notificationsSupported ? (
              <span className="text-xs text-[var(--muted-foreground)]">Not supported in this browser</span>
            ) : permissions.notifications === "granted" ? (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Granted
              </span>
            ) : permissions.notifications === "denied" ? (
              <span className="text-xs text-rose-400">
                Blocked — enable it from your browser's site settings
              </span>
            ) : (
              <span className="text-xs text-[var(--muted-foreground)]">Not granted</span>
            )}
            {notificationsSupported && permissions.notifications !== "granted" && permissions.notifications !== "denied" && (
              <button
                onClick={handleRequestNotifications}
                className="px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 transition-colors"
              >
                Enable
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
};

// 11. Sharing Modal (item 8) — fallback for browsers without the native
// Web Share sheet (App.tsx tries navigator.share first and only opens this
// when that isn't available).
export const SharingModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  shareUrl: string;
}> = ({ isOpen, onClose, shareUrl }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) setCopied(false);
  }, [isOpen]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} title="Share Neribo">
      <div className="space-y-4">
        <div className="flex items-center justify-center">
          <div className="flex items-center justify-center h-12 w-12 rounded-2xl bg-blue-600/15">
            <Share2 className="h-5 w-5 text-blue-400" />
          </div>
        </div>
        <p className="text-sm text-[var(--muted-foreground)] text-center">
          Share this link with anyone you want to invite to Neribo.
        </p>
        <div className="flex items-center gap-2 p-2 rounded-xl bg-[var(--muted)] border border-[var(--border)]">
          <span className="flex-1 text-xs text-[var(--muted-foreground)] truncate px-2">{shareUrl}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--elevated)] text-[var(--popover-foreground)] text-xs font-semibold hover:opacity-80 transition-colors shrink-0"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
};

// 12. Logout Confirmation Modal (item 14)
export const LogoutConfirmModal: React.FC<{
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ isOpen, onCancel, onConfirm }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="w-full max-w-sm bg-[var(--popover)] border border-[var(--border)] rounded-3xl p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
        <div className="space-y-1.5">
          <h2 className="text-xl font-bold text-[var(--popover-foreground)]">Log out</h2>
          <p className="text-[15px] text-[var(--muted-foreground)]">
            Are you sure you want to log out?
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-full border border-[var(--border)] text-[var(--popover-foreground)] font-semibold text-sm hover:bg-[var(--elevated)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 rounded-full bg-rose-600 text-white font-semibold text-sm hover:bg-rose-500 transition-colors"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
};
