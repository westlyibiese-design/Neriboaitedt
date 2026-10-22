import React, { useState, useEffect, useRef } from "react";
import {
  DEFAULT_SETTINGS,
} from "./data/mockData";
import {
  UserAccount,
  ChatThread,
  ChatMessage,
  Order,
  ChatNeriboMessage,
  DomainRequest,
  ShowcaseItem,
  AppSettings,
  ActiveNav,
  OperationsSection,
} from "./types";
import {
  DEFAULT_MODEL_ID,
  WEB_SEARCH_MODEL_ID,
  SEARCH_PRO_MODEL_ID,
  ART_PRO_MODEL_ID,
  isProModel,
  isImageGenerationModel,
  isSearchModel,
  getDisplayModels,
} from "./lib/models";
import { useModelDisplay } from "./hooks/useModelDisplay";
import { isImageGenerationIntent, isSearchIntent } from "./lib/intentDetection";
import { Header } from "./components/Header";
import { SidebarDrawer } from "./components/SidebarDrawer";
import { OperationsSidebar } from "./components/OperationsSidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { AuthScreen } from "./components/AuthScreen";
import { NeriboLogoAnimated } from "./components/NeriboLogoAnimated";
import {
  UpgradeModal,
  SubscriptionModal,
  CapabilitiesModal,
  ConnectorsModal,
  ColorModeModal,
  FontStyleModal,
  FontSizeModal,
  VoiceModal,
  VoiceModeModal,
  AboutModal,
  ProfileModal,
  PermissionsModal,
  SharingModal,
  ModalWrapper,
} from "./components/SettingsModals";
import { OrdersView, LiveView, ShowcaseView } from "./components/Workspaces";
import { ChatNeriboView } from "./components/ChatNeriboView";
import { DomainsView } from "./components/DomainsView";
import { OperationsView } from "./components/OperationsView";
import { NotificationCenterPanel } from "./components/NotificationCenterPanel";
import { useIsOperations } from "./hooks/useIsOperations";
import { sendChatMessage, generateImage, searchWeb, storeGeneratedImage, storeChatImage, NeriboApiError } from "./lib/neriboApi";
import { startProUpgrade, cancelSubscription, PaymentsApiError } from "./lib/paymentsApi";
import { stampNeriboWatermark } from "./lib/watermark";
import { useUsage, isQuotaExhausted } from "./lib/usage";
import { useImageUsage, formatImageLimitBubble } from "./lib/imageUsage";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User as FirebaseUser,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { auth, db } from "./lib/firebase";
import { loadThreads, saveThread, deleteThreadDoc, archiveClearedMessages, nowTimestamp } from "./lib/chatPersistence";
import { loadActiveShowcaseItems, loadAllShowcaseItems } from "./lib/showcasePersistence";
import { subscribeToOrders } from "./lib/ordersPersistence";
import { subscribeToDomainRequests } from "./lib/domainRequestsPersistence";
import { subscribeToChatNeriboMessages } from "./lib/chatNeriboPersistence";
import { useChatNeriboEnabled } from "./hooks/useChatNeriboEnabled";
import { useDomainsEnabled } from "./hooks/useDomainsEnabled";
import { toSafeMessage } from "./lib/errorHandling";
import { recordLoginFailure } from "./lib/authFailureLog";
import { recordSignIn } from "./lib/activityMonitor";
import { startUsageSession, endUsageSession, trackScreenView, trackInteraction } from "./lib/usageAnalytics";
import { useToast } from "./components/Toast";
import { DeviceLockProvider, clearDeviceLockActivity } from "./contexts/DeviceLockContext";
import { DeviceLockOverlay } from "./components/DeviceLockScreen";
import { initPush, initForegroundPush } from "./lib/push";

const SETTINGS_STORAGE_KEY = "neribo:settings";

// Which top-level area / Operations page was showing, persisted per-tab so
// a refresh lands the person back exactly where they were instead of
// bouncing to Chat (or, for a Supervisor, to the Operations dashboard).
// sessionStorage (not localStorage) is deliberate — same reasoning as
// DeviceLockContext's activity marker: scoped to this one tab's session,
// never leaking a route across a browser restart or a different tab, and
// cleared on explicit logout below so it can never leak from one signed-in
// account to the next in a shared tab either.
const ACTIVE_NAV_STORAGE_KEY = "neribo:activeNav";
const OPERATIONS_SECTION_STORAGE_KEY = "neribo:operationsSection";

const VALID_ACTIVE_NAVS: ActiveNav[] = [
  "chat",
  "orders",
  "live",
  "showcase",
  "chatNeribo",
  "domains",
  "settings",
  "operations",
];

const VALID_OPERATIONS_SECTIONS: OperationsSection[] = [
  "dashboard",
  "users",
  "conversations",
  "feedback",
  "events",
  "actions",
  "appSettings",
  "aiModel",
  "systemConsole",
  "deviceSettings",
  "deleted",
  "showcaseManagement",
  "ordersManagement",
  "chatNeribo",
  "domainsManagement",
];

function loadStoredActiveNav(): ActiveNav {
  try {
    const raw = sessionStorage.getItem(ACTIVE_NAV_STORAGE_KEY);
    if (raw && (VALID_ACTIVE_NAVS as string[]).includes(raw)) return raw as ActiveNav;
  } catch {
    // sessionStorage unavailable (private mode, etc.) — fall through to the
    // same default a first-ever visit gets.
  }
  return "chat";
}

function loadStoredOperationsSection(): OperationsSection {
  try {
    const raw = sessionStorage.getItem(OPERATIONS_SECTION_STORAGE_KEY);
    if (raw && (VALID_OPERATIONS_SECTIONS as string[]).includes(raw)) return raw as OperationsSection;
  } catch {
    // Same private-mode fallback as loadStoredActiveNav above.
  }
  return "dashboard";
}

// Exact time (ms) NeriboLogoAnimated's one-time intro takes to finish —
// ring draw-on -> triangles lock in -> wordmark rise -> the first shine
// sweep sliding fully across the mark. Derived from that component's own
// keyframe timings (see src/components/NeriboLogoAnimated.tsx): the shine
// sweep starts at a 2.55s delay and covers its full slide distance over
// the first 26% of its 3.4s cycle, so the mark is fully "loaded" — not a
// second early or late — at 2.55 + 0.26 * 3.4 = 3.434s. Kept as a single
// constant so the two boot-animation gates below can never drift out of
// sync with each other or with the animation itself.
const NERIBO_INTRO_MS = 3434;

function loadStoredSettings(): Partial<AppSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export default function App() {
  const { showToast } = useToast();

  // Authentication & Profile State
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string>("");

  // Boot animation gate: the Neribo logo intro (NeriboLogoAnimated) must
  // always play out in full — NERIBO_INTRO_MS, matching the animation's
  // own timing exactly — before anything else in the app is allowed to
  // show, no matter how fast Firebase/Firestore resolve below.
  // Initialized to "already satisfied" when the browser reports no
  // network connection at all (navigator.onLine === false), since there's
  // nothing worth holding the splash for in that case; the
  // authLoading/chatsLoading/operationsLoading gates further down still
  // apply exactly as before once this resolves.
  const [bootAnimDone, setBootAnimDone] = useState<boolean>(
    () => typeof navigator !== "undefined" && "onLine" in navigator ? !navigator.onLine : false
  );
  useEffect(() => {
    if (bootAnimDone) return;
    const timer = setTimeout(() => setBootAnimDone(true), NERIBO_INTRO_MS);
    return () => clearTimeout(timer);
    // Runs once on mount only — this is a fixed splash timer matching the
    // animation's own duration, not something that should reset if
    // unrelated state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Real nickname for the Profile section (item 11), loaded from Firestore
  // per signed-in account — never hardcoded/demo text.
  const [nickname, setNickname] = useState<string>("");
  // System Console Activity Monitor (Phase 5): the uid the last
  // recordSignIn() call fired for, so a fresh sign-in is recorded
  // exactly once — not once per re-render, not once per StrictMode
  // double-invoke of this effect, not once per token-refresh-driven
  // callback. Reset to null on sign-out so a later sign-in (same or
  // different account) is recorded again as its own new session. A
  // ref, not state, since it's write-only bookkeeping that should
  // never itself trigger a render.
  const recordedSignInUidRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthLoading(false);
      // Best-effort session write — see src/lib/activityMonitor.ts for
      // why this is a client-side write and why it can never affect
      // sign-in itself (fire-and-forget, swallows its own errors).
      // Never fired for regular (non-Operations) users any
      // differently than for Supervisors — this call site doesn't
      // know or care which the signed-in account is.
      if (user && recordedSignInUidRef.current !== user.uid) {
        recordedSignInUidRef.current = user.uid;
        recordSignIn({ uid: user.uid, email: user.email });
        // System Console Usage Analytics (Phase 6): same fresh-sign-in
        // dedupe as recordSignIn above — one usage session started per
        // fresh sign-in, never per re-render.
        startUsageSession(user.uid);
        // Push notifications (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md
        // §3.2): register this device for push once per fresh sign-in.
        // Works identically for a regular User or a Supervisor account —
        // both are just users/{uid} documents (see src/lib/push.ts) — and
        // initPush itself gates on the account's pushNotificationsEnabled
        // preference and the browser's own Notification permission, so
        // nothing further needs checking here. Never throws.
        void initPush(user.uid);
      } else if (!user) {
        recordedSignInUidRef.current = null;
        // Best-effort session close-out — see src/lib/usageAnalytics.ts;
        // never blocks or delays sign-out itself.
        endUsageSession();
      }
    });
    return unsubscribe;
  }, []);

  // Settings must never be reachable before login — there is no
  // signed-out preview path anymore.
  const isAuthenticated = !!firebaseUser;

  // Post-login boot animation gate: distinct from bootAnimDone above,
  // which only covers the very first page load. This one replays the
  // NeriboLogoAnimated intro for its full NERIBO_INTRO_MS after someone
  // actually completes a sign-in/sign-up on the Auth screen — not when
  // the app loads and finds an already-active session (that's
  // bootAnimDone's job) — so the main chat UI never appears sooner than
  // the animation's own completion time after credentials are submitted,
  // on any connection speed, whenever online.
  const authBaselineSetRef = useRef(false);
  const [postLoginAnimDone, setPostLoginAnimDone] = useState(true);
  useEffect(() => {
    if (authLoading) return; // wait until we know the real signed-in status
    if (!authBaselineSetRef.current) {
      // First resolution this mount (already-signed-in-on-load, or
      // landed on the Auth screen) — not a fresh login action.
      authBaselineSetRef.current = true;
      return;
    }
    if (!isAuthenticated) return; // a sign-out; nothing to gate
    const online = typeof navigator === "undefined" || !("onLine" in navigator) || navigator.onLine;
    if (!online) return; // no connection: don't hold up the app for it
    setPostLoginAnimDone(false);
    const timer = setTimeout(() => setPostLoginAnimDone(true), NERIBO_INTRO_MS);
    return () => clearTimeout(timer);
  }, [isAuthenticated, authLoading]);

  // Live, server-computed usage quota for the signed-in account (read-only
  // — see src/lib/usage.ts and firestore.rules). Used only for display and
  // as a client-side UX shortcut to avoid firing a request that the
  // backend already knows it will reject; the backend's own quota
  // transaction remains the actual authority either way.
  const usage = useUsage(firebaseUser?.uid);

  // Live, server-computed image-generation quota (Neribo.art) for the
  // signed-in account — completely separate from `usage` above (read-
  // only, see src/lib/imageUsage.ts and firestore.rules). Same "display
  // + client-side shortcut only" caveat: the backend's own image-quota
  // transaction (functions/_shared/imageQuota.js) remains the actual
  // authority either way.
  const imageUsage = useImageUsage(firebaseUser?.uid);

  // Whether the signed-in account carries the `operations` custom claim
  // (see src/hooks/useIsOperations.ts) — gates the sidebar's "Operations"
  // entry and the Operations Users page itself. The real enforcement is
  // server-side (every admin endpoint re-checks this claim from the
  // verified ID token); this is only what decides whether the nav item
  // and page render at all.
  const { isOperations, loading: operationsLoading } = useIsOperations();

  // Live Supervisor-edited model name/tag/desc (App Settings → Models),
  // merged onto the static NERIBO_MODELS list — see
  // src/lib/models.ts's getDisplayModels(). Used anywhere this file
  // builds user-facing text that names a model (the Chat↔Art redirect
  // messages below); routing/Pro-gating never reads this, only `.name`.
  const modelDisplayOverrides = useModelDisplay();
  const displayModels = getDisplayModels(modelDisplayOverrides);

  // Chat cloud-sync state (Firestore)
  const [chatsLoading, setChatsLoading] = useState(false);
  const lastCloudSync = useRef<Record<string, string>>({}); // threadId -> last updatedAt written
  const cloudPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedUidRef = useRef<string | null>(null); // which uid `threads` currently reflects

  // Navigation & View State
  // Restored from sessionStorage (see loadStoredActiveNav above) so a page
  // refresh keeps the person on the exact screen they were viewing instead
  // of always reopening on Chat. Read once at mount via the lazy-init form
  // of useState — the persistence effect further down keeps this in sync
  // with sessionStorage on every subsequent change.
  const [activeNav, setActiveNav] = useState<ActiveNav>(loadStoredActiveNav);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Which Operations page is showing, independent of activeNav (which
  // only tracks the top-level app area). Only ever read/set while
  // activeNav === "operations"; harmless to leave at its last value
  // otherwise. Restored from sessionStorage the same way activeNav is,
  // so a Supervisor's refresh keeps them on the exact Operations page
  // they were on rather than always bouncing to the dashboard.
  const [operationsSection, setOperationsSection] = useState<OperationsSection>(loadStoredOperationsSection);

  // Keep sessionStorage in sync so the next refresh in this tab restores
  // exactly here. Two separate effects (rather than one) so a change to
  // either value persists independently, matching how the two are set
  // independently everywhere else in this file.
  useEffect(() => {
    try {
      sessionStorage.setItem(ACTIVE_NAV_STORAGE_KEY, activeNav);
    } catch {
      // Best-effort only — same as every other localStorage/sessionStorage
      // write in this file (see SETTINGS_STORAGE_KEY usage below).
    }
  }, [activeNav]);

  useEffect(() => {
    try {
      sessionStorage.setItem(OPERATIONS_SECTION_STORAGE_KEY, operationsSection);
    } catch {
      // Best-effort only.
    }
  }, [operationsSection]);

  // The moment the role check resolves a Supervisor account, force it onto
  // Operations — regardless of whatever activeNav was before (including
  // right after sign-in, or a stale/invalid value restored above for an
  // account that wasn't a Supervisor the last time this tab set it). Runs
  // again on every isOperations/operationsLoading change, so there's no
  // window where a stale value could stick. (activeNav's own restored
  // value already covers the normal "Supervisor refreshes and should stay
  // on Operations" case, since it's set back to "operations" below before
  // this effect would ever see a mismatch.)
  useEffect(() => {
    if (!operationsLoading && isOperations && activeNav !== "operations") {
      setActiveNav("operations");
    }
  }, [isOperations, operationsLoading, activeNav]);

  // Mirror safety net: if this tab's stored activeNav is "operations" but
  // the signed-in account turns out NOT to be a Supervisor (role revoked,
  // or a regular account signed into a tab a Supervisor previously used),
  // never strand them on a page they can't see — send them back to Chat.
  useEffect(() => {
    if (!operationsLoading && !isOperations && activeNav === "operations") {
      setActiveNav("chat");
    }
  }, [isOperations, operationsLoading, activeNav]);

  // System Console Usage Analytics (Phase 6): one screen_view queued
  // per actual nav change, for whichever account is signed in — mirrors
  // the redirect effect above in also depending on activeNav, but this
  // one only ever queues an in-memory event (see
  // src/lib/usageAnalytics.ts), never anything that could itself cause
  // a further nav change. No-ops silently until a usage session exists.
  useEffect(() => {
    if (!isAuthenticated) return;
    trackScreenView(activeNav);
  }, [activeNav, isAuthenticated]);

  // Single choke point for every nav change in the app: once resolved as a
  // Supervisor account, nothing — no sidebar button, no header shortcut, no
  // future call site anyone forgets to check individually — can move
  // activeNav away from "operations". Pass this (not the raw setActiveNav)
  // to every child that can trigger a nav change.
  const setActiveNavGuarded = (next: ActiveNav) => {
    if (isOperations && next !== "operations") return;
    setActiveNav(next);
  };

  // Push notification click routing (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md
  // §1/§3.1): public/firebase-messaging-sw.js's notificationclick handler
  // either postMessages an already-open tab, or opens a brand-new one at
  // `?nav=...` when nothing was open — these two effects cover both
  // cases. Both wait for operationsLoading to resolve before navigating,
  // since routing a Supervisor account to "chatNeribo" (or a regular
  // account to "operations") would immediately get reverted by the
  // redirect effects above; this only ever routes to a destination this
  // account is actually allowed to land on.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== "neribo-notification-click") return;
      const url = typeof event.data.url === "string" ? event.data.url : "";
      if (operationsLoading) return; // best-effort — a click during the loading window is rare and not worth queuing
      if (url.includes("nav=chatNeribo")) {
        if (!isOperations) setActiveNavGuarded("chatNeribo");
      } else if (url.includes("nav=operationsSystemConsole")) {
        if (isOperations) {
          setOperationsSection("systemConsole");
          setActiveNavGuarded("operations");
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOperations, operationsLoading]);

  // Same routing, for the "app was fully closed" case: the service
  // worker opened a brand-new tab at `?nav=...` instead of postMessage-ing
  // one that was already open. Runs once auth + role resolve, then
  // cleans the query param off the URL so a later manual reload doesn't
  // re-trigger it.
  useEffect(() => {
    if (authLoading || operationsLoading) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const nav = params.get("nav");
    if (!nav) return;
    if (nav === "chatNeribo" && !isOperations) {
      setActiveNavGuarded("chatNeribo");
    } else if (nav === "operationsSystemConsole" && isOperations) {
      setOperationsSection("systemConsole");
      setActiveNavGuarded("operations");
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, operationsLoading, isOperations]);

  // Foreground push messages (§3.3): registered once, early — never
  // re-subscribed on every nav/role change, since onChatNeriboScreen below
  // is checked live at delivery time via these refs, not captured once.
  const activeNavRef = useRef(activeNav);
  useEffect(() => {
    activeNavRef.current = activeNav;
  }, [activeNav]);
  const isOperationsRef = useRef(isOperations);
  useEffect(() => {
    isOperationsRef.current = isOperations;
  }, [isOperations]);
  useEffect(() => {
    void initForegroundPush(
      () => activeNavRef.current === "chatNeribo" && !isOperationsRef.current,
      showToast
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Threads & Content State
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("thread-greeting");
  // Orders (formerly "Projects") — Phase 4 of the Showcase/Orders build.
  // The signed-in account's own `orders` documents, LIVE from Firestore
  // (src/lib/ordersPersistence.ts's subscribeToOrders), so a payment the
  // Paystack webhook confirms updates the UI without a refresh. null = not
  // loaded yet. Regular accounts only: a Supervisor account never sees the
  // regular Orders page (it manages every user's orders from Operations ->
  // Orders Management instead, which runs its own query).
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [ordersLoadError, setOrdersLoadError] = useState("");

  // Showcase items (formerly "Artifacts") — Phase 1 of the Showcase/Orders
  // build. Unlike the old artifacts, these are NEVER created from chat
  // replies (see handleSendMessage) and ARE persisted, in the top-level
  // Firestore `showcaseItems` collection (src/lib/showcasePersistence.ts).
  // null = not loaded yet. What's in here depends on who's signed in:
  //   - regular account: only ACTIVE items (firestore.rules refuses any
  //     other query from a non-Supervisor), fetched when Showcase or Live
  //     is opened;
  //   - Supervisor account: every item, active or not, fetched when
  //     Operations -> Showcase Management is opened, and kept current by
  //     handleShowcaseItemSaved after each edit.
  const [showcaseItems, setShowcaseItems] = useState<ShowcaseItem[] | null>(null);
  const [showcaseLoadError, setShowcaseLoadError] = useState("");

  // Strict account isolation, same as the chat threads: never carry one
  // account's Showcase list (which for a Supervisor includes inactive
  // items) over to the next account that signs in.
  useEffect(() => {
    setShowcaseItems(null);
    setShowcaseLoadError("");
    setOrders(null);
    setOrdersLoadError("");
  }, [firebaseUser?.uid]);

  // Which Showcase data the current screen actually needs — so a user who
  // never opens Showcase/Live never pays for the read, and each visit
  // re-fetches (stale-while-revalidate: the previous list stays visible
  // until the fresh one lands).
  // Orders needs the active items too: they carry the prices shown on its
  // "Get raw code" / "Get custom URL" buttons.
  const needsShowcaseData = isOperations
    ? activeNav === "operations" && operationsSection === "showcaseManagement"
    : activeNav === "showcase" || activeNav === "live" || activeNav === "orders";

  useEffect(() => {
    // Wait for the role check: which loader to call depends on it.
    if (!firebaseUser || operationsLoading || !needsShowcaseData) return;
    let cancelled = false;
    const uid = firebaseUser.uid;
    setShowcaseLoadError("");
    (isOperations ? loadAllShowcaseItems() : loadActiveShowcaseItems())
      .then((items) => {
        if (cancelled || auth.currentUser?.uid !== uid) return;
        setShowcaseItems(items);
      })
      .catch((err) => {
        if (cancelled) return;
        setShowcaseLoadError(toSafeMessage(err, "firestore", "load-showcase"));
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser, isOperations, operationsLoading, needsShowcaseData]);

  // Live subscription to this account's orders, only while a screen that
  // shows them is open (Orders, or Showcase — whose "Add to Orders" button
  // needs to know what's already added), same "don't pay for a read the
  // user never needs" rule as the Showcase load above. Regular accounts
  // only: firestore.rules only lets an account read its OWN orders, and a
  // Supervisor account never renders either screen.
  // Phase 8 (Domains) — the sitewide "Domains enabled" switch, read early
  // (ahead of needsOrdersData just below) because a widened orders read
  // depends on it: eligibility — does this account have a `type: "url"`
  // order at "in_progress"/"delivered"? — must be computable for the
  // sidebar nav item BEFORE the user ever opens Orders/Showcase, the same
  // "always listen so the sidebar can decide" reasoning as
  // chatNeriboEnabled/chatNeriboUnread further below.
  const domainsSwitch = useDomainsEnabled();
  const domainsEnabled = domainsSwitch.enabled && !domainsSwitch.loading;

  const needsOrdersData = activeNav === "orders" || activeNav === "showcase" || activeNav === "domains" || domainsEnabled;

  useEffect(() => {
    if (!firebaseUser || operationsLoading || isOperations || !needsOrdersData) return;
    const uid = firebaseUser.uid;
    setOrdersLoadError("");
    const unsubscribe = subscribeToOrders(
      uid,
      (next) => {
        if (auth.currentUser?.uid !== uid) return; // account switched mid-flight
        setOrders(next);
        setOrdersLoadError("");
      },
      (err) => {
        setOrdersLoadError(toSafeMessage(err, "firestore", "load-orders"));
      }
    );
    return unsubscribe;
  }, [firebaseUser, isOperations, operationsLoading, needsOrdersData]);

  // Chat Neribo (Phase 7) — one-way messages from the Supervisor to this
  // account, LIVE from Firestore (src/lib/chatNeriboPersistence.ts's
  // subscribeToChatNeriboMessages, the same onSnapshot approach as the
  // orders listener above), so a message sent while the app is open appears
  // without a refresh. null = not loaded yet. Regular accounts only: a
  // Supervisor account never sees Chat Neribo (it sends from Operations ->
  // Chat Neribo instead, which runs its own query).
  //
  // Unlike orders, this listens whenever the feature is on (not only while
  // the page is open) so the sidebar can show an unread badge — the
  // "you'll be notified" promise Phase 6's confirmation text makes. It is a
  // single per-uid query. While the sitewide "Chat Neribo enabled" switch is
  // off (or still loading) the nav item is hidden and nothing is listened to.
  const chatNeriboSwitch = useChatNeriboEnabled();
  const chatNeriboEnabled = chatNeriboSwitch.enabled && !chatNeriboSwitch.loading;
  const [chatNeriboMessages, setChatNeriboMessages] = useState<ChatNeriboMessage[] | null>(null);
  const [chatNeriboLoadError, setChatNeriboLoadError] = useState("");

  // Strict account isolation: never carry one account's messages over to
  // the next account that signs in.
  useEffect(() => {
    setChatNeriboMessages(null);
    setChatNeriboLoadError("");
  }, [firebaseUser?.uid]);

  useEffect(() => {
    if (!firebaseUser || operationsLoading || isOperations || !chatNeriboEnabled) return;
    const uid = firebaseUser.uid;
    setChatNeriboLoadError("");
    const unsubscribe = subscribeToChatNeriboMessages(
      uid,
      (next) => {
        if (auth.currentUser?.uid !== uid) return; // account switched mid-flight
        setChatNeriboMessages(next);
        setChatNeriboLoadError("");
      },
      (err) => {
        setChatNeriboLoadError(toSafeMessage(err, "firestore", "load-chat-neribo"));
      }
    );
    return unsubscribe;
  }, [firebaseUser, isOperations, operationsLoading, chatNeriboEnabled]);

  const chatNeriboUnread = chatNeriboMessages
    ? chatNeriboMessages.filter((message) => !message.acknowledged).length
    : 0;

  // Phase 8 (Domains) — eligibility for the sidebar nav item: does this
  // account have a `type: "url"` order at "in_progress"/"delivered"?
  // (domainsEnabled/domainsSwitch declared earlier, alongside
  // needsOrdersData, which its value widens.)
  const domainsEligible = (orders ?? []).some(
    (order) => order.type === "url" && (order.status === "in_progress" || order.status === "delivered")
  );

  // Live subscription to this account's own domain requests, only while
  // Domains is open — same "don't pay for a read the user never needs"
  // rule as the orders listener above. Unlike chatNeriboMessages, there's
  // no sidebar badge to keep live for, so this stays page-gated rather
  // than sitewide.
  const [domainRequests, setDomainRequests] = useState<DomainRequest[] | null>(null);
  const [domainRequestsLoadError, setDomainRequestsLoadError] = useState("");

  useEffect(() => {
    setDomainRequests(null);
    setDomainRequestsLoadError("");
  }, [firebaseUser?.uid]);

  useEffect(() => {
    if (!firebaseUser || operationsLoading || isOperations || activeNav !== "domains") return;
    const uid = firebaseUser.uid;
    setDomainRequestsLoadError("");
    const unsubscribe = subscribeToDomainRequests(
      uid,
      (next) => {
        if (auth.currentUser?.uid !== uid) return; // account switched mid-flight
        setDomainRequests(next);
        setDomainRequestsLoadError("");
      },
      (err) => {
        setDomainRequestsLoadError(toSafeMessage(err, "firestore", "load-domain-requests"));
      }
    );
    return unsubscribe;
  }, [firebaseUser, isOperations, operationsLoading, activeNav]);

  // Paystack sends the browser back to `/?orders=complete` after a
  // Showcase payment (see functions/api/payments/initialize.js). Land the
  // person on Orders — whose live listener shows the result — and tidy the
  // URL so a refresh doesn't repeat this. Runs once the account (and its
  // Supervisor check) has resolved; a Supervisor is left where they are.
  useEffect(() => {
    if (!firebaseUser || operationsLoading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("orders") !== "complete") return;
    params.delete("orders");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
    if (!isOperations) setActiveNav("orders");
  }, [firebaseUser, isOperations, operationsLoading]);

  // Same as above, for a Domain payment (Phase 8): Paystack sends the
  // browser back to `/?domains=complete` (see
  // functions/api/payments/initialize.js's callback URL logic). Lands the
  // person on Domains, whose live listener shows the result.
  useEffect(() => {
    if (!firebaseUser || operationsLoading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("domains") !== "complete") return;
    params.delete("domains");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
    if (!isOperations) setActiveNav("domains");
  }, [firebaseUser, isOperations, operationsLoading]);

  // Called by the Supervisor's Showcase Management panel after each
  // successful add/edit/toggle so this list stays current without a refetch.
  const handleShowcaseItemSaved = (saved: ShowcaseItem) => {
    setShowcaseItems((prev) => {
      const list = prev ?? [];
      return list.some((item) => item.id === saved.id)
        ? list.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...list];
    });
  };
  // Color Mode / Font Size (and other prefs) persist across reloads.
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadStoredSettings(),
  }));
  const [isLoading, setIsLoading] = useState(false);
  // The assistant reply currently being streamed in, rendered live while it
  // grows. Deliberately kept out of `threads` (and thus out of the
  // Firestore-sync effect below) until the stream finishes — a chunk lands
  // every few dozen milliseconds, and every `threads` mutation debounces a
  // cloud write, so streaming straight into `threads` would mean constant
  // churn on that effect and a wave of Firestore writes per message. Only
  // the finished message ever gets committed to `threads`.
  const [streamingMessage, setStreamingMessage] = useState<{
    id: string;
    content: string;
    model?: string;
  } | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const streamingBufferRef = useRef<string>("");
  // Chunks can arrive several times per animation frame; coalescing the
  // resulting setState calls to once per frame keeps re-renders (and thus
  // markdown re-parsing) to a smooth ~60/sec ceiling instead of one per
  // chunk, however small.
  const streamRafRef = useRef<number | null>(null);

  // Real backend activity state (added) — see src/lib/neriboApi.ts's
  // onSearchState and functions/api/llm/chat/completions.js's activity
  // stream. Null whenever no search is actually in flight for the
  // current send; set to the real query the instant the backend starts
  // one, cleared the instant that search finishes — never a client-side
  // guess or a fixed timer, and never shown for a request that never
  // triggers search server-side (see isSearchIntent there).
  const [searchActivity, setSearchActivity] = useState<{ query: string } | null>(null);
  // True only for the literal span an image-generation request is in
  // flight (see the Neribo.art image branches of handleSendMessage
  // and handleRegenerate below) — distinct from
  // `isLoading`, which also covers the plain text-chat path, so ChatView
  // can tell the two activity states apart and render the right one.
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  // Persist settings whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable (private browsing, quota, etc.) — settings still
      // work for this session, they just won't survive a reload.
    }
  }, [settings]);

  // Color Mode: apply the resolved theme to <html data-theme> so the CSS
  // variables in index.css actually take effect (item 5). "System" follows
  // the OS/browser preference and updates live if it changes.
  useEffect(() => {
    const root = document.documentElement;
    const applyResolved = () => {
      const resolved =
        settings.colorMode === "System"
          ? window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : settings.colorMode.toLowerCase();
      root.setAttribute("data-theme", resolved);
    };
    applyResolved();
    if (settings.colorMode !== "System") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    mql.addEventListener("change", applyResolved);
    return () => mql.removeEventListener("change", applyResolved);
  }, [settings.colorMode]);

  // Font Size: real, visible effect on the whole app shell (item 12).
  useEffect(() => {
    document.documentElement.setAttribute("data-font-size", settings.fontSize);
  }, [settings.fontSize]);

  // Load this account's real nickname from Firestore (item 11) — never
  // hardcoded/demo text. Cleared on sign-out.
  useEffect(() => {
    if (!firebaseUser) {
      setNickname("");
      return;
    }
    let cancelled = false;
    getDoc(doc(db, "users", firebaseUser.uid))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.data();
        setNickname(typeof data?.nickname === "string" ? data.nickname : "");
      })
      .catch((err) => {
        // Non-critical — nickname just stays blank for this session. Logged
        // internally only; nothing worth interrupting the user for.
        toSafeMessage(err, "firestore", "load-nickname");
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser]);

  const handleUpdateNickname = async (newNickname: string) => {
    if (!firebaseUser) return;
    const previous = nickname;
    setNickname(newNickname); // reflect immediately
    try {
      await setDoc(doc(db, "users", firebaseUser.uid), { nickname: newNickname }, { merge: true });
    } catch (err) {
      setNickname(previous); // roll back the optimistic update — it didn't actually save
      showToast(toSafeMessage(err, "firestore", "save-nickname"), "error");
    }
  };

  // Pull chat history on sign-in, clear on sign-out — strict account
  // isolation: always clear local threads before loading the next
  // account's data so one account's chats are never visible while the
  // next account's data is still loading.
  useEffect(() => {
    let cancelled = false;

    async function loadForUser() {
      setThreads([]);
      lastCloudSync.current = {};
      syncedUidRef.current = null;

      if (!firebaseUser) {
        // Signed out (or guest/preview mode): nothing to load from Firestore.
        // Seed exactly one empty local thread so the UI always has something
        // to render, matching the app's existing "new chat" shape. This is
        // never written to Firestore since there is no signed-in uid.
        const seedId = `thread-${Date.now()}`;
        const seedNow = nowTimestamp();
        setThreads([{
          id: seedId, title: "New chat", model: DEFAULT_MODEL_ID,
          createdAt: seedNow, updatedAt: seedNow, messages: [],
        }]);
        setActiveThreadId(seedId);
        return;
      }

      setChatsLoading(true);
      try {
        const loaded = await loadThreads(firebaseUser.uid);
        if (cancelled || auth.currentUser?.uid !== firebaseUser.uid) return; // switched again mid-fetch

        loaded.forEach((t) => {
          lastCloudSync.current[t.id] = t.updatedAt;
        });

        // Always land on a clean, unsaved "New chat" right after sign-in —
        // never auto-open whichever previous conversation happened to load
        // first (that was `loaded[0].id`, i.e. Firestore's arbitrary
        // document order, not even "most recent"). This is the same
        // local-only shape handleNewChat() already creates on a manual
        // "New Chat" click: it's never written to Firestore until the user
        // actually sends a message (pushChangedThreads skips a never-synced,
        // empty thread), so this never creates an empty doc, never touches
        // an existing conversation, and never introduces a second "new
        // chat" mechanism. The user's real history is still fully loaded
        // into `threads` (and thus Chat History) below — this only changes
        // which thread starts out *active*.
        const seedId = `thread-${Date.now()}`;
        const seedNow = nowTimestamp();
        const seedThread: ChatThread = {
          id: seedId, title: "New chat", model: DEFAULT_MODEL_ID,
          createdAt: seedNow, updatedAt: seedNow, messages: [],
        };

        setThreads([seedThread, ...loaded]);
        setActiveThreadId(seedId);
        syncedUidRef.current = firebaseUser.uid;
      } catch (err) {
        // Real failure, not a fake fallback: show an empty state rather than
        // inventing conversation history, but let the user know why.
        showToast(toSafeMessage(err, "firestore", "load-chats"), "error");
      } finally {
        if (!cancelled) setChatsLoading(false);
      }
    }

    loadForUser();
    return () => { cancelled = true; };
  }, [firebaseUser]);

  // Push local chat changes to Firestore (covers every mutation point —
  // handleNewChat, handleDeleteThread, handleSendMessage, handleRegenerate,
  // and any future one — automatically, without editing each call site).
  // This is a "dirty tracking" effect, not the Firestore access itself —
  // see src/lib/chatPersistence.ts for the actual reads/writes/retries.
  useEffect(() => {
    // Don't push until this array actually reflects a completed load for the
    // current signed-in user (avoids overwriting cloud data with an empty
    // local array during sign-in, or pushing the guest seed thread anywhere).
    if (!firebaseUser || syncedUidRef.current !== firebaseUser.uid) return;

    if (cloudPushTimer.current) clearTimeout(cloudPushTimer.current);
    cloudPushTimer.current = setTimeout(() => {
      pushChangedThreads(firebaseUser.uid, threads);
    }, 300);

    return () => {
      if (cloudPushTimer.current) clearTimeout(cloudPushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, firebaseUser]);

  async function pushChangedThreads(uid: string, currentThreads: ChatThread[]) {
    const liveIds = new Set(currentThreads.map((t) => t.id));

    // Each thread is saved independently so one failing/retrying write
    // never blocks or delays the others. A thread whose save ultimately
    // fails (after chatPersistence's own retries) is logged here and left
    // dirty in `lastCloudSync` — the in-memory `threads` state the UI
    // renders from is untouched, so nothing the user sees is lost, and
    // the next edit to that thread (or any future mutation that touches
    // it) will naturally include the unsaved content and try again, since
    // every save writes the thread's full current messages array.
    await Promise.all(
      currentThreads.map(async (t) => {
        if (lastCloudSync.current[t.id] === t.updatedAt) return; // unchanged
        if (t.messages.length === 0 && !(t.id in lastCloudSync.current)) {
          // Never-synced thread with no messages yet — e.g. the local-only
          // thread created by "New Chat" (or the initial per-account seed
          // thread) that the user hasn't sent anything in. Don't create a
          // Firestore doc for it. Once a real message lands, `updatedAt`
          // changes again and this same effect saves it on its next run.
          return;
        }
        try {
          await saveThread(uid, t);
          lastCloudSync.current[t.id] = t.updatedAt;
        } catch (err) {
          // Background sync — never blocks the UI or loses what the user
          // typed (see the comment above this function). Logged internally
          // only; the next edit to this thread naturally retries the save.
          toSafeMessage(err, "firestore", `save-thread-${t.id}`);
        }
      })
    );

    await Promise.all(
      Object.keys(lastCloudSync.current)
        .filter((id) => !liveIds.has(id))
        .map(async (id) => {
          try {
            await deleteThreadDoc(uid, id);
            delete lastCloudSync.current[id];
          } catch (err) {
            toSafeMessage(err, "firestore", `delete-thread-${id}`);
          }
        })
    );
  }

  // Modals State
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  // Shown instead of showUpgradeModal when the account is already Pro —
  // see onOpenBilling below, which decides which of the two to open.
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [showCapabilitiesModal, setShowCapabilitiesModal] = useState(false);
  const [showConnectorsModal, setShowConnectorsModal] = useState(false);
  const [showColorModeModal, setShowColorModeModal] = useState(false);
  const [showFontStyleModal, setShowFontStyleModal] = useState(false);
  const [showFontSizeModal, setShowFontSizeModal] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [showVoiceModeModal, setShowVoiceModeModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [showSharingModal, setShowSharingModal] = useState(false);
  // NotificationCenterPanel (bell icon in Header, Operations accounts
  // only) — opened/closed the same minimal way as every other overlay
  // above.
  const [showNotificationCenter, setShowNotificationCenter] = useState(false);
  const [legalModalType, setLegalModalType] = useState<"terms" | "usage" | "privacy" | null>(null);

  // Active User object
  const currentUser: UserAccount = firebaseUser
    ? {
        id: firebaseUser.uid,
        name: firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Neribo User",
        nickname,
        email: firebaseUser.email || "",
        avatarType: firebaseUser.photoURL ? "image" : "initials",
        avatarValue:
          firebaseUser.photoURL ||
          (firebaseUser.displayName || firebaseUser.email || "N").charAt(0).toUpperCase(),
        bgColor: "#0d9488",
        // Read from the live users/{uid}/usage/current doc (see
        // src/lib/usage.ts's useUsage hook, already subscribed above as
        // `usage`) — the same doc functions/api/payments/webhook.js
        // writes `plan: "pro"` to once Paystack confirms payment. Never
        // hardcoded, and never trust anything else for this: this is the
        // one place the account's real plan is read from.
        plan: usage?.plan === "pro" ? "Pro" : "Free",
      }
    : { id: "guest", name: "Guest", email: "", avatarType: "initials", avatarValue: "G", bgColor: "#475569", plan: "Free" };

  // Whether the current user is on a paid plan — derived from the same
  // real Firestore-backed `currentUser.plan` above (see its comment).
  // Kept as one shared value so every Pro-gated surface (capabilities,
  // the model picker) reads the same definition instead of re-deriving it.
  const isPremium = (currentUser.plan || "Free") !== "Free";

  // Active Thread object
  const activeThread =
    threads.find((t) => t.id === activeThreadId) || threads[0];

  // Handler: Start New Chat
  const handleNewChat = () => {
    const newId = `thread-${Date.now()}`;
    const newNow = nowTimestamp();
    const newThread: ChatThread = {
      id: newId,
      title: "New chat",
      model: DEFAULT_MODEL_ID,
      createdAt: newNow,
      updatedAt: newNow,
      messages: [],
    };
    setThreads([newThread, ...threads]);
    setActiveThreadId(newId);
    setActiveNavGuarded("chat");
  };

  // Handler: Delete a Thread
  const handleDeleteThread = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = threads.filter((t) => t.id !== id);
    setThreads(remaining);
    if (activeThreadId === id && remaining.length > 0) {
      setActiveThreadId(remaining[0].id);
    }
  };

  // Applies the latest buffered streaming text to state at most once per
  // animation frame, so a burst of small SSE chunks collapses into a single
  // re-render instead of one per chunk.
  const flushStreamingUpdate = (streamId: string) => {
    if (streamRafRef.current != null) return;
    streamRafRef.current = requestAnimationFrame(() => {
      streamRafRef.current = null;
      setStreamingMessage((prev) =>
        prev && prev.id === streamId ? { ...prev, content: streamingBufferRef.current } : prev
      );
    });
  };

  // Canned, client-side-only replies used when a message is routed
  // between a text model and Neribo.art (see src/lib/intentDetection.ts).
  // These never touch the backend — no quota is spent and no AI provider
  // is called for a message that was never actually meant for whichever
  // model it landed on, so there's nothing here for the usage-limit or
  // provider-error paths to interact with.
  const buildArtRedirectMessage = (
    idPrefix: string,
    model: string,
    promptContent: string
  ): ChatMessage => {
    const artModels = displayModels.filter((m) => m.isImageModel);
    const artName = artModels[0]?.name ?? "Neribo.art";
    const optionNames = artName;
    const targets = artModels.map((m) => ({ modelId: m.id, label: `Open ${m.name}` }));
    return {
      id: `${idPrefix}-${Date.now()}`,
      role: "assistant",
      content: `Image generation is available in ${optionNames}. Please switch over to create your image.`,
      model,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      routeSuggestion: {
        prompt: promptContent,
        targets,
      },
    };
  };

  const buildChatRedirectMessage = (
    idPrefix: string,
    model: string,
    promptContent: string
  ): ChatMessage => {
    const textModels = displayModels.filter((m) => !m.isImageModel);
    const artModels = displayModels.filter((m) => m.isImageModel);
    const artName = artModels[0]?.name ?? "Neribo.art";
    const textNames = textModels.map((m) => m.name).join(" or ");
    return {
      id: `${idPrefix}-${Date.now()}`,
      role: "assistant",
      content: `${artName} is designed for image generation. For questions, conversations, writing, coding, and other AI tasks, please use ${textNames}.`,
      model,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      routeSuggestion: {
        prompt: promptContent,
        targets: textModels.map((m) => ({ modelId: m.id, label: `Use ${m.name}` })),
      },
    };
  };

  // Same pattern as the two builders above, for the third routing case:
  // a plain chat model (Neribo.chat / Neribo.chat.pro)
  // asked something that needs live/current web data (see
  // src/lib/intentDetection.ts's isSearchIntent). Never triggered for
  // Neribo.search itself — see the isSearchIntent call sites below,
  // which exclude it explicitly.
  const buildSearchRedirectMessage = (
    idPrefix: string,
    model: string,
    promptContent: string
  ): ChatMessage => {
    const searchModel = displayModels.find((m) => m.id === WEB_SEARCH_MODEL_ID);
    const searchName = searchModel?.name ?? "Neribo.search";
    const optionNames = searchName;
    const targets = searchModel ? [{ modelId: searchModel.id, label: `Use ${searchModel.name}` }] : [];
    return {
      id: `${idPrefix}-${Date.now()}`,
      role: "assistant",
      content: `${optionNames} can pull current, real-time information. Please switch over for one of these.`,
      model,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      routeSuggestion: {
        prompt: promptContent,
        targets,
      },
    };
  };

  // Handler: Send Message
  const handleSendMessage = async (
    content: string,
    model: string,
    attachment?: { name: string; content: string; kind: "text" | "image"; mimeType?: string }
  ) => {
    // Defense in depth: the model picker already keeps free users from
    // selecting a Pro model, but guard the send path too rather than
    // trusting that UI state alone.
    if (isProModel(model) && !isPremium) {
      setShowUpgradeModal(true);
      return;
    }

    // Client-side shortcut only — saves a round trip when we already know
    // the backend will reject it. The backend's own quota transaction is
    // what actually enforces this (see functions/_shared/quota.js); a
    // stale/missing `usage` value here never lets a request through that
    // the server wouldn't otherwise allow, it only sometimes blocks one
    // earlier. No toast here — ChatView's dedicated quota card (driven by
    // the same live `usage`) is already visible and is the single place
    // this state is communicated; the Send button is disabled alongside
    // it, so this is just a defense-in-depth no-op, not a user-facing path.
    // Neribo.search has its own separate server-side quota (see
    // functions/_shared/searchQuota.js), so the chat quota never blocks it
    // — ChatView.tsx already leaves Send enabled for it in that state.
    if (!isSearchModel(model) && isQuotaExhausted(usage)) {
      return;
    }

    // A text/code attachment is still embedded inline as a markdown code
    // block, exactly as before. An IMAGE attachment is NOT — it's never
    // decoded as text (that was the corruption bug) and never inlined as
    // raw base64 either (a chat thread is one Firestore document, and a
    // multi-MB base64 string risks that document's 1 MiB size cap); it's
    // shown via a separate `userImageUrl` field instead (see
    // src/types.ts) and sent to the AI as a proper vision image_url part
    // (see the sendChatMessage call and its imageDataUrl option below).
    const isImageAttachment = attachment?.kind === "image";
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content:
        attachment && !isImageAttachment
          ? `${content}\n\n[Attached: ${attachment.name}]\n\`\`\`\n${attachment.content}\n\`\`\``
          : content,
      // Optimistic: the raw data: URL renders instantly in ChatView, then
      // gets swapped for the persisted Supabase URL below once the
      // upload finishes (or left as-is, still perfectly renderable
      // locally, if that upload fails — see the .catch below).
      ...(isImageAttachment ? { userImageUrl: attachment!.content } : {}),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    // Update thread title if first user message
    const updatedMessages = [...(activeThread?.messages || []), userMsg];
    let threadTitle = activeThread.title;
    if (activeThread.messages.length === 0 || activeThread.title === "New chat") {
      threadTitle = content.slice(0, 28) + (content.length > 28 ? "..." : "");
    }

    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThreadId
          ? {
              ...t,
              title: threadTitle,
              model,
              messages: updatedMessages,
              updatedAt: nowTimestamp(),
            }
      : t
      )
    );

    // Same pattern Neribo.art already uses for its own generated
    // images (see the isImageGenerationModel branch below): upload to
    // Supabase Storage in the background and swap the message's image
    // field in place once a real URL comes back, rather than blocking
    // the send (or the AI request, which already has everything it
    // needs from attachment.content directly) on this upload. If it
    // fails, the message simply keeps the local data: URL — still fully
    // visible in this session, just not persisted for next time.
    if (isImageAttachment && attachment) {
      storeChatImage(attachment.content)
        .then(({ imageUrl }) => {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeThreadId
                ? {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === userMsg.id ? { ...m, userImageUrl: imageUrl } : m
                    ),
                  }
                : t
            )
          );
        })
        .catch((err) => {
          toSafeMessage(err, "ai", "store-chat-image"); // logs internally; local data: URL still renders fine
        });
    }

    setIsLoading(true);

    // Intent-based routing between the text models and Neribo.art —
    // see src/lib/intentDetection.ts. This runs before any network call,
    // so a misrouted message never reaches the backend at all: no quota
    // spent, no provider called, and neither side ever has to pretend it
    // can do something it can't.
    if (
      !isImageGenerationModel(model) &&
      isImageGenerationIntent(content)
    ) {
      const redirectMsg = buildArtRedirectMessage("msg-ai-redirect-art", model, content);
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...updatedMessages, redirectMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
      setIsLoading(false);
      return;
    }

    // Same routing idea as the Art redirect above, for a plain chat
    // model asked something that needs live web data — see
    // src/lib/intentDetection.ts's isSearchIntent. Never fires for
    // any search model (!isSearchModel(model) — Neribo.search and
    // Neribo.search.pro alike), and never overrides an image-generation
    // redirect (already returned by the block above if that matched
    // first).
    if (
      !isImageGenerationModel(model) &&
      !isSearchModel(model) &&
      isSearchIntent(content)
    ) {
      const redirectMsg = buildSearchRedirectMessage("msg-ai-redirect-search", model, content);
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...updatedMessages, redirectMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
      setIsLoading(false);
      return;
    }

    // Neribo.art generates an image instead of a text reply. This is
    // a completely different request/response shape (one JSON response,
    // no SSE streaming), so it's handled as its own branch rather than
    // forced through the streaming chat path below.
    if (isImageGenerationModel(model)) {
      if (!isImageGenerationIntent(content)) {
        const redirectMsg = buildChatRedirectMessage("msg-ai-redirect-chat", model, content);
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...updatedMessages, redirectMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
        setIsLoading(false);
        return;
      }
      setIsGeneratingImage(true);
      try {
        // Neribo.art.pro routes to the Pro-tier engine server-side (see
        // functions/api/images/generate.js's ART_PRO_MODEL_ID handling);
        // every other image model uses the default free path.
        const { dataUrl } = await generateImage(
          content,
          model === ART_PRO_MODEL_ID ? "art_pro" : undefined
        );
        const stampedDataUrl = await stampNeriboWatermark(dataUrl);
        const { imageUrl } = await storeGeneratedImage(stampedDataUrl);
        // Usage Analytics (Phase 6): counted only on a real, successful
        // generation — never on a redirect or a failed attempt — see
        // src/lib/usageAnalytics.ts. `model` here is a Neribo model id
        // only, never any part of `content`.
        trackInteraction("image_generated", model);
        const imageMsg: ChatMessage = {
          id: `msg-ai-image-${Date.now()}`,
          role: "assistant",
          content: "",
          imageUrl,
          model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...updatedMessages, imageMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } catch (err) {
        toSafeMessage(err, "ai", "generate-image");
        if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
          showToast(err.message, "error");
          setIsLoading(false);
          void signOut(auth);
          return;
        }
        // Backend rejected Neribo.art.pro for a non-Pro account. Same
        // treatment as the chat PRO_REQUIRED catch above — show the
        // upgrade modal, no error chat bubble. This path is a rare edge
        // case (stale isPremium state), since the client-side
        // isProModel(model) && !isPremium guard already prevents
        // reaching it normally.
        if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
          setShowUpgradeModal(true);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeThreadId ? { ...t, messages: updatedMessages } : t
            )
          );
          return;
        }
        const bubbleContent =
          err instanceof NeriboApiError && err.code === "AUTH_ERROR"
            ? "Your session has expired. Please sign in again."
            : err instanceof NeriboApiError && err.code === "IMAGE_LIMIT_REACHED"
            ? formatImageLimitBubble(err.limit, err.resetAt)
            : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
            ? err.message
            : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
            ? err.message
            : "I couldn't generate that image just now. Please try again.";
        const errorMsg: ChatMessage = {
          id: `msg-ai-image-error-${Date.now()}`,
          role: "assistant",
          content: bubbleContent,
          model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...updatedMessages, errorMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } finally {
        setIsLoading(false);
        setIsGeneratingImage(false);
      }
      return;
    }

    // Neribo.search returns raw web-search results instead of a text
    // reply — no AI/chat model involved at all (see
    // functions/api/search/query.js). Same "own request/response shape,
    // own branch" treatment as the image-generation branch above: one
    // JSON response, no SSE streaming, and it never reaches
    // sendChatMessage below.
    if (isSearchModel(model)) {
      try {
        setSearchActivity({ query: content });
        // Neribo.search.pro routes to its own Pro-tier endpoint (see
        // functions/api/search/query-pro.js); Neribo.search uses the
        // default free one.
        const results = await searchWeb(
          content,
          model === SEARCH_PRO_MODEL_ID ? "pro" : undefined
        );
        // Usage Analytics (Phase 6): counted only on a real, successful
        // search — never on a failed attempt — see
        // src/lib/usageAnalytics.ts. `model` here is a Neribo model id
        // only, never any part of `content`.
        trackInteraction("message_sent", model);
        const resultsMsg: ChatMessage = {
          id: `msg-ai-search-${Date.now()}`,
          role: "assistant",
          content: "",
          searchResults: results,
          model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...updatedMessages, resultsMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } catch (err) {
        // Backend rejected Neribo.search.pro for a non-Pro account (rare:
        // the picker/send-guard already prevent it, so this only happens
        // with stale isPremium state). Same treatment as the client-side
        // isProModel(model) && !isPremium guard at the top — upgrade
        // modal, no error bubble, the user's message is kept as-is.
        if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
          setShowUpgradeModal(true);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeThreadId ? { ...t, messages: updatedMessages } : t
            )
          );
          return;
        }
        toSafeMessage(err, "ai", "search-query");
        if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
          showToast(err.message, "error");
          setIsLoading(false);
          void signOut(auth);
          return;
        }
        const bubbleContent =
          err instanceof NeriboApiError && err.code === "AUTH_ERROR"
            ? "Your session has expired. Please sign in again."
            : err instanceof NeriboApiError && err.code === "SEARCH_LIMIT_REACHED"
            ? "You've reached your search limit for now. Please try again shortly."
            : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
            ? err.message
            : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
            ? err.message
            : "I couldn't complete that search just now. Please try again.";
        const errorMsg: ChatMessage = {
          id: `msg-ai-search-error-${Date.now()}`,
          role: "assistant",
          content: bubbleContent,
          model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...updatedMessages, errorMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } finally {
        setSearchActivity(null);
        setIsLoading(false);
      }
      return;
    }

    const streamId = `msg-ai-${Date.now()}`;
    streamingIdRef.current = streamId;
    streamingBufferRef.current = "";
    setStreamingMessage({ id: streamId, content: "", model });
    // Cleared at the start of every send — see the onSearchState handler
    // below, which is the only other place this is set.
    setSearchActivity(null);

    try {
      // Call Neribo's real backend (a Cloudflare Pages Function).
      // The backend already returns real SSE chunks — onChunk renders each
      // one as it lands instead of waiting for the full reply.
      const reply = await sendChatMessage(updatedMessages, {
        model,
        imageDataUrl: isImageAttachment && attachment ? attachment.content : undefined,
        onChunk: (_delta, full) => {
          // The first real answer text means the backend has moved past
          // search (if any) and started composing the reply — clear any
          // lingering search activity rather than waiting on a "done"
          // event that a very fast provider response could in principle
          // race with. setState(null) is a no-op re-render-wise once
          // it's already null, so this is safe to call on every chunk.
          setSearchActivity(null);
          streamingBufferRef.current = full;
          flushStreamingUpdate(streamId);
        },
        onSearchState: (state) => {
          setSearchActivity(state.status === "start" ? { query: state.query || "" } : null);
        },
      });
      // Usage Analytics (Phase 6): counted only once a reply has
      // actually come back — never on a failed/interrupted send — see
      // src/lib/usageAnalytics.ts. `model` is a Neribo model id only,
      // never any message content.
      trackInteraction("message_sent", model);
      const assistantMsg: ChatMessage = {
        id: streamId,
        role: "assistant",
        content: reply,
        model,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? {
                ...t,
                messages: [...updatedMessages, assistantMsg],
                updatedAt: nowTimestamp(),
              }
            : t
        )
      );

      // PHASE 1 (Showcase/Orders build): the code that used to live here —
      // it pulled the first fenced code block out of every AI reply and
      // pushed it into the "Artifacts" list as an auto-created item — was
      // removed on purpose. Showcase is now a curated portfolio that only
      // Westly populates, deliberately, through Operations -> Showcase
      // Management; nothing a chat reply contains may ever create a
      // Showcase item. Do not reintroduce any chat -> Showcase path.
    } catch (err) {
      toSafeMessage(err, "ai", "send-message"); // logs internally; message below is the safe, user-facing one
      // Honest error message — no canned "analysis" reply pretending the
      // request succeeded. If part of the reply had already streamed in
      // before the connection dropped, keep it rather than discarding it.
      const partial =
        streamingIdRef.current === streamId ? streamingBufferRef.current.trim() : "";

      // Duplicate/in-progress rejections aren't real failures worth a
      // chat bubble — the original request this one raced against is
      // still running (or already finished). Just drop the extra one.
      //
      // USAGE_LIMIT_REACHED belongs here too, not in the chat at all: the
      // dedicated quota card (ChatView's QuotaLimitCard, driven by the
      // live usage listener) is the only place this state is shown. It
      // must never become an assistant message, never fall through to
      // the generic "couldn't reach Neribo's backend" text below, and
      // never be persisted as part of the conversation. The user's own
      // message they just sent is kept exactly as-is.
      if (
        err instanceof NeriboApiError &&
        (err.code === "REQUEST_IN_PROGRESS" ||
          err.code === "DUPLICATE_REQUEST" ||
          err.code === "USAGE_LIMIT_REACHED")
      ) {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId ? { ...t, messages: updatedMessages } : t
          )
        );
        return;
      }

      // A suspended account is signed out immediately rather than shown
      // a chat bubble — the account can no longer use the app at all,
      // not just this one send.
      if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
        showToast(err.message, "error");
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId ? { ...t, messages: updatedMessages } : t
          )
        );
        void signOut(auth);
        return;
      }

      // Backend rejected Neribo.search for a non-Pro account. Same
      // treatment as the client-side isProModel(model) && !isPremium
      // guard above — show the upgrade modal, no error chat bubble. This
      // path is a rare edge case (stale isPremium state), since the
      // model picker/send-guard already prevent reaching it normally.
      if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
        setShowUpgradeModal(true);
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId ? { ...t, messages: updatedMessages } : t
          )
        );
        return;
      }

      const bubbleContent =
        err instanceof NeriboApiError && err.code === "AUTH_ERROR"
          ? "Your session has expired. Please sign in again."
          : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
          ? err.message
          : partial
          ? `${partial}\n\n---\n*⚠️ Response interrupted — I couldn't reach Neribo's backend. The text above is what was received before the connection dropped.*`
          : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
          ? err.message
          : "I couldn't reach Neribo's backend just now. Please check your connection and try again.";

      const errorMsg: ChatMessage = {
        id: `msg-ai-error-${Date.now()}`,
        role: "assistant",
        content: bubbleContent,
        model,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? {
                ...t,
                messages: [...updatedMessages, errorMsg],
                updatedAt: nowTimestamp(),
              }
            : t
        )
      );
    } finally {
      setIsLoading(false);
      setSearchActivity(null);
      if (streamRafRef.current != null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      if (streamingIdRef.current === streamId) {
        streamingIdRef.current = null;
        setStreamingMessage(null);
      }
    }
  };

  // Handler: Regenerate last AI message
  const handleRegenerate = async () => {
    if (!activeThread || activeThread.messages.length === 0) return;
    if (isProModel(activeThread.model) && !isPremium) {
      setShowUpgradeModal(true);
      return;
    }
    // No toast — same reasoning as handleSendMessage above: the quota
    // card already visible above the composer is the single source of
    // truth for this state.
    // Same as handleSendMessage: Neribo.search has its own quota, so the
    // chat quota never blocks it.
    if (!isSearchModel(activeThread.model) && isQuotaExhausted(usage)) {
      return;
    }
    const lastUserIndex = activeThread.messages
      .map((m) => m.role)
      .lastIndexOf("user");
    if (lastUserIndex === -1) return;

    const trimmed = activeThread.messages.slice(0, lastUserIndex + 1);
    const lastUserMsg = trimmed[trimmed.length - 1];

    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThreadId ? { ...t, messages: trimmed } : t
      )
    );

    setIsLoading(true);

    if (
      !isImageGenerationModel(activeThread.model) &&
      isImageGenerationIntent(lastUserMsg.content)
    ) {
      const redirectMsg = buildArtRedirectMessage(
        "msg-ai-regen-redirect-art",
        activeThread.model || DEFAULT_MODEL_ID,
        lastUserMsg.content
      );
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...trimmed, redirectMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
      setIsLoading(false);
      return;
    }

    // Same reasoning as handleSendMessage above, mirrored for regenerate.
    if (
      !isImageGenerationModel(activeThread.model) &&
      !isSearchModel(activeThread.model) &&
      isSearchIntent(lastUserMsg.content)
    ) {
      const redirectMsg = buildSearchRedirectMessage(
        "msg-ai-regen-redirect-search",
        activeThread.model || DEFAULT_MODEL_ID,
        lastUserMsg.content
      );
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...trimmed, redirectMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
      setIsLoading(false);
      return;
    }

    if (isImageGenerationModel(activeThread.model)) {
      if (!isImageGenerationIntent(lastUserMsg.content)) {
        const redirectMsg = buildChatRedirectMessage(
          "msg-ai-regen-redirect-chat",
          activeThread.model || DEFAULT_MODEL_ID,
          lastUserMsg.content
        );
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...trimmed, redirectMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
        setIsLoading(false);
        return;
      }
      setIsGeneratingImage(true);
      try {
        // Same Pro-tier routing as handleSendMessage's image branch above.
        const { dataUrl } = await generateImage(
          lastUserMsg.content,
          activeThread.model === ART_PRO_MODEL_ID ? "art_pro" : undefined
        );
        const stampedDataUrl = await stampNeriboWatermark(dataUrl);
        const { imageUrl } = await storeGeneratedImage(stampedDataUrl);
        // Usage Analytics (Phase 6) — same "count only on real success"
        // rule as handleSendMessage's image branch.
        trackInteraction("image_generated", activeThread.model || DEFAULT_MODEL_ID);
        const imageMsg: ChatMessage = {
          id: `msg-ai-regen-image-${Date.now()}`,
          role: "assistant",
          content: "",
          imageUrl,
          model: activeThread.model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...trimmed, imageMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } catch (err) {
        toSafeMessage(err, "ai", "regenerate-image");
        if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
          showToast(err.message, "error");
          setIsLoading(false);
          void signOut(auth);
          return;
        }
        // Same reasoning as handleSendMessage's image-branch catch above:
        // backend PRO_REQUIRED shows the upgrade modal, not an error bubble.
        if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
          setShowUpgradeModal(true);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeThreadId ? { ...t, messages: trimmed } : t
            )
          );
          return;
        }
        const bubbleContent =
          err instanceof NeriboApiError && err.code === "AUTH_ERROR"
            ? "Your session has expired. Please sign in again."
            : err instanceof NeriboApiError && err.code === "IMAGE_LIMIT_REACHED"
            ? formatImageLimitBubble(err.limit, err.resetAt)
            : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
            ? err.message
            : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
            ? err.message
            : "I couldn't generate that image just now. Please try again.";
        const errorMsg: ChatMessage = {
          id: `msg-ai-regen-image-error-${Date.now()}`,
          role: "assistant",
          content: bubbleContent,
          model: activeThread.model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...trimmed, errorMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } finally {
        setIsLoading(false);
        setIsGeneratingImage(false);
      }
      return;
    }

    // Same reasoning as handleSendMessage's Neribo.search branch above,
    // mirrored for regenerate.
    if (isSearchModel(activeThread.model)) {
      try {
        setSearchActivity({ query: lastUserMsg.content });
        const results = await searchWeb(
          lastUserMsg.content,
          activeThread.model === SEARCH_PRO_MODEL_ID ? "pro" : undefined
        );
        trackInteraction("message_sent", activeThread.model || DEFAULT_MODEL_ID);
        const resultsMsg: ChatMessage = {
          id: `msg-ai-regen-search-${Date.now()}`,
          role: "assistant",
          content: "",
          searchResults: results,
          model: activeThread.model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...trimmed, resultsMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } catch (err) {
        // Same PRO_REQUIRED handling as handleSendMessage's search branch.
        if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
          setShowUpgradeModal(true);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === activeThreadId ? { ...t, messages: trimmed } : t
            )
          );
          return;
        }
        toSafeMessage(err, "ai", "regenerate-search-query");
        if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
          showToast(err.message, "error");
          setIsLoading(false);
          void signOut(auth);
          return;
        }
        const bubbleContent =
          err instanceof NeriboApiError && err.code === "AUTH_ERROR"
            ? "Your session has expired. Please sign in again."
            : err instanceof NeriboApiError && err.code === "SEARCH_LIMIT_REACHED"
            ? "You've reached your search limit for now. Please try again shortly."
            : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
            ? err.message
            : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
            ? err.message
            : "I couldn't complete that search just now. Please try again.";
        const errorMsg: ChatMessage = {
          id: `msg-ai-regen-search-error-${Date.now()}`,
          role: "assistant",
          content: bubbleContent,
          model: activeThread.model,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThreadId
              ? { ...t, messages: [...trimmed, errorMsg], updatedAt: nowTimestamp() }
              : t
          )
        );
      } finally {
        setSearchActivity(null);
        setIsLoading(false);
      }
      return;
    }

    const streamId = `msg-ai-regen-${Date.now()}`;
    streamingIdRef.current = streamId;
    streamingBufferRef.current = "";
    setStreamingMessage({ id: streamId, content: "", model: activeThread.model });
    setSearchActivity(null);

    try {
      const reply = await sendChatMessage(trimmed, {
        model: activeThread.model,
        // Regenerating a reply to a message that had an image attached
        // must still send that image — otherwise the regenerated answer
        // silently loses all visual context. lastUserMsg.userImageUrl is
        // either the original data: URL (upload still in flight/failed)
        // or the persisted Supabase URL (upload finished) — the
        // vision-capable upstream accepts either directly, so no extra
        // handling is needed here.
        imageDataUrl: lastUserMsg.userImageUrl,
        onChunk: (_delta, full) => {
          setSearchActivity(null);
          streamingBufferRef.current = full;
          flushStreamingUpdate(streamId);
        },
        onSearchState: (state) => {
          setSearchActivity(state.status === "start" ? { query: state.query || "" } : null);
        },
      });
      // Usage Analytics (Phase 6) — same "count only on real success"
      // rule as handleSendMessage's text branch.
      trackInteraction("message_sent", activeThread.model || DEFAULT_MODEL_ID);
      const newAiMsg: ChatMessage = {
        id: streamId,
        role: "assistant",
        content: reply,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        model: activeThread.model,
      };
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...trimmed, newAiMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
    } catch (err) {
      toSafeMessage(err, "ai", "regenerate-message"); // logs internally; message below is the safe, user-facing one
      // Honest error message — no canned reply pretending it worked. Keep
      // whatever had already streamed in before the failure.
      const partial =
        streamingIdRef.current === streamId ? streamingBufferRef.current.trim() : "";

      // Same reasoning as handleSendMessage's catch above: duplicate/
      // in-progress AND quota-exhausted all skip the chat bubble entirely.
      // USAGE_LIMIT_REACHED is handled by the dedicated quota card, never
      // an assistant message.
      if (
        err instanceof NeriboApiError &&
        (err.code === "REQUEST_IN_PROGRESS" ||
          err.code === "DUPLICATE_REQUEST" ||
          err.code === "USAGE_LIMIT_REACHED")
      ) {
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThreadId ? { ...t, messages: trimmed } : t))
        );
        return;
      }

      // Same reasoning as handleSendMessage's catch above: a suspended
      // account is signed out immediately, not shown a chat bubble.
      if (err instanceof NeriboApiError && err.code === "ACCOUNT_SUSPENDED") {
        showToast(err.message, "error");
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThreadId ? { ...t, messages: trimmed } : t))
        );
        void signOut(auth);
        return;
      }

      // Same reasoning as handleSendMessage's catch above: backend
      // PRO_REQUIRED (Neribo.search on a non-Pro account) shows the
      // upgrade modal, not an error chat bubble.
      if (err instanceof NeriboApiError && err.code === "PRO_REQUIRED") {
        setShowUpgradeModal(true);
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThreadId ? { ...t, messages: trimmed } : t))
        );
        return;
      }

      const bubbleContent =
        err instanceof NeriboApiError && err.code === "AUTH_ERROR"
          ? "Your session has expired. Please sign in again."
          : err instanceof NeriboApiError && err.code === "ACCOUNT_FLAGGED"
          ? err.message
          : partial
          ? `${partial}\n\n---\n*⚠️ Response interrupted — I couldn't reach Neribo's backend. The text above is what was received before the connection dropped.*`
          : err instanceof NeriboApiError && err.code === "AI_PROVIDER_ERROR" && err.message
          ? err.message
          : "I couldn't reach Neribo's backend just now. Please check your connection and try again.";

      const errorMsg: ChatMessage = {
        id: `msg-ai-regen-error-${Date.now()}`,
        role: "assistant",
        content: bubbleContent,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeThreadId
            ? { ...t, messages: [...trimmed, errorMsg], updatedAt: nowTimestamp() }
            : t
        )
      );
    } finally {
      setIsLoading(false);
      setSearchActivity(null);
      if (streamRafRef.current != null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      if (streamingIdRef.current === streamId) {
        streamingIdRef.current = null;
        setStreamingMessage(null);
      }
    }
  };

  // Auth flow
  const handleEmailSignIn = async (email: string, password: string) => {
    setAuthError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setAuthError(toSafeMessage(err, "auth", "email-sign-in"));
      // System Console "Account Access" tool's "Recent Authentication
      // Failures" list, password half — see src/lib/authFailureLog.ts.
      // Sign-up failures (handleEmailSignUp below) are a different
      // event entirely (no existing account was being authenticated
      // against) and are deliberately not logged here.
      recordLoginFailure(email, err);
    }
  };

  const handleEmailSignUp = async (email: string, password: string) => {
    setAuthError("");
    if (password.length < 6) {
      // Client-side validation, not an internal error — safe to show as-is.
      setAuthError("Password should be at least 6 characters.");
      return;
    }
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setAuthError(toSafeMessage(err, "auth", "email-sign-up"));
    }
  };

  const handleLogout = async () => {
    // Clear this device's Device Lock activity marker BEFORE signing out,
    // same reasoning as the HMS reference's wrapped signOut: an explicit
    // logout must never leave a stale "recently active" timestamp behind
    // for whoever signs in next on this device (see
    // src/contexts/DeviceLockContext.tsx's file header).
    if (firebaseUser) clearDeviceLockActivity(firebaseUser.uid);
    await signOut(auth);
    setActiveNav("chat");
    setOperationsSection("dashboard");
    // Clear this tab's persisted route (see ACTIVE_NAV_STORAGE_KEY above)
    // so the next sign-in in this tab — same account or a different one —
    // always starts fresh on Chat rather than restoring wherever this
    // account happened to leave off.
    try {
      sessionStorage.removeItem(ACTIVE_NAV_STORAGE_KEY);
      sessionStorage.removeItem(OPERATIONS_SECTION_STORAGE_KEY);
    } catch {
      // Best-effort only.
    }
  };

  // The logo intro must finish its full NERIBO_INTRO_MS (when online —
  // see bootAnimDone above) before anything else in the app can show,
  // even if auth/chats/operations all resolve well before that.
  if (!bootAnimDone) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-0)]">
        <NeriboLogoAnimated size={72} />
      </div>
    );
  }
  // While Firebase determines whether someone is already signed in, show a
  // minimal loading screen instead of flashing the sign-in screen.
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-0)]">
        <NeriboLogoAnimated size={72} />
      </div>
    );
  }
  // If not authenticated, render Welcome/Auth screen (Screenshot 2 Right)
  if (!isAuthenticated) {
    return (
      <div className="min-h-dvh bg-[var(--bg-0)] text-neutral-100 font-sans">
        <AuthScreen
          onEmailSignIn={handleEmailSignIn}
          onEmailSignUp={handleEmailSignUp}
          errorMessage={authError}
          onOpenLegal={(type) => setLegalModalType(type)}
        />

        {/* Legal terms modal */}
        <ModalWrapper
          isOpen={Boolean(legalModalType)}
          onClose={() => setLegalModalType(null)}
          title={
            legalModalType === "terms"
              ? "Neribo Consumer Terms"
              : legalModalType === "usage"
              ? "Neribo Usage Policy"
              : "Neribo Privacy Policy"
          }
        >
          <div className="space-y-3 text-xs text-neutral-300 leading-relaxed">
            <p>
              Welcome to Neribo. By utilizing our computational reasoning engine, you
              agree to uphold safe problem-solving standards.
            </p>
            <p>
              Your data is private to your account. Neribo does not sell personal
              prompts or enterprise secrets to third-party ad networks.
            </p>
            <p>
              Usage is monitored strictly for safety compliance. For questions, contact
              support@neribo.ai.
            </p>
          </div>
        </ModalWrapper>
      </div>
    );
  }

  // A fresh sign-in/sign-up just completed on the Auth screen — replay the
  // full logo intro (see postLoginAnimDone above) before the chat UI can
  // appear, same as the initial-load gate does on page open.
  if (!postLoginAnimDone) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-0)]">
        <NeriboLogoAnimated size={72} />
      </div>
    );
  }

  // Chat history is being pulled from Firestore for the signed-in account —
  // reuse the same minimal loading screen rather than flashing an empty
  // chat list or a second, different-looking loader.
  if (chatsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-0)]">
        <NeriboLogoAnimated size={72} />
      </div>
    );
  }

  // Whether this account holds the Supervisor role is still being checked —
  // never let the normal chat UI show first and then redirect. Same
  // neutral loading screen as the checks above.
  if (operationsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-0)]">
        <NeriboLogoAnimated size={72} />
      </div>
    );
  }

  return (
    <DeviceLockProvider uid={firebaseUser?.uid ?? null} applicable={isOperations}>
    <div
      className={`h-dvh flex overflow-hidden bg-[var(--bg-0)] text-[var(--fg-0)] font-sans selection:bg-blue-600/30 selection:text-white ${
        settings.fontStyle === "Editorial"
          ? "font-serif"
          : settings.fontStyle === "Monospace"
          ? "font-mono"
          : "font-sans"
      }`}
    >
      {/* Navigation Sidebar Drawer — a Supervisor account gets its own
          dedicated sidebar (OperationsSidebar), never this one. */}
      {isOperations ? (
        <OperationsSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          section={operationsSection}
          onSelectSection={setOperationsSection}
          currentUser={currentUser}
          onLogout={handleLogout}
        />
      ) : (
        <SidebarDrawer
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeNav={activeNav}
          onSelectNav={(nav) => setActiveNavGuarded(nav)}
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={(id) => setActiveThreadId(id)}
          onNewChat={handleNewChat}
          onDeleteThread={handleDeleteThread}
          currentUser={currentUser}
          onOpenAccountsModal={() => {}}
          onOpenSettings={() => setActiveNavGuarded("settings")}
          chatNeriboEnabled={chatNeriboEnabled}
          chatNeriboUnread={chatNeriboUnread}
          domainsEnabled={domainsEnabled}
          domainsEligible={domainsEligible}
        />
      )}

      {/* Main Content Area */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Header */}
        <Header
          activeNav={activeNav}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNewChat={handleNewChat}
          onOpenSettings={() => setActiveNavGuarded("settings")}
          onOpenInfo={() => setShowAboutModal(true)}
          onBackToChat={() => setActiveNavGuarded("chat")}
          isOperations={isOperations}
          onOpenNotifications={() => setShowNotificationCenter(true)}
          onOpenChatMenu={() => {
            const confirmed = window.confirm("Clear all messages in this chat thread?");
            if (confirmed) {
              // Preserve the messages being cleared into Deleted →
              // Messages BEFORE wiping them from local state — same
              // "archive first" contract src/lib/chatPersistence.ts's
              // archiveDeletedThread already uses for a fully deleted
              // conversation. Best-effort and non-fatal: the clear
              // itself always proceeds below regardless of whether this
              // succeeds.
              if (activeThread && activeThread.messages.length > 0) {
                archiveClearedMessages(currentUser.id, activeThread.id, activeThread).catch((err) => {
                  toSafeMessage(err, "firestore", `archive-cleared-${activeThread.id}`);
                });
              }
              setThreads((prev) =>
                prev.map((t) =>
                  t.id === activeThreadId ? { ...t, messages: [], updatedAt: nowTimestamp() } : t
                )
              );
            }
          }}
        />

        {/* View Switcher */}
        <main className="flex flex-col flex-1 min-h-0">
          {activeNav === "chat" && (
            <ChatView
              thread={activeThread}
              currentUser={currentUser}
              onSendMessage={handleSendMessage}
              onRegenerate={handleRegenerate}
              isLoading={isLoading}
              streamingMessage={streamingMessage}
              searchActivity={searchActivity}
              isGeneratingImage={isGeneratingImage}
              onOpenVoiceMode={() => setShowVoiceModeModal(true)}
              selectedVoice={settings.voice}
              isPremium={isPremium}
              onRequirePremium={() => setShowUpgradeModal(true)}
              usage={usage}
              imageUsage={imageUsage}
            />
          )}

          {activeNav === "settings" && (
            <SettingsView
              settings={settings}
              onUpdateSettings={setSettings}
              currentUser={currentUser}
              usage={usage}
              onOpenUpgrade={() => setShowUpgradeModal(true)}
              onOpenProfile={() => setShowProfileModal(true)}
              onOpenBilling={() => {
                // Pro accounts see their renewal date, never the pricing/
                // upsell page they've already bought (see
                // SubscriptionModal vs UpgradeModal in SettingsModals.tsx).
                if (usage?.plan === "pro") {
                  setShowSubscriptionModal(true);
                } else {
                  setShowUpgradeModal(true);
                }
              }}
              onOpenCapabilities={() => setShowCapabilitiesModal(true)}
              onOpenConnectors={() => setShowConnectorsModal(true)}
              onOpenPermissions={() => setShowPermissionsModal(true)}
              onOpenColorMode={() => setShowColorModeModal(true)}
              onOpenFontStyle={() => setShowFontStyleModal(true)}
              onOpenFontSize={() => setShowFontSizeModal(true)}
              onOpenVoice={() => setShowVoiceModal(true)}
              onOpenPrivacy={() => {
                showToast("Privacy Shield: Chat history encryption enabled.", "success");
              }}
              onOpenSharing={() => {
                if (navigator.share) {
                  navigator
                    .share({
                      title: "Neribo",
                      text: "Neribo — The AI for problem solvers.",
                      url: window.location.origin,
                    })
                    .catch(() => {
                      // User cancelled the native share sheet — no error to show.
                    });
                } else {
                  setShowSharingModal(true);
                }
              }}
              onOpenAbout={() => setShowAboutModal(true)}
              onLogout={handleLogout}
            />
          )}

          {activeNav === "orders" && (
            <OrdersView
              orders={orders}
              ordersLoadError={ordersLoadError}
              items={showcaseItems}
              itemsLoadError={showcaseLoadError}
              onBrowseShowcase={() => setActiveNavGuarded("showcase")}
            />
          )}

          {activeNav === "live" && (
            <LiveView items={showcaseItems} loadError={showcaseLoadError} />
          )}

          {activeNav === "showcase" && (
            <ShowcaseView
              items={showcaseItems}
              loadError={showcaseLoadError}
              uid={currentUser.id}
              orders={orders}
              onOpenOrders={() => setActiveNavGuarded("orders")}
            />
          )}

          {activeNav === "chatNeribo" && !isOperations && (
            <ChatNeriboView
              messages={chatNeriboMessages}
              loadError={chatNeriboLoadError}
              enabled={chatNeriboEnabled}
            />
          )}

          {activeNav === "domains" && !isOperations && (
            <DomainsView
              uid={currentUser.id}
              orders={orders}
              domainRequests={domainRequests}
              loadError={domainRequestsLoadError}
            />
          )}

          {activeNav === "operations" && isOperations && (
            <OperationsView
              isOperations={isOperations}
              section={operationsSection}
              onNavigate={setOperationsSection}
              settings={settings}
              onUpdateSettings={setSettings}
              showcaseItems={showcaseItems}
              showcaseLoadError={showcaseLoadError}
              onShowcaseItemSaved={handleShowcaseItemSaved}
            />
          )}
        </main>
      </div>

      {/* Global Modals */}
      <NotificationCenterPanel
        isOpen={showNotificationCenter}
        onClose={() => setShowNotificationCenter(false)}
      />

      <UpgradeModal
        isOpen={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
        currentPlan={currentUser.plan || "Free"}
        onSelectPlan={() => {
          // Kicks off a Paystack checkout for the ₦1,000/week Pro plan
          // (see functions/api/payments/initialize.js) and redirects the
          // browser there. This call never upgrades the account by
          // itself — that only happens once Paystack's webhook confirms
          // payment (functions/api/payments/webhook.js) — so nothing here
          // needs to update currentUser.plan on success; if the redirect
          // happens, the user is already leaving this screen.
          startProUpgrade().catch((err) => {
            const message =
              err instanceof PaymentsApiError
                ? err.message
                : "Couldn't start checkout. Please try again.";
            showToast(message, "error");
          });
        }}
      />

      <SubscriptionModal
        isOpen={showSubscriptionModal}
        onClose={() => setShowSubscriptionModal(false)}
        renewsAt={usage?.resetAt ?? null}
        paidAt={usage?.paidAt ?? null}
        paymentIssue={usage?.paymentIssue ?? false}
        cancelRequestedAt={usage?.cancelRequestedAt ?? null}
        onCancelSubscription={async () => {
          try {
            await cancelSubscription();
            showToast(
              "Subscription cancelled. Your Pro access continues until it expires.",
              "success"
            );
          } catch (err) {
            const message =
              err instanceof PaymentsApiError
                ? err.message
                : "Couldn't cancel your subscription. Please try again.";
            showToast(message, "error");
          }
        }}
      />

      <CapabilitiesModal
        isOpen={showCapabilitiesModal}
        onClose={() => setShowCapabilitiesModal(false)}
        settings={settings}
        isPremium={isPremium}
        onToggle={(key) => {
          setSettings((prev) => {
            const newVal = !prev.capabilities[key];
            const updated = { ...prev.capabilities, [key]: newVal };
            const count = Object.values(updated).filter(Boolean).length;
            return { ...prev, capabilities: updated, capabilitiesCount: count };
          });
        }}
        onRequirePremium={() => {
          setShowCapabilitiesModal(false);
          setShowUpgradeModal(true);
        }}
      />

      <ConnectorsModal
        isOpen={showConnectorsModal}
        onClose={() => setShowConnectorsModal(false)}
      />

      <ColorModeModal
        isOpen={showColorModeModal}
        onClose={() => setShowColorModeModal(false)}
        currentMode={settings.colorMode}
        onSelect={(mode) => setSettings((prev) => ({ ...prev, colorMode: mode }))}
      />

      <FontStyleModal
        isOpen={showFontStyleModal}
        onClose={() => setShowFontStyleModal(false)}
        currentStyle={settings.fontStyle}
        onSelect={(style) => setSettings((prev) => ({ ...prev, fontStyle: style }))}
      />

      <FontSizeModal
        isOpen={showFontSizeModal}
        onClose={() => setShowFontSizeModal(false)}
        currentSize={settings.fontSize}
        onSelect={(fontSize) => setSettings((prev) => ({ ...prev, fontSize }))}
      />

      <VoiceModal
        isOpen={showVoiceModal}
        onClose={() => setShowVoiceModal(false)}
        currentVoice={settings.voice}
        onSelect={(voice) => setSettings((prev) => ({ ...prev, voice }))}
      />

      <VoiceModeModal
        isOpen={showVoiceModeModal}
        onClose={() => setShowVoiceModeModal(false)}
      />

      <AboutModal
        isOpen={showAboutModal}
        onClose={() => setShowAboutModal(false)}
      />

      <ProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        currentUser={currentUser}
        onSaveNickname={handleUpdateNickname}
      />

      <PermissionsModal
        isOpen={showPermissionsModal}
        onClose={() => setShowPermissionsModal(false)}
        permissions={settings.permissions}
        onUpdatePermissions={(updater) =>
          setSettings((prev) => ({ ...prev, permissions: updater(prev.permissions) }))
        }
      />

      <SharingModal
        isOpen={showSharingModal}
        onClose={() => setShowSharingModal(false)}
        shareUrl={window.location.origin}
      />
    </div>
    {/* Supervisor-only (applicable=isOperations above): renders nothing
        unless DeviceLockContext reports this device locked — see
        src/contexts/DeviceLockContext.tsx and
        src/components/DeviceLockScreen.tsx. */}
    <DeviceLockOverlay currentUser={currentUser} onSignOut={handleLogout} />
    </DeviceLockProvider>
  );
}
