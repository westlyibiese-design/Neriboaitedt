// Client-side image-generation intent detection.
//
// Used by src/App.tsx to decide, per message, whether a request typed
// into a text model (Neribo.chat / Neribo.chat.pro) is actually asking
// for an image (→ route to Neribo.ai Art) and whether a request typed
// into Neribo.ai Art is actually an image request at all (→ if not,
// route back to a text model instead of generating a random image).
//
// This is intentionally a plain heuristic, not a model call: routing
// happens before any request reaches the backend, so a wrong text model
// can never "fake" an image reply and Neribo.ai Art can never burn a
// generation on a message that was never asking for one. See the
// image-generation-request handling in src/App.tsx's handleSendMessage
// and handleRegenerate for how this is used.
//
// Deliberately biased toward matching the explicit acceptance examples
// (see the Neribo.ai Art integration spec) rather than being a general
// NLP classifier — keyword presence alone is not enough (a message that
// merely mentions "image" or "picture" while asking a question about
// them should NOT be treated as a generation request).

// Nouns that name a visual artifact. Any creation verb below paired with
// one of these is a strong signal, and a few of these nouns directly
// followed by "of/for/showing/depicting" are treated as a request on
// their own, without needing a verb at all ("a logo for my business").
const IMAGE_NOUNS = [
  "image",
  "picture",
  "photo",
  "photograph",
  "illustration",
  "graphic",
  "artwork",
  "wallpaper",
  "logo",
  "poster",
  "portrait",
  "icon",
  "banner",
  "avatar",
  "drawing",
  "painting",
  "cartoon",
  "sticker",
  "mockup",
  "thumbnail",
  "meme",
  "flyer",
  "infographic",
  "mural",
  "concept art",
];

// Verbs that, in this app, signal "make me a visual", not "write me
// text". "generate"/"create"/"make"/"design"/"produce" are ambiguous in
// general English but are only ever used for visual asks in Neribo's own
// examples ("Create a futuristic city.", "Generate a cyberpunk city.") —
// text asks in the same examples use "write", "explain", "help", etc.,
// which are deliberately NOT in this list.
const CREATION_VERBS = [
  "generate",
  "create",
  "draw",
  "make",
  "design",
  "produce",
  "render",
  "paint",
  "sketch",
  "illustrate",
  "visualize",
];

// If one of these shows up as the object of a creation verb, the request
// is for text/code, not a picture, even though it uses a "creation" verb
// ("Create a business proposal" is not an image request).
const NON_VISUAL_OBJECTS = [
  "proposal",
  "essay",
  "story",
  "poem",
  "lyric",
  "email",
  "letter",
  "resume",
  "cv",
  "report",
  "summary",
  "article",
  "script",
  "plan",
  "strategy",
  "recipe",
  "joke",
  "quiz",
  "list",
  "table",
  "spreadsheet",
  "presentation",
  "speech",
  "caption",
  "slogan",
  "function",
  "class",
  "component",
  "variable",
  "database",
  "query",
  "name for",
  "title for",
];

// Leading patterns for a question ABOUT images/generators rather than a
// request FOR one — "How do image generators work?", "What is the
// difference between an image and a video?". These only block a match
// when there's no direct "<noun> of/for ..." phrase overriding them (see
// isImageGenerationIntent below), so "What is a good image of a sunset
// for my desktop?" would still be treated as a request if ever typed.
const INFO_QUESTION_PATTERNS = [
  /^how (do|does|did|can|would|is|are)\b/,
  /^what('s| is| are)\b/,
  /^why (do|does|did|is|are)\b/,
  /^explain\b/,
  /^tell me about\b/,
  /difference between/,
];

// "<image noun> of/for/showing/depicting X" — the strongest, most direct
// signal, and enough on its own even with no creation verb present
// ("A logo for my startup called Kobo.").
const DIRECT_IMAGE_PHRASE = new RegExp(
  `\\b(${IMAGE_NOUNS.filter((n) => !n.includes(" ")).join("|")})\\b\\s+(of|for|showing|depicting|based on)\\b`
);

const TURN_INTO_IMAGE = /\bturn\b.*\binto\s+(an?\s+)?(image|picture|illustration|artwork|photo)\b/;

function hasWord(text: string, phrase: string): boolean {
  if (phrase.includes(" ")) return text.includes(phrase);
  return new RegExp(`\\b${phrase}\\b`).test(text);
}

/**
 * True if `raw` reads as a request to generate an image, false if it
 * reads as an ordinary chat/coding/writing request or a question about
 * images/image-generation in general (rather than a request for one).
 */
export function isImageGenerationIntent(raw: string): boolean {
  const text = raw.toLowerCase().trim();
  if (!text) return false;

  const directImagePhrase = DIRECT_IMAGE_PHRASE.test(text);
  const turnIntoImage = TURN_INTO_IMAGE.test(text);

  const isInfoQuestion = INFO_QUESTION_PATTERNS.some((p) => p.test(text));
  // A question ABOUT images (e.g. "how do image generators work?") is
  // never a generation request unless it also contains a direct "X of/
  // for ..." phrase, which would mean it isn't really that kind of
  // question after all.
  if (isInfoQuestion && !directImagePhrase) return false;

  if (directImagePhrase || turnIntoImage) return true;

  const hasImageNoun = IMAGE_NOUNS.some((n) => hasWord(text, n));
  const hasCreationVerb = CREATION_VERBS.some((v) => hasWord(text, v));
  const hasNonVisualObject = NON_VISUAL_OBJECTS.some((o) => hasWord(text, o));

  if (hasCreationVerb && hasImageNoun) return true;

  // Bare creation verb with no image noun and no text/code object at all
  // ("Create a futuristic city.", "Generate a cyberpunk city.") — this
  // app's own acceptance examples treat these as image requests, since
  // there's nothing else a "create a <scene>" message could mean here.
  if (hasCreationVerb && !hasNonVisualObject && !hasImageNoun) return true;

  return false;
}

// ---------------------------------------------------------------------
// Live web search intent detection
// ---------------------------------------------------------------------
// Used by src/App.tsx to decide whether a message typed into a text
// model (Neribo.chat / Neribo.chat.pro) actually needs live/current web
// data (→ route to Neribo.search) rather than being answered — or
// wrongly declined — by a model with no browsing capability. Neribo.search
// itself is never routed away: it is the destination of this redirect
// (see WEB_SEARCH_MODEL_ID in src/lib/models.ts and the isSearchIntent
// call sites in src/App.tsx, which exclude it explicitly).
//
// Same philosophy as isImageGenerationIntent above: a plain heuristic,
// not a model call, so routing happens before any request reaches the
// backend — no quota spent and no provider call for a message that was
// never going to get a useful answer from the model it landed on.

// Explicit asks to search/browse — the strongest, least ambiguous
// signal ("search the internet for X", "look this up online", "google
// it", "check online").
const EXPLICIT_SEARCH_PHRASE =
  /\b(search|look up|look for|google|browse|check)\b[\s\w'",.-]{0,25}\b(internet|web|online|google)\b/;
const LEADING_SEARCH_VERB = /^(search|look up|look for|google)\b/;

// Words signaling the answer must be current as of right now, not
// whatever the model already knows.
const CURRENT_MARKERS = [
  "current",
  "currently",
  "latest",
  "today's",
  "today",
  "right now",
  "as of today",
  "as of now",
  "up-to-date",
  "up to date",
  "real-time",
  "this week's",
  "recent news",
  "breaking news",
  "live score",
  "live update",
];

// Nouns for facts that go stale — paired with a CURRENT_MARKER above,
// this is a real-world-data question the model can't answer from
// training data alone ("today's exchange rate", "current president").
const TIME_SENSITIVE_FACTS = [
  "price",
  "rate",
  "exchange rate",
  "stock",
  "score",
  "weather",
  "forecast",
  "temperature",
  "news",
  "headline",
  "president",
  "prime minister",
  "governor",
  "ceo",
  "date",
  "time",
  "result",
  "results",
  "standings",
  "schedule",
  "release date",
  "election",
];

function hasPhrase(text: string, phrase: string): boolean {
  if (phrase.includes(" ") || phrase.includes("-") || phrase.includes("'")) {
    return text.includes(phrase);
  }
  return new RegExp(`\\b${phrase}\\b`).test(text);
}

/**
 * True if `raw` reads as a request for live/current web information —
 * either an explicit "search the web" ask, or a question about a fact
 * that goes stale (price, rate, current officeholder, etc.) combined
 * with a marker that the user wants it as of right now.
 */
export function isSearchIntent(raw: string): boolean {
  const text = raw.toLowerCase().trim();
  if (!text) return false;

  if (EXPLICIT_SEARCH_PHRASE.test(text) || LEADING_SEARCH_VERB.test(text)) {
    return true;
  }

  const hasCurrentMarker = CURRENT_MARKERS.some((m) => hasPhrase(text, m));
  const hasTimeSensitiveFact = TIME_SENSITIVE_FACTS.some((f) => hasPhrase(text, f));

  return hasCurrentMarker && hasTimeSensitiveFact;
}
