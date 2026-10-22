// Firebase Cloud Messaging service worker — handles push notifications
// while Neribo is backgrounded or fully closed (see
// PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §3.1). Served at
// `/firebase-messaging-sw.js` (this repo's vite.config.ts already copies
// everything under public/ to dist/ root on build), which is where FCM's
// default web setup expects it.
//
// A service worker can't import the app's TS modules, so the Firebase
// config below is a literal copy of src/lib/firebase.ts's `firebaseConfig`
// — that file's own header comment already documents this as non-secret.
// KEEP IN SYNC with src/lib/firebase.ts if either ever changes.
//
// Everything in here fails silently from the user's perspective (§7):
// there is no user-facing surface for a service-worker error, so every
// failure here is just a console.error, never a thrown/unhandled error
// that could break registration for the rest of the app.

importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBfb_2Ld64LuwSo5n_k1yke5CoIygjSODA",
  authDomain: "neribo-prod.firebaseapp.com",
  projectId: "neribo-prod",
  storageBucket: "neribo-prod.firebasestorage.app",
  messagingSenderId: "373059167976",
  appId: "1:373059167976:web:0eddfedc82a8ea48fdcb5d",
  measurementId: "G-ZJY363CJLP",
});

let messaging = null;
try {
  messaging = firebase.messaging();
} catch (err) {
  // Missing/misconfigured Firebase config, or messaging genuinely
  // unsupported in this browser's service-worker context — background
  // push just stays unavailable; nothing else in this file can run
  // without `messaging`, so every handler below already no-ops when it's
  // null.
  console.error("[Neribo:push-sw] firebase.messaging() failed to initialize:", err);
}

if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    // pushSender.js sends data-only messages (no top-level `notification`
    // field) specifically so FCM never auto-displays a notification on
    // its own — this handler is the single place that ever calls
    // showNotification. Read title/body from `data`, not `notification`.
    const title = (payload.data && payload.data.title) || "Neribo";
    const body = (payload.data && payload.data.body) || "";
    const url = (payload.data && payload.data.url) || "/";

    self.registration
      .showNotification(title, {
        body,
        icon: "/neribo-icon-192.png",
        badge: "/neribo-icon-192.png",
        data: { url },
      })
      .catch((err) => {
        console.error("[Neribo:push-sw] showNotification failed:", err);
      });
  });
}

// Routes a tap on the OS-level notification back into the app at the
// right screen (§1/§3.1): focuses an already-open tab (and hands it the
// destination via postMessage, since a focused tab can't be navigated by
// URL alone without a full reload) or, if nothing is open, opens a new
// one directly at that URL — src/App.tsx reads `?nav=...` on load for
// exactly this case (see its own notification-routing effect).
self.addEventListener("notificationclick", (event) => {
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "neribo-notification-click", url });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
        return undefined;
      })
      .catch((err) => {
        console.error("[Neribo:push-sw] notificationclick handling failed:", err);
      })
  );
});