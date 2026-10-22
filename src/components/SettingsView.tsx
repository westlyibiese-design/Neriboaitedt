import React, { useEffect, useState } from "react";
import {
  User,
  CircleDollarSign,
  SlidersHorizontal,
  Paperclip,
  Bot,
  Moon,
  Type,
  Ruler,
  AudioWaveform,
  Bell,
  Shield,
  Share2,
  LogOut,
  ChevronRight,
  Info,
  Check,
  Zap,
} from "lucide-react";
import { useAppVersion } from "../hooks/useAppVersion";
import { AppSettings, UserAccount } from "../types";
import { UsageSnapshot } from "../lib/usage";
import { LogoutConfirmModal } from "./SettingsModals";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { initPush, disablePush } from "../lib/push";
import { useToast } from "./Toast";

interface SettingsViewProps {
  settings: AppSettings;
  onUpdateSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  currentUser: UserAccount;
  // Live plan/renewal data (see src/lib/usage.ts) — the account card
  // below reads this, never `currentUser.plan` alone, so it can show a
  // real renewal date and never render the Free upsell copy for an
  // already-paying account.
  usage: UsageSnapshot | null;
  onOpenUpgrade: () => void;
  onOpenProfile: () => void;
  onOpenBilling: () => void;
  onOpenCapabilities: () => void;
  onOpenConnectors: () => void;
  onOpenPermissions: () => void;
  onOpenColorMode: () => void;
  onOpenFontStyle: () => void;
  onOpenFontSize: () => void;
  onOpenVoice: () => void;
  onOpenPrivacy: () => void;
  onOpenSharing: () => void;
  onOpenAbout: () => void;
  onLogout: () => void;
}

const VOICE_LABELS: Record<AppSettings["voice"], string> = {
  "bold-male": "Bold Male",
  "calm-female": "Calm Female",
  nigerian: "Nigerian English",
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdateSettings,
  currentUser,
  usage,
  onOpenUpgrade,
  onOpenProfile,
  onOpenBilling,
  onOpenCapabilities,
  onOpenConnectors,
  onOpenPermissions,
  onOpenColorMode,
  onOpenFontStyle,
  onOpenFontSize,
  onOpenVoice,
  onOpenPrivacy,
  onOpenSharing,
  onOpenAbout,
  onLogout,
}) => {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const appVersion = useAppVersion();
  const { showToast } = useToast();
  const uid = currentUser.id;

  // Push notifications (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §1/§4):
  // this row is the User-facing equivalent of System Console's own
  // NotificationsSection.tsx toggle — same field
  // (`pushNotificationsEnabled` on this account's own `users/{uid}` doc),
  // same merge-write persistence pattern. `settings.notifications` itself
  // stays local-storage-backed like every other AppSettings field (see
  // App.tsx's loadStoredSettings), but is kept in sync with the real,
  // server-checked preference the moment it's known — never trusted on
  // its own for whether a push actually goes out (that's §4's job,
  // enforced server-side in functions/_shared/pushSender.js).
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const raw = snap.data()?.pushNotificationsEnabled;
        const enabled = typeof raw === "boolean" ? raw : true;
        onUpdateSettings((prev) => (prev.notifications === enabled ? prev : { ...prev, notifications: enabled }));
      })
      .catch((err) => {
        // Non-critical — the toggle just keeps whatever it last had
        // locally for this session. Logged internally only.
        console.error("[Neribo:settings] failed to load push preference:", err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const handleToggleNotifications = async () => {
    const next = !settings.notifications;
    const previous = settings.notifications;
    onUpdateSettings((prev) => ({ ...prev, notifications: next })); // reflect immediately

    try {
      await setDoc(doc(db, "users", uid), { pushNotificationsEnabled: next }, { merge: true });
    } catch (err) {
      onUpdateSettings((prev) => ({ ...prev, notifications: previous })); // roll back — it didn't actually save
      console.error("[Neribo:settings] failed to save push preference:", err);
      showToast("Couldn't save that. Please try again.", "error");
      return;
    }

    // Additive to the Firestore write above, never blocking it — both
    // initPush and disablePush already never throw (see src/lib/push.ts).
    if (next) {
      void initPush(uid);
    } else {
      void disablePush(uid);
    }
  };

  // Plan comes from the live usage doc (see src/lib/usage.ts), never
  // currentUser.plan alone — this is the one place that decides whether
  // the account card below shows the Free upsell or the Pro renewal
  // info, and the two must never render together.
  const isPro = usage?.plan === "pro";

  // Short "Paid: Sep 17" / "Expires: Sep 24" format. Both dates come
  // straight from the live usage doc — `paidAt` is the exact timestamp
  // the Paystack webhook recorded for the last successful charge,
  // `resetAt` is the exact instant that paid period elapses (see
  // functions/_shared/quota.js's computePeriod, which now anchors a
  // weekly period to the real payment instant rather than flooring it to
  // the calendar week — see that file for the full explanation). Neither
  // is ever computed/guessed here; if either is missing (e.g. a pro
  // account whose usage doc hasn't been touched by the webhook fix yet)
  // this simply doesn't render rather than showing a fabricated date.
  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const paidLabel = isPro && usage?.paidAt ? shortDate(usage.paidAt) : null;
  const expiresLabel = isPro && usage?.resetAt ? shortDate(usage.resetAt) : null;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 max-w-2xl w-full mx-auto pb-24 space-y-3">
      {/* Account Card matching Screenshot 3 */}
      <div className="rounded-2xl bg-[var(--card)] border border-[var(--border)]/80 p-4 shadow-sm space-y-4">
        {/* Email & Plan Badge */}
        <div className="flex items-center justify-between">
          <div className="text-[15.5px] font-medium text-[var(--fg-0)] truncate pr-2">
            {currentUser.email}
          </div>
          <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-xs tracking-wide shadow-sm">
            {isPro ? "Pro" : "Free"}
          </span>
        </div>

        {isPro ? (
          /* Active-subscription sub-card — Pro accounts only. No upgrade
             CTA and no upsell copy here; that pricing/upsell card is
             reserved for Free accounts below, and the two never share a
             screen. Tapping "Subscription" in the list below opens the
             full SubscriptionModal for the same renewal info. */
          <div className="rounded-xl bg-[var(--elevated)] border border-emerald-500/30 p-4 flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <h3 className="text-base font-semibold text-[var(--fg-0)] tracking-tight">
                Neribo Pro
              </h3>
              <p className="text-sm text-[var(--muted-foreground)]">
                {paidLabel && expiresLabel ? (
                  <>
                    Paid: {paidLabel}
                    <br />
                    Expires: {expiresLabel}
                  </>
                ) : (
                  "Subscription details will appear here shortly."
                )}
              </p>
            </div>
            <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold text-xs border border-emerald-500/30">
              Active
            </span>
          </div>
        ) : (
          /* Upgrade Banner sub-card — Free accounts only. */
          <div className="rounded-xl bg-[var(--elevated)] border border-[var(--border)]/60 p-4 flex flex-col items-start gap-3">
            <div className="space-y-0.5">
              <h3 className="text-base font-semibold text-[var(--fg-0)] tracking-tight">
                Go further with Neribo Pro
              </h3>
              <p className="text-sm text-[var(--muted-foreground)]">
                Upgrade for more usage and capabilities.
              </p>
            </div>
            <button
              onClick={onOpenUpgrade}
              className="px-5 py-2 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-xs hover:opacity-90 active:scale-95 transition-all shadow-sm flex items-center gap-1.5"
            >
              <Zap className="h-3.5 w-3.5 fill-[var(--primary-foreground)]" />
              <span>Upgrade</span>
            </button>
          </div>
        )}
      </div>

      {/* Grouped Settings Items (Exact layout and items from Screenshot 3) */}
      <div className="rounded-2xl bg-[var(--card)] border border-[var(--border)]/80 divide-y divide-[var(--border)]/60 shadow-sm overflow-hidden">
        {/* Profile */}
        <button
          onClick={onOpenProfile}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <User className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Profile</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Billing */}
        <button
          onClick={onOpenBilling}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <CircleDollarSign className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Subscription</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Capabilities */}
        <button
          onClick={onOpenCapabilities}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <SlidersHorizontal className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <div>
              <div className="text-[15px] font-normal text-[var(--fg-0)] leading-tight">
                Tools
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                {settings.capabilitiesCount} enabled
              </div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Connectors */}
        <button
          onClick={onOpenConnectors}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Paperclip className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Integration</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Permissions */}
        <button
          onClick={onOpenPermissions}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Bot className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Permissions</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Color mode */}
        <button
          onClick={onOpenColorMode}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Moon className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <div>
              <div className="text-[15px] font-normal text-[var(--fg-0)] leading-tight">
                Color mode
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">{settings.colorMode}</div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Font style */}
        <button
          onClick={onOpenFontStyle}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Type className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <div>
              <div className="text-[15px] font-normal text-[var(--fg-0)] leading-tight">
                Font style
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">{settings.fontStyle}</div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Font size */}
        <button
          onClick={onOpenFontSize}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Ruler className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <div>
              <div className="text-[15px] font-normal text-[var(--fg-0)] leading-tight">
                Font size
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">{settings.fontSize}</div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Voice */}
        <button
          onClick={onOpenVoice}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <AudioWaveform className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <div>
              <div className="text-[15px] font-normal text-[var(--fg-0)] leading-tight">
                Voice
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">{VOICE_LABELS[settings.voice]}</div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Notifications */}
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3.5">
            <Bell className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">
              Notifications
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleToggleNotifications()}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              settings.notifications ? "bg-blue-600" : "bg-[var(--border)]"
            }`}
            role="switch"
            aria-checked={settings.notifications}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                settings.notifications ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Privacy */}
        <button
          onClick={onOpenPrivacy}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Shield className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Privacy</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Sharing */}
        <button
          onClick={onOpenSharing}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--elevated)]/60 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <Share2 className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span className="text-[15px] font-normal text-[var(--fg-0)]">Sharing</span>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
        </button>

        {/* Log out — now asks for confirmation before signing out (item 14) */}
        <button
          onClick={() => setShowLogoutConfirm(true)}
          className="w-full flex items-center gap-3.5 p-4 hover:bg-[var(--destructive)]/10 transition-colors text-left group"
        >
          <LogOut className="h-5 w-5 text-rose-500 stroke-[1.8]" />
          <span className="text-[15px] font-medium text-rose-500">Log out</span>
        </button>
      </div>

      {/* About Neribo Footer link */}
      <div className="pt-2 text-center">
        <button
          onClick={onOpenAbout}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--card-foreground)] transition-colors"
        >
          Neribo {appVersion} • System Status • Legal
        </button>
      </div>

      <LogoutConfirmModal
        isOpen={showLogoutConfirm}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={() => {
          setShowLogoutConfirm(false);
          onLogout();
        }}
      />
    </div>
  );
};
