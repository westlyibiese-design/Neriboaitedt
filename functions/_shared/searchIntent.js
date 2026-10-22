// Server-side port of src/lib/intentDetection.ts's isSearchIntent.
//
// NOTE: nothing in functions/ imports this file right now — search is
// its own standalone feature (functions/api/search/query.js and
// functions/api/search/query-pro.js) and no chat request triggers a
// search on the server. It is kept only as a plain-JS mirror of the
// client heuristic in case a server-side check is ever needed again.
//
// Kept as a plain JS port rather than importing the .ts file directly:
// Cloudflare Pages Functions in this project run the functions/ tree
// as-is with no build/transpile step, so a .ts import would fail here
// even though it works fine in the Vite-bundled frontend. If you change
// the heuristic, update BOTH this file and src/lib/intentDetection.ts.
//
// Deliberately a conservative heuristic: an explicit "search the web for
// X" ask, or a time-sensitive fact (price, score, current officeholder,
// etc.) paired with a marker that the user wants it as of right now.
// Anything else (regular chat, coding, creative writing, "what's the
// capital of France") is not treated as a search request.

const EXPLICIT_SEARCH_PHRASE =
  /\b(search|look up|look for|google|browse|check)\b[\s\w'",.-]{0,25}\b(internet|web|online|google)\b/;
const LEADING_SEARCH_VERB = /^(search|look up|look for|google)\b/;

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

function hasPhrase(text, phrase) {
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
export function isSearchIntent(raw) {
  const text = (raw || "").toLowerCase().trim();
  if (!text) return false;

  if (EXPLICIT_SEARCH_PHRASE.test(text) || LEADING_SEARCH_VERB.test(text)) {
    return true;
  }

  const hasCurrentMarker = CURRENT_MARKERS.some((m) => hasPhrase(text, m));
  const hasTimeSensitiveFact = TIME_SENSITIVE_FACTS.some((f) => hasPhrase(text, f));

  return hasCurrentMarker && hasTimeSensitiveFact;
}
