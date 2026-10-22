import { AppSettings } from "../types";

// Single source of truth for the app's 3 voice personas. Both the Voice
// settings modal (preview) and the actual chat message "read aloud"
// playback import from here, so a voice you pick in Settings is
// guaranteed to be the same voice/pitch/rate used when a message is
// actually spoken — previously ChatView had its own, separate playback
// path that never applied the selected voice at all.
export type VoiceKey = AppSettings["voice"];

export const VOICE_OPTIONS: Array<{
  key: VoiceKey;
  name: string;
  desc: string;
  pitch: number;
  rate: number;
  match: (v: SpeechSynthesisVoice) => number; // higher = better match
}> = [
  {
    key: "bold-male",
    name: "Voice 1 — Bold Male",
    desc: "Confident, direct male voice.",
    pitch: 0.85,
    rate: 1.03,
    match: (v) => {
      const n = v.name.toLowerCase();
      let score = 0;
      if (/male/.test(n) && !/female/.test(n)) score += 3;
      if (/(daniel|david|fred|guy|mark|alex)\b/.test(n)) score += 2;
      if (v.lang.startsWith("en")) score += 1;
      return score;
    },
  },
  {
    key: "calm-female",
    name: "Voice 2 — Calm Female",
    desc: "Warm, calm female voice.",
    pitch: 1.05,
    rate: 0.94,
    match: (v) => {
      const n = v.name.toLowerCase();
      let score = 0;
      if (/female/.test(n)) score += 3;
      if (/(samantha|zira|susan|karen|victoria|moira|tessa|serena)\b/.test(n)) score += 2;
      if (v.lang.startsWith("en")) score += 1;
      return score;
    },
  },
  {
    key: "nigerian",
    name: "Voice 3 — Nigerian English",
    desc: "Nigerian-accented English voice.",
    pitch: 1.0,
    rate: 1.0,
    match: (v) => {
      let score = 0;
      if (v.lang.toLowerCase() === "en-ng") score += 5;
      if (v.lang.toLowerCase().startsWith("en-ng")) score += 4;
      // No en-NG voice pack is common yet on most devices; fall back to
      // any English voice rather than silently picking something odd.
      if (v.lang.toLowerCase().startsWith("en")) score += 1;
      return score;
    },
  },
];

export function getVoiceOption(key: VoiceKey) {
  return VOICE_OPTIONS.find((o) => o.key === key) ?? VOICE_OPTIONS[0];
}

export function pickVoice(
  voices: SpeechSynthesisVoice[],
  option: (typeof VOICE_OPTIONS)[number]
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  let best = voices[0];
  let bestScore = -Infinity;
  for (const v of voices) {
    const score = option.match(v);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

// Chrome/Android loads speechSynthesis voices asynchronously and often
// returns an empty list on the very first call. This keeps one shared
// listener + cache so every caller (settings preview, chat playback)
// sees the real list as soon as it's ready, instead of each screen
// racing its own empty-array call.
let cachedVoices: SpeechSynthesisVoice[] = [];
const listeners = new Set<(voices: SpeechSynthesisVoice[]) => void>();
let initialized = false;

function refreshVoices() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  cachedVoices = window.speechSynthesis.getVoices();
  listeners.forEach((cb) => cb(cachedVoices));
}

export function subscribeToVoices(
  cb: (voices: SpeechSynthesisVoice[]) => void
): () => void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return () => {};
  }
  if (!initialized) {
    initialized = true;
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  }
  listeners.add(cb);
  cb(cachedVoices);
  return () => {
    listeners.delete(cb);
  };
}
