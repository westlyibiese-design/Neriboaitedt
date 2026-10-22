import React, { useCallback, useEffect, useState } from "react";
import {
  Smartphone,
  Sun,
  Moon,
  Monitor,
  Bell,
  BellOff,
  KeyRound,
  ShieldCheck,
  Loader2,
  Trash2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { AppSettings, RegisteredDevice } from "../../types";
import { useDeviceLock } from "../../contexts/DeviceLockContext";
import {
  defaultDeviceLabel,
  disableDevicePin,
  getOrCreateDeviceId,
  listMyDevices,
  setDevicePin,
} from "../../lib/deviceLock";

interface DeviceSettingsPanelProps {
  settings: AppSettings;
  onUpdateSettings: (updater: (prev: AppSettings) => AppSettings) => void;
}

/**
 * Neribo Operations "Settings" page — everything specific to THIS
 * Supervisor's device/browser: Appearance, Notifications, and Device PIN.
 * Visual structure and section set are modeled on the Westly HMS
 * reference's DeviceSettingsPage (see the attached video), adapted to
 * Neribo's own components, theme tokens, and settings storage:
 *
 *  - Appearance reuses AppSettings.colorMode, the exact same
 *    localStorage-persisted state App.tsx already drives <html
 *    data-theme> from — offering only the three values the video shows
 *    (Light/Dark/System); "Midnight" stays available in the regular
 *    account Settings page and is untouched by this page.
 *  - Notifications reuses AppSettings.permissions.notifications, the
 *    same browser Notification-permission state src/components/
 *    SettingsModals.tsx's PermissionsModal already tracks.
 *  - Device PIN and Registered devices are new: functions/api/device/*.js
 *    on the backend, src/lib/deviceLock.ts + src/contexts/
 *    DeviceLockContext.tsx on the client.
 *
 * Only ever mounted by OperationsView once useIsOperations() has
 * confirmed Supervisor access — same gating every other Operations page
 * relies on.
 */
export const DeviceSettingsPanel: React.FC<DeviceSettingsPanelProps> = ({ settings, onUpdateSettings }) => {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-[var(--fg-0)] flex items-center gap-2">
            <Smartphone className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--fg-1)]" />
            Device Settings
          </h1>
          <p className="text-sm text-[var(--fg-1)] mt-1">
            Settings specific to this device and browser — these don't affect your account on other devices.
          </p>
        </div>

        <AppearanceCard settings={settings} onUpdateSettings={onUpdateSettings} />
        <NotificationsCard settings={settings} onUpdateSettings={onUpdateSettings} />
        <DevicePinCard />
        <RegisteredDevicesCard />
      </div>
    </div>
  );
};

// ── Shared card shell ────────────────────────────────────────────────────
const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-2xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 sm:p-5 space-y-3">{children}</div>
);

const CardHeader: React.FC<{ icon: React.ReactNode; title: string; description: React.ReactNode }> = ({
  icon,
  title,
  description,
}) => (
  <div>
    <h3 className="text-sm font-semibold text-[var(--fg-0)] flex items-center gap-2">
      {icon}
      {title}
    </h3>
    <p className="text-xs text-[var(--fg-1)] mt-1 leading-relaxed">{description}</p>
  </div>
);

// ── Appearance ────────────────────────────────────────────────────────────
const THEME_OPTIONS: { value: AppSettings["colorMode"]; label: string; icon: typeof Sun }[] = [
  { value: "Light", label: "Light", icon: Sun },
  { value: "Dark", label: "Dark", icon: Moon },
  { value: "System", label: "System Default", icon: Monitor },
];

const AppearanceCard: React.FC<DeviceSettingsPanelProps> = ({ settings, onUpdateSettings }) => (
  <Card>
    <CardHeader
      icon={<Sun className="h-4 w-4 text-[var(--fg-1)]" />}
      title="Theme"
      description={
        <>Choose how the admin panel looks on this device. "System Default" follows your device's light/dark setting automatically.</>
      }
    />
    <div className="grid grid-cols-3 gap-2">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const isActive = settings.colorMode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onUpdateSettings((prev) => ({ ...prev, colorMode: value }))}
            className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm transition-colors ${
              isActive
                ? "border-[var(--fg-0)] bg-[var(--bg-3)] text-[var(--fg-0)]"
                : "border-[var(--border-1)] text-[var(--fg-0)] hover:bg-[var(--bg-3)]"
            }`}
          >
            <Icon className="w-5 h-5" />
            {label}
          </button>
        );
      })}
    </div>
  </Card>
);

// ── Notifications ─────────────────────────────────────────────────────────
const NotificationsCard: React.FC<DeviceSettingsPanelProps> = ({ settings, onUpdateSettings }) => {
  const notificationsSupported = typeof window !== "undefined" && "Notification" in window;
  const enabled = settings.permissions.notifications === "granted";

  // Keep the stored value honest — the browser is the source of truth.
  useEffect(() => {
    const real = notificationsSupported ? Notification.permission : "unsupported";
    if (real !== settings.permissions.notifications) {
      onUpdateSettings((prev) => ({ ...prev, permissions: { ...prev.permissions, notifications: real as any } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = async () => {
    if (!notificationsSupported || enabled) return; // browser APIs can request, never programmatically revoke
    const result = await Notification.requestPermission();
    onUpdateSettings((prev) => ({ ...prev, permissions: { ...prev.permissions, notifications: result as any } }));
  };

  return (
    <Card>
      <CardHeader
        icon={enabled ? <Bell className="h-4 w-4 text-[var(--fg-1)]" /> : <BellOff className="h-4 w-4 text-[var(--fg-1)]" />}
        title="Notifications"
        description="Push notifications for this device. Turning this off stops delivery to this device specifically — other devices you're signed in on are unaffected."
      />
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--fg-0)]">
            {settings.permissions.notifications === "denied"
              ? "Blocked by browser"
              : enabled
              ? "On"
              : "Off"}
          </p>
          <p className="text-xs text-[var(--fg-1)]">
            {settings.permissions.notifications === "denied"
              ? "Enable notifications for this site in your browser settings to turn this on."
              : "In-app and Telegram alerts are unaffected — this only controls push notifications to this device."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!notificationsSupported || settings.permissions.notifications === "denied"}
          onClick={() => void handleToggle()}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
            enabled ? "bg-[var(--fg-0)]" : "bg-[var(--bg-4)] border border-[var(--border-1)]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full shadow transition-transform ${
              enabled ? "bg-[var(--bg-0)]" : "bg-white"
            } ${
              enabled ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
    </Card>
  );
};

// ── Device PIN ────────────────────────────────────────────────────────────
const DevicePinCard: React.FC = () => {
  const { enabled: pinEnabledHere, refresh } = useDeviceLock();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleSave = async () => {
    setResult(null);
    if (pin !== confirmPin) {
      setResult({ ok: false, message: "PINs don't match." });
      return;
    }
    setSaving(true);
    try {
      await setDevicePin(pin, defaultDeviceLabel());
      setPin("");
      setConfirmPin("");
      setResult({
        ok: true,
        message: "Device PIN saved. This device will now lock automatically after 5 minutes away, and ask for this PIN to continue.",
      });
      refresh();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Couldn't save the PIN." });
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setResult(null);
    setDisabling(true);
    try {
      await disableDevicePin(getOrCreateDeviceId());
      setResult({ ok: true, message: "Device PIN removed. This device will no longer lock automatically." });
      refresh();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Couldn't remove the PIN." });
    } finally {
      setDisabling(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="h-4 w-4 text-[var(--fg-1)]" />}
        title="Device PIN"
        description={
          <span className="flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            6–10 digits. Once set, this device locks itself automatically after 5 minutes of inactivity or being away, and asks for this PIN — not your password — to continue.
          </span>
        }
      />

      {pinEnabledHere && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/20 border border-emerald-900/50 rounded-lg px-3 py-2">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          PIN protection is enabled on this device.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <input
          type="password"
          inputMode="numeric"
          placeholder="New PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
          className="rounded-xl bg-[var(--bg-4)] border border-[var(--border-1)] px-3 py-2.5 text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-1)] focus:outline-none focus:ring-1 focus:ring-[var(--fg-1)]"
        />
        <input
          type="password"
          inputMode="numeric"
          placeholder="Confirm PIN"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
          className="rounded-xl bg-[var(--bg-4)] border border-[var(--border-1)] px-3 py-2.5 text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-1)] focus:outline-none focus:ring-1 focus:ring-[var(--fg-1)]"
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={saving || pin.length < 6 || confirmPin.length < 6}
          className="px-4 py-2.5 rounded-xl bg-[var(--fg-0)] text-[var(--bg-0)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
          {saving ? "Saving…" : pinEnabledHere ? "Change PIN" : "Save PIN"}
        </button>
        {pinEnabledHere && (
          <button
            onClick={() => void handleDisable()}
            disabled={disabling}
            className="px-4 py-2.5 rounded-xl border border-[var(--border-1)] text-rose-400 text-sm font-semibold hover:bg-rose-950/20 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {disabling && <Loader2 className="w-4 h-4 animate-spin" />}
            Disable PIN
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
          {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
          <span>{result.message}</span>
        </div>
      )}
    </Card>
  );
};

// ── Registered devices ────────────────────────────────────────────────────
const RegisteredDevicesCard: React.FC = () => {
  const { refresh: refreshLockStatus } = useDeviceLock();
  const [devices, setDevices] = useState<RegisteredDevice[] | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const thisDeviceId = getOrCreateDeviceId();

  const loadDevices = useCallback(async () => {
    try {
      setLoadError(null);
      setDevices(await listMyDevices());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load your registered devices.");
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const handleRemove = async (deviceId: string) => {
    setRemovingId(deviceId);
    try {
      await disableDevicePin(deviceId);
      await loadDevices();
      refreshLockStatus();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't remove that device.");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={<Smartphone className="h-4 w-4 text-[var(--fg-1)]" />}
        title="Registered devices"
        description="Remove a device you no longer use or trust — this ends its automatic lock/unlock immediately."
      />

      {devices === null ? (
        <div className="py-6 text-center text-sm text-[var(--fg-1)] flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : loadError && devices.length === 0 ? (
        <p className="text-sm text-rose-400 py-4 text-center">{loadError}</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-[var(--fg-1)] py-4 text-center">No devices registered yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border-1)]">
          {devices.map((d) => (
            <li key={d.deviceId} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--fg-0)] truncate">{d.deviceLabel}</span>
                  {d.deviceId === thisDeviceId && (
                    <span className="text-[10px] rounded-full border border-[var(--border-1)] px-1.5 py-0.5 text-[var(--fg-1)]">
                      This device
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5 text-xs text-[var(--fg-1)]">
                  {d.hasPin ? (
                    <span className="flex items-center gap-1">
                      <KeyRound className="w-3 h-3" /> PIN configured
                    </span>
                  ) : (
                    <span>Not configured</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                disabled={removingId === d.deviceId}
                onClick={() => void handleRemove(d.deviceId)}
                className="flex items-center gap-1.5 text-xs text-[var(--fg-1)] hover:text-rose-400 shrink-0 px-2 py-1.5 rounded-lg disabled:opacity-50"
              >
                {removingId === d.deviceId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
