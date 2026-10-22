// Centralized, easy-to-change quota configuration for Neribo's backend.
//
// Nothing in this file is a secret — API keys and service-account
// credentials live in Cloudflare Pages environment variables/secrets,
// never here. This file is just numbers/strings that define the product
// policy, kept in one place instead of scattered across the request
// handler so they're trivial to tune later.

// Firebase project ID — must match src/lib/firebase.ts's `projectId` and
// the project whose service account JSON is stored in the
// FIREBASE_SERVICE_ACCOUNT_JSON secret (see functions/_shared/googleAuth.js).
export const FIREBASE_PROJECT_ID = "neribo-prod";

// -----------------------------------------------------------------------
// Usage quotas
// -----------------------------------------------------------------------
// Usage unit: one successful AI response (see PLAN.md / implementation
// report for the exact definition of "successful"). Not every Send click,
// not every token — one accepted, provider-served response.
export const QUOTA_BY_PLAN = {
  // graceLimit: a system-wide, automatic buffer on top of the plan's
  // base `limit` — NOT Operations-granted (see bonusLimit in quota.js
  // for that, a separate concept) — shown distinctly to the user once
  // they cross the base limit (see src/lib/usage.ts's isQuotaExhausted
  // and ChatView.tsx's composer banner) before they're actually blocked.
  free: { limit: 20, periodType: "daily", graceLimit: 0 },
  pro: { limit: 300, periodType: "weekly", graceLimit: 10 },
};
export const DEFAULT_PLAN = "free";

// -----------------------------------------------------------------------
// Image-generation quota (Neribo.ai Art) — completely separate from
// QUOTA_BY_PLAN above. Unit: one successfully delivered generated image
// (provider actually returned image bytes), not every tap of Generate.
// This is enforced as a genuine ROLLING 1-hour window (see
// functions/_shared/imageQuota.js), not a fixed calendar-hour bucket —
// IMAGE_QUOTA_WINDOW_MS is the width of that rolling window, applied per
// generation rather than as a shared reset instant for every user.
// -----------------------------------------------------------------------
export const IMAGE_QUOTA_BY_PLAN = {
  free: { limit: 5 },
  pro: { limit: 10 },
};
export const IMAGE_QUOTA_WINDOW_MS = 60 * 60 * 1000;

// -----------------------------------------------------------------------
// Web-search quota (Neribo.search) — completely separate from
// QUOTA_BY_PLAN and IMAGE_QUOTA_BY_PLAN above. Unit: one successfully
// completed search request (the provider actually returned results),
// not every tap of Send. Same genuine ROLLING window design as
// IMAGE_QUOTA_WINDOW_MS above (see functions/_shared/searchQuota.js),
// not a fixed calendar bucket. A search request is much cheaper than a
// chat completion or an image generation, so the window is short and the
// limit generous — this exists to absorb abuse/automation, not to
// meaningfully constrain a real user's free-tier search usage. `pro`
// is defined here too (even though Neribo.search.pro doesn't exist yet —
// see Phase 6) purely so a Pro-plan account using the free Neribo.search
// feature gets a higher ceiling, consistent with every other quota in
// this file.
// -----------------------------------------------------------------------
export const SEARCH_QUOTA_BY_PLAN = {
  free: { limit: 20 },
  pro: { limit: 40 },
};
export const SEARCH_QUOTA_WINDOW_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------
// In-flight / duplicate-request protection
// -----------------------------------------------------------------------
// How long a reservation ("this uid has a request in flight") is honored
// before it's treated as abandoned (e.g. the Function crashed or the
// connection died without ever releasing the lock) and a new request is
// allowed to proceed anyway. This is what lets us avoid a scheduled
// cleanup job — the next request for that uid simply self-heals the lock
// once it's older than this.
export const RESERVATION_TTL_MS = 90 * 1000;

// -----------------------------------------------------------------------
// Firestore transaction retry (handles two requests racing on the same
// usage document — Firestore aborts one side, which we retry)
// -----------------------------------------------------------------------
export const TRANSACTION_MAX_ATTEMPTS = 4;
export const TRANSACTION_RETRY_BASE_MS = 120;
