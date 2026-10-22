// Neribo's official, user-facing model list. This is the single source of
// truth for what appears in the model picker and how it's gated — every
// other file (ChatView, App, the backend) reads from or mirrors this list
// rather than hardcoding model names of its own.
//
// These IDs are what the frontend sends to the backend and what threads
// are tagged with. They are NOT provider model IDs — the backend maps
// each one internally to whichever upstream model actually serves it
// (see functions/api/llm/chat/completions.js). Nothing about the real
// provider or its model names should ever leak past this file.

export interface NeriboModel {
  id: string;
  name: string;
  tag: string;
  desc: string;
  pro: boolean;
  // True only for models that generate images instead of text replies.
  // The frontend (ChatView/App) uses this to route requests to
  // /api/images/generate instead of /api/llm/chat/completions — see
  // src/lib/neriboApi.ts's generateImage().
  isImageModel?: boolean;
  // True only for models that return raw web-search results instead of
  // a text reply or an image. Mirrors isImageModel above: the frontend
  // (ChatView/App) uses this to route requests to /api/search/query
  // instead of /api/llm/chat/completions — see src/lib/neriboApi.ts's
  // searchWeb(). A search model is never also a text or image model.
  isSearchModel?: boolean;
}

// NOTE: every entry here is a masked Neribo.* alias — the backend
// deliberately never reveals which real provider serves it (see
// functions/api/llm/chat/completions.js). There used to be one explicit
// exception (a real provider exposed directly under its own name) —
// that entry has been removed from the picker.

// Referenced by src/App.tsx (both the send and regenerate image-
// generation branches) to know which model ID routes an image request
// to the Pro-tier engine (functions/api/images/generate.js) instead of
// the free one — kept as one exported constant, same pattern as
// WEB_SEARCH_MODEL_ID below, so the literal string only lives here.
export const ART_PRO_MODEL_ID = "Neribo.art.pro";

// Referenced by src/App.tsx (both the send and regenerate search branches)
// to know which model ID routes a search request to the Pro-tier search
// endpoint (functions/api/search/query-pro.js) instead of the free one
// (functions/api/search/query.js) — same single-constant pattern as
// ART_PRO_MODEL_ID above.
export const SEARCH_PRO_MODEL_ID = "Neribo.search.pro";

export const NERIBO_MODELS: NeriboModel[] = [
  {
    id: "Neribo.chat",
    name: "Neribo.chat",
    tag: "Default",
    desc: "Standard AI model",
    pro: false,
  },
  // Neribo.search — a free, standalone web-search feature. Unlike every
  // other entry here it returns raw search results (titles, snippets,
  // links) instead of an AI-generated reply, and is decoupled from any
  // chat/AI engine entirely — see functions/api/search/query.js and
  // src/lib/neriboApi.ts's searchWeb(). isSearchModel is what routes the
  // frontend there instead of /api/llm/chat/completions.
  {
    id: "Neribo.search",
    name: "Neribo.search",
    tag: "Default",
    desc: "Searches the live web for current, real-time results",
    pro: false,
    isSearchModel: true,
  },
  // Neribo.search.pro — the Pro-tier counterpart of Neribo.search. It
  // behaves exactly the same from the user's side (isSearchModel: a
  // results list, never a chat reply), but is served by its own separate
  // endpoint (functions/api/search/query-pro.js, selected by
  // src/lib/neriboApi.ts's searchWeb(query, "pro")) and is Pro-gated on
  // the server as well as in the picker.
  {
    id: SEARCH_PRO_MODEL_ID,
    name: "Neribo.search.pro",
    tag: "PRO",
    desc: "Searches the live web with a stronger, higher-quality engine",
    pro: true,
    isSearchModel: true,
  },
  // Neribo.chat.pro — a plain Pro-tier text-chat model, no different in
  // shape from Neribo.chat: it just resolves to a
  // different upstream (see functions/api/llm/chat/completions.js's
  // resolveModel) and is Pro-gated on the server (plan check in completions.js).
  // No bundled search or image generation, and no special-cased routing
  // anywhere in src/App.tsx.
  {
    id: "Neribo.chat.pro",
    name: "Neribo.chat.pro",
    tag: "PRO",
    desc: "Advanced Pro-tier conversation model",
    pro: true,
  },
  {
    id: "Neribo.art",
    name: "Neribo.art",
    tag: "Image",
    desc: "Generates images from a text description",
    pro: false,
    isImageModel: true,
  },
  // Neribo.art.pro — a standalone, Pro-gated image-generation model. It
  // behaves exactly like Neribo.art (same isImageModel routing, same
  // intent-detection/redirect behavior in src/App.tsx) but resolves to a
  // stronger upstream engine server-side (see
  // functions/api/images/generate.js's ART_PRO_MODEL_ID handling) and is
  // never bundled with Neribo.chat.pro or triggered from a chat request.
  {
    id: ART_PRO_MODEL_ID,
    name: "Neribo.art.pro",
    tag: "PRO",
    desc: "Generates higher-quality images from a text description",
    pro: true,
    isImageModel: true,
  },
];

export const DEFAULT_MODEL_ID = NERIBO_MODELS[0].id;

// Referenced by App.tsx's search-intent routing (see
// src/lib/intentDetection.ts's isSearchIntent) to know which model to
// suggest, and to avoid suggesting it to itself. Also referenced by
// App.tsx/ChatView.tsx to detect that the selected model is Neribo.search
// and route the send flow to the results-list UI instead of the SSE
// chat path.
export const WEB_SEARCH_MODEL_ID = "Neribo.search";

/** True if the given model ID is a real, currently-official Neribo model. */
export function isKnownModel(modelId?: string): boolean {
  return NERIBO_MODELS.some((m) => m.id === modelId);
}

/** True if the given model ID requires a Pro plan. Unknown IDs are not Pro. */
export function isProModel(modelId?: string): boolean {
  return NERIBO_MODELS.find((m) => m.id === modelId)?.pro ?? false;
}

/** True if the given model ID generates images rather than text. */
export function isImageGenerationModel(modelId?: string): boolean {
  return NERIBO_MODELS.find((m) => m.id === modelId)?.isImageModel ?? false;
}

/** True if the given model ID returns raw search results rather than
 * text or an image. */
export function isSearchModel(modelId?: string): boolean {
  return NERIBO_MODELS.find((m) => m.id === modelId)?.isSearchModel ?? false;
}

// ---------------------------------------------------------------------
// Chat ↔ Art routing helpers
// ---------------------------------------------------------------------
// Neribo.chat, Neribo.chat.pro, and Neribo.art are presented to the
// user as one application with several capabilities, not separate
// apps. When a chat model gets an image-generation request (or Art gets
// a non-image request), the UI needs to know which model(s) to offer as
// the "switch to this instead" suggestion — these two helpers derive
// that from NERIBO_MODELS above instead of hardcoding IDs anywhere else
// (see src/App.tsx and src/components/ChatView.tsx).

/** The image-generation model(s) — currently Neribo.art and Neribo.art.pro. */
export function getImageModels(): NeriboModel[] {
  return NERIBO_MODELS.filter((m) => m.isImageModel);
}

/** The search model(s) — currently Neribo.search and Neribo.search.pro. */
export function getSearchModels(): NeriboModel[] {
  return NERIBO_MODELS.filter((m) => m.isSearchModel);
}

/** The text/chat model(s) — currently Neribo.chat and Neribo.chat.pro.
 * Excludes both image models and search models (see getImageModels/
 * getSearchModels above) — Neribo.search is a standalone results-list
 * feature, not a text-chat model, so it must never show up here. */
export function getTextModels(): NeriboModel[] {
  return NERIBO_MODELS.filter((m) => !m.isImageModel && !m.isSearchModel);
}

// ---------------------------------------------------------------------
// Supervisor-editable display info (App Settings → Models)
// ---------------------------------------------------------------------
// A Supervisor can edit a model's PUBLIC name/tag/description (see
// src/hooks/useModelDisplay.ts + functions/api/admin/set-model-display.js)
// without touching this file. getDisplayModels() is the ONE place that
// merges those live overrides onto NERIBO_MODELS — every other file that
// renders a model's name/tag/desc to a user (ChatView's picker,
// SettingsModals' About panel, App.tsx's Chat↔Art switch suggestions)
// should call this instead of reading NERIBO_MODELS directly, so a
// Supervisor edit shows up everywhere consistently.
//
// `id`, `pro`, and `isImageModel` are NEVER taken from the override —
// only `name`/`tag`/`desc` can be overridden. This is what keeps a
// display-name edit from ever being able to change model routing,
// Pro-gating, or Chat/Art classification: those three fields always
// come from the static NERIBO_MODELS list above, no matter what's saved
// in appConfig/models.
export function getDisplayModels(overrides: Record<string, { name: string; tag: string; desc: string }>): NeriboModel[] {
  return NERIBO_MODELS.map((m) => {
    const override = overrides[m.id];
    return override ? { ...m, name: override.name, tag: override.tag, desc: override.desc } : m;
  });
}
