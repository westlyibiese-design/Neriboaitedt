import React, { useState, useRef, useEffect } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import {
  Copy,
  Share2,
  Play,
  Pause,
  ThumbsUp,
  ThumbsDown,
  RotateCcw,
  Plus,
  Mic,
  MicOff,
  AudioWaveform,
  ArrowUp,
  Paperclip,
  Check,
  ChevronDown,
  Sparkles,
  FileText,
  Image as ImageIcon,
  X,
  Volume2,
  Lock,
  Search,
  ExternalLink,
} from "lucide-react";
import { ImageDownloadButton } from "./ImageDownloadButton";
import { GeneratedImage } from "./GeneratedImage";
import { ImageGenerationProgress } from "./ImageGenerationProgress";
import { SearchActivityIndicator } from "./SearchActivityIndicator";
import { ChatThread, ChatMessage, UserAccount } from "../types";
import { DEFAULT_MODEL_ID, isKnownModel, isImageGenerationModel, isSearchModel, getDisplayModels } from "../lib/models";
import { useModelDisplay } from "../hooks/useModelDisplay";
import { useToast } from "./Toast";
import { toSafeMessage } from "../lib/errorHandling";
import { saveFeedback } from "../lib/feedbackPersistence";
import { UsageSnapshot, formatResetCountdown, formatResetDayTime, isQuotaExhausted, isInGraceZone, totalAllowance } from "../lib/usage";
import { ImageUsageSnapshot, isImageQuotaExhausted } from "../lib/imageUsage";
import { VoiceKey, getVoiceOption, pickVoice, subscribeToVoices } from "../lib/ttsVoice";

interface ChatViewProps {
  thread: ChatThread;
  currentUser: UserAccount;
  onSendMessage: (
    content: string,
    model: string,
    attachment?: { name: string; content: string; kind: "text" | "image"; mimeType?: string }
  ) => Promise<void>;
  onRegenerate: () => void;
  isLoading: boolean;
  streamingMessage?: { id: string; content: string; model?: string } | null;
  // Real backend activity state (added) — see src/App.tsx's
  // searchActivity/isGeneratingImage state and src/lib/neriboApi.ts's
  // onSearchState. `searchActivity` is non-null only for the literal
  // span the backend has told us a search is genuinely in flight for
  // the current message; `isGeneratingImage` is true only for the
  // literal span an image-generation request is in flight. Both are
  // read-only here — ChatView never invents or extends either state on
  // its own.
  searchActivity?: { query: string } | null;
  isGeneratingImage?: boolean;
  onOpenVoiceMode: () => void;
  // Which of the 3 Settings > Voice personas ("bold-male" | "calm-female"
  // | "nigerian") to use when a chat message is read aloud via
  // handlePlayTTS below. Sourced from App.tsx's settings.voice, so the
  // voice you pick in Settings is the voice that actually speaks here.
  selectedVoice: VoiceKey;
  // Whether the current user is on a Pro plan. Gates the Pro models in the
  // model picker — free users who tap it get onRequirePremium instead of
  // switching to it. See src/lib/models.ts for the source of truth on
  // which models are Pro.
  isPremium: boolean;
  onRequirePremium: () => void;
  // Future-Pro voice-message pipeline hook. There is no live Pro plan or
  // voice-message backend yet, so this is never invoked today (isPremium is
  // always false — see App.tsx). Once a real Pro/payment system exists,
  // App.tsx can pass a handler here to take the recorded Blob and send it
  // through the real pipeline, without any change to the recording UI below.
  onSendVoiceMessage?: (audio: Blob, mimeType: string) => Promise<void> | void;
  // Live, server-computed usage quota for the signed-in account (see
  // src/lib/usage.ts) — read-only, for display purposes only. `null`
  // until the account's first message creates the usage document, or if
  // the live listener hasn't reported in yet; treated as "don't show a
  // number" rather than "no quota".
  usage?: UsageSnapshot | null;
  // Live, server-computed image-generation quota (Neribo.art only —
  // see src/lib/imageUsage.ts) — read-only, for display purposes only,
  // and completely separate from `usage` above. `null` until the
  // account's first image generation creates the doc, or if the live
  // listener hasn't reported in yet; treated as "don't show a number",
  // not "no quota".
  imageUsage?: ImageUsageSnapshot | null;
}

// A quick tap (existing speech-to-text) vs. a press-and-hold (real voice
// recording) are told apart by how long the Mic button stays pressed
// before release.
const LONG_PRESS_THRESHOLD_MS = 350;

function formatRecordingDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Picks the first mime type this browser's MediaRecorder actually supports,
// instead of assuming one format works everywhere (mobile Chrome, Safari,
// and desktop browsers all differ here).
function getSupportedVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

export const ChatView: React.FC<ChatViewProps> = ({
  thread,
  currentUser,
  onSendMessage,
  onRegenerate,
  isLoading,
  streamingMessage,
  searchActivity,
  isGeneratingImage,
  onOpenVoiceMode,
  selectedVoice,
  isPremium,
  onRequirePremium,
  onSendVoiceMessage,
  usage,
  imageUsage,
}) => {
  const { showToast } = useToast();

  // `used`/`limit` on the Firestore usage doc only get recomputed lazily,
  // server-side, on the next real request after resetAt passes (see
  // src/lib/usage.ts's isQuotaExhausted doc comment) — so re-derive this
  // periodically rather than only when the usage doc itself changes, or
  // the quota card would keep showing "Limit reached" past the real
  // reset instant until something else happened to re-render. A 30s tick
  // while exhausted is enough resolution for a UI card and costs nothing
  // once it clears (the interval only runs while actually exhausted).
  const [, forceQuotaRecheck] = useState(0);
  const quotaExhausted = isQuotaExhausted(usage);
  useEffect(() => {
    if (!quotaExhausted) return;
    const id = setInterval(() => forceQuotaRecheck((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [quotaExhausted]);
  const [inputText, setInputText] = useState("");
  // Falls back to the default model for a thread whose stored `model` isn't
  // one of the two real Neribo models — covers older threads saved before
  // this model system existed (they may have an old demo name like
  // "AI Pro 3.1" persisted in Firestore) so a stale name never surfaces in the
  // composer pill.
  const [selectedModel, setSelectedModel] = useState<string>(
    isKnownModel(thread.model) ? (thread.model as string) : DEFAULT_MODEL_ID
  );

  // Live Supervisor-edited name/tag/desc for each model (App Settings →
  // Models) merged onto the static NERIBO_MODELS list — see
  // src/lib/models.ts's getDisplayModels(). `id`/`pro`/`isImageModel`
  // (routing, Pro-gating, Chat↔Art classification) always come from the
  // static list either way, so this can only ever change what's shown,
  // never how a model behaves.
  const modelDisplayOverrides = useModelDisplay();
  const displayModels = getDisplayModels(modelDisplayOverrides);

  // Image-generation quota (Neribo.art only) — completely separate
  // from quotaExhausted above (see src/lib/imageUsage.ts and
  // functions/_shared/imageQuota.js). Same lazy-recompute-tick pattern:
  // the Firestore counter is only pruned server-side on the next real
  // generate call for this uid, so re-derive locally while exhausted so
  // the card clears itself once the rolling window actually frees a
  // slot, without waiting on a stale server-side counter.
  const isArtModel = isImageGenerationModel(selectedModel);
  const [, forceImageQuotaRecheck] = useState(0);
  const imageQuotaExhausted = isArtModel && isImageQuotaExhausted(imageUsage);
  useEffect(() => {
    if (!imageQuotaExhausted) return;
    const id = setInterval(() => forceImageQuotaRecheck((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [imageQuotaExhausted]);

  // Neribo.search — a free, standalone feature with its own separate
  // server-side quota (functions/_shared/searchQuota.js), never the chat
  // quota above. There's no frontend-visible search-quota counter yet
  // (the server enforces SEARCH_LIMIT_REACHED and the resulting error
  // bubble is what tells the user, same as any other search failure —
  // see src/App.tsx's handleSendMessage), so the only thing this flag
  // does here is keep the UNRELATED chat quota (quotaExhausted above)
  // from blocking search the way it does not block Neribo.art either.
  const isSearchModelSelected = isSearchModel(selectedModel);

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  // Real system voices for the selected persona (bold-male / calm-female /
  // nigerian) to be matched against when a message is read aloud. See
  // ../lib/ttsVoice — same source the Settings > Voice preview uses.
  const [ttsVoices, setTtsVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    return subscribeToVoices(setTtsVoices);
  }, []);
  const [feedbackState, setFeedbackState] = useState<{ [id: string]: "up" | "down" | null }>({});
  const [isRecording, setIsRecording] = useState(false);
  const [attachment, setAttachment] = useState<{
    name: string;
    content: string;
    kind: "text" | "image";
    mimeType?: string;
  } | null>(null);

  // --- Real voice-message recording (hold-to-record) state ---
  // 'idle': nothing happening. 'recording': mic is live, capturing audio.
  // 'review': recording stopped, temporary audio is available to play back,
  // discard, or attempt to send.
  const [voiceStage, setVoiceStage] = useState<"idle" | "recording" | "review">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [reviewAudioUrl, setReviewAudioUrl] = useState<string | null>(null);
  const [isReviewPlaying, setIsReviewPlaying] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<any>(null);
  const reviewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Recording plumbing. Refs (not state) so cleanup on unmount/thread-switch
  // always reaches the live objects rather than a stale render's closure.
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBlobRef = useRef<Blob | null>(null);
  const reviewAudioUrlRef = useRef<string | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the hold threshold has been crossed and real recording has
  // actually started — distinguishes a completed quick tap (dictation)
  // from a completed hold (voice recording) when the button is released.
  const holdTriggeredRef = useRef(false);
  // Set right after a hold-recording is stopped/cancelled so the click
  // event that follows the pointerup (browsers fire both) doesn't also
  // toggle dictation.
  const suppressNextClickRef = useRef(false);
  // Whether the user is (roughly) scrolled to the bottom already. Streamed
  // text keeps the view pinned to the bottom only while this is true, so
  // scrolling up to reread something earlier in the response doesn't get
  // fought by the stream auto-scrolling back down underneath you.
  const stickToBottomRef = useRef(true);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 120;
  };

  // Re-sync the selected model whenever the active thread changes. This
  // component stays mounted across thread switches (it isn't remounted per
  // conversation), so without this, switching from a thread on Neribo.chat.pro
  // to a thread on Neribo.chat would silently keep showing/using the Pro model —
  // breaking "model selection persists per conversation." Falls back to the
  // default for threads with no model or a stale/unknown one.
  useEffect(() => {
    setSelectedModel(isKnownModel(thread.model) ? (thread.model as string) : DEFAULT_MODEL_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  // Smooth scroll on a new message (sent, or a full reply landing) or when
  // loading starts — this is the "jump to the bottom" moment.
  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread.messages, isLoading]);

  // Keep pinned to the bottom while the response streams in. Instant (not
  // smooth) so it doesn't queue up a new animated scroll on every chunk.
  useEffect(() => {
    if (stickToBottomRef.current && streamingMessage?.content) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [streamingMessage?.content]);

  // Adjust textarea height dynamically
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [inputText]);

  // Speech Recognition setup
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInputText((prev) => (prev ? `${prev} ${transcript}` : transcript));
      };

      recognition.onerror = () => {
        setIsRecording(false);
      };

      recognition.onend = () => {
        setIsRecording(false);
      };

      speechRecognitionRef.current = recognition;
    }

    return () => {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const handleToggleVoiceRecord = () => {
    if (!speechRecognitionRef.current) {
      showToast("Speech recognition isn't supported in this browser. Please use keyboard input.", "info");
      return;
    }

    if (isRecording) {
      speechRecognitionRef.current.stop();
      setIsRecording(false);
    } else {
      try {
        speechRecognitionRef.current.start();
        setIsRecording(true);
      } catch (err) {
        showToast(toSafeMessage(err, "generic", "voice-record-start"), "error");
      }
    }
  };

  // Releases every trace of the temporary recording: revokes the object
  // URL, drops the Blob reference, stops the review <audio> element, and
  // resets recording state back to idle. Called whenever the interaction
  // ends without a successful send — discard, cancel, leaving the
  // composer/switching threads, or a blocked Free-user send attempt.
  const releaseVoiceRecording = () => {
    if (reviewAudioRef.current) {
      reviewAudioRef.current.pause();
      reviewAudioRef.current.src = "";
    }
    if (reviewAudioUrlRef.current) {
      URL.revokeObjectURL(reviewAudioUrlRef.current);
      reviewAudioUrlRef.current = null;
    }
    recordedBlobRef.current = null;
    audioChunksRef.current = [];
    setReviewAudioUrl(null);
    setIsReviewPlaying(false);
    setVoiceStage("idle");
    setRecordingSeconds(0);
  };

  // Stops any in-progress capture (mic + timer) without producing a
  // reviewable recording — used when the hold is cancelled/interrupted
  // rather than deliberately released.
  const abortActiveCapture = () => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // already stopped/invalid state — nothing to do
      }
    }
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioChunksRef.current = [];
  };

  const cancelVoiceRecording = () => {
    abortActiveCapture();
    releaseVoiceRecording();
  };

  // Runs on unmount and whenever the active thread changes ("leaving the
  // composer") — a pending or in-progress recording must never survive
  // either, per the no-storage requirement for Free users.
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      if (reviewAudioUrlRef.current) {
        URL.revokeObjectURL(reviewAudioUrlRef.current);
        reviewAudioUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // Switching to a different thread counts as leaving this recording
    // interaction — discard whatever temporary audio state exists.
    if (voiceStage !== "idle") {
      cancelVoiceRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  const startVoiceRecording = async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("Voice recording isn't supported in this browser. Please use text or dictation instead.", "info");
      holdTriggeredRef.current = false;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // The user may have already released the button while the permission
      // prompt was pending (getUserMedia can take a while, especially on
      // mobile). If the hold is no longer active, don't start recording —
      // just release the mic immediately.
      if (!holdTriggeredRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      mediaStreamRef.current = stream;

      const mimeType = getSupportedVoiceMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event: Event) => {
        const err = (event as any)?.error ?? event;
        showToast(toSafeMessage(err, "media", "voice-recorder-error"), "error");
        cancelVoiceRecording();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceStage("recording");
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
      holdTriggeredRef.current = false;
      showToast(toSafeMessage(err, "media", "voice-record-permission"), "error");
      abortActiveCapture();
      setVoiceStage("idle");
    }
  };

  // Stops the active capture and, if any audio was actually captured,
  // moves into the review stage so the user can play it back before
  // deciding whether to send or discard it.
  const stopVoiceRecordingToReview = () => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cancelVoiceRecording();
      return;
    }

    recorder.onstop = () => {
      const stream = mediaStreamRef.current;
      stream?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;

      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      if (!chunks.length) {
        // Nothing was actually captured (e.g. released instantly) — treat
        // like a cancel rather than showing an empty "recording".
        setVoiceStage("idle");
        setRecordingSeconds(0);
        return;
      }

      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      recordedBlobRef.current = blob;
      const url = URL.createObjectURL(blob);
      reviewAudioUrlRef.current = url;
      setReviewAudioUrl(url);
      setVoiceStage("review");
    };

    try {
      recorder.stop();
    } catch (err) {
      showToast(toSafeMessage(err, "media", "voice-record-stop"), "error");
      cancelVoiceRecording();
    }
    mediaRecorderRef.current = null;
  };

  const handleMicPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // A hold can only start from idle — while reviewing/sending a pending
    // recording, or while dictation is already live, the button is left to
    // its normal (single) behavior.
    if (voiceStage !== "idle" || isRecording) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture isn't available in every environment — the hold
      // still works via the timer below, it just won't survive the finger
      // sliding off the button on some browsers.
    }
    holdTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      holdTriggeredRef.current = true;
      startVoiceRecording();
    }, LONG_PRESS_THRESHOLD_MS);
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleMicPointerUp = () => {
    clearLongPressTimer();
    if (holdTriggeredRef.current) {
      holdTriggeredRef.current = false;
      suppressNextClickRef.current = true;
      stopVoiceRecordingToReview();
    }
    // If the hold never crossed the threshold, this was a quick tap — the
    // browser's native click event (below) handles dictation as before.
  };

  const handleMicPointerCancel = () => {
    clearLongPressTimer();
    if (holdTriggeredRef.current) {
      holdTriggeredRef.current = false;
      suppressNextClickRef.current = true;
      cancelVoiceRecording();
    }
  };

  const handleMicClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    handleToggleVoiceRecord();
  };

  const toggleReviewPlayback = () => {
    const audioEl = reviewAudioRef.current;
    if (!audioEl) return;
    if (isReviewPlaying) {
      audioEl.pause();
    } else {
      audioEl.play().catch((err) => {
        showToast(toSafeMessage(err, "media", "voice-review-playback"), "error");
      });
    }
  };

  // A Free user's Send attempt never uploads or persists the recording —
  // it only opens the app's existing Upgrade flow and releases the
  // temporary audio from memory. There are currently no real Pro users
  // (see onSendVoiceMessage doc above), so the Pro branch below is
  // architecture only and never runs yet.
  const handleVoiceSend = async () => {
    const blob = recordedBlobRef.current;
    const mimeType = blob?.type || "audio/webm";
    if (!isPremium || !blob) {
      releaseVoiceRecording();
      onRequirePremium();
      return;
    }
    if (onSendVoiceMessage) {
      await onSendVoiceMessage(blob, mimeType);
    }
    releaseVoiceRecording();
  };

  const handlePlayTTS = (msgId: string, text: string) => {
    if (!window.speechSynthesis) return;

    if (playingMsgId === msgId) {
      window.speechSynthesis.cancel();
      setPlayingMsgId(null);
    } else {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const option = getVoiceOption(selectedVoice);
      const voice = pickVoice(ttsVoices, option);
      if (voice) utterance.voice = voice;
      utterance.rate = option.rate;
      utterance.pitch = option.pitch;
      utterance.onend = () => setPlayingMsgId(null);
      utterance.onerror = () => setPlayingMsgId(null);
      setPlayingMsgId(msgId);
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedMsgId(id);
        setTimeout(() => setCopiedMsgId(null), 2000);
      })
      .catch((err) => {
        showToast(toSafeMessage(err, "generic", "copy-message"), "error");
      });
  };

  const handleShare = (text: string) => {
    if (navigator.share) {
      navigator.share({
        title: "Neribo Chat",
        text,
      }).catch(() => {
        // User cancelled the native share sheet — nothing to report.
      });
    } else {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("Message copied to clipboard for sharing.", "success"))
        .catch((err) => showToast(toSafeMessage(err, "share", "share-message"), "error"));
    }
  };

  const handleFeedback = (id: string, type: "up" | "down") => {
    setFeedbackState((prev) => ({
      ...prev,
      [id]: prev[id] === type ? null : type,
    }));
    // Fire-and-forget: never awaited, and saveFeedback itself never
    // throws, so this can't delay or interrupt the local UI update above.
    saveFeedback({ uid: currentUser.id, chatId: thread.id, messageId: id, type, model: thread.model });
  };

  // Max size for an attached image, read as a base64 data URL below.
  // Well under Cloudflare Pages Functions' request body limits, and
  // small enough that the eventual vision-model request stays fast.
  const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Root cause of the corrupted/garbled chat responses: this used to
    // call reader.readAsText(file) unconditionally, for every file type
    // the "+" picker allowed through (it has no `accept` restriction —
    // see the <input type="file"> below). readAsText() decodes a file's
    // raw bytes AS IF they were UTF-8/text; for a genuine text or code
    // file that's correct, but for an image (or any other binary file)
    // it produces exactly the mojibake/replacement-character garbage
    // ("�h�H(v...") that then got embedded straight into the chat
    // message and sent to the AI. Images now take a completely separate,
    // lossless path: read as a base64 data: URL (readAsDataURL) and sent
    // to the backend as a proper vision image_url part — see
    // src/App.tsx's handleSendMessage and src/lib/neriboApi.ts's
    // toBackendMessages/sendChatMessage. Every other file type keeps the
    // exact readAsText behavior this "Attach file or code" button always
    // had.
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        showToast("That image is too large to attach (max 8MB).", "error");
        e.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setAttachment({
          name: file.name,
          content: String(reader.result || ""), // data:<mime>;base64,<data>
          kind: "image",
          mimeType: file.type,
        });
      };
      reader.onerror = () => {
        showToast(toSafeMessage(reader.error, "file", "read-attachment"), "error");
      };
      reader.readAsDataURL(file);
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAttachment({
        name: file.name,
        content: String(reader.result || ""),
        kind: "text",
      });
    };
    reader.onerror = () => {
      showToast(toSafeMessage(reader.error, "file", "read-attachment"), "error");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!inputText.trim() && !attachment) || isLoading || (quotaExhausted && !isSearchModelSelected) || imageQuotaExhausted) return;

    const content = inputText.trim();
    const currentAttachment = attachment;
    stickToBottomRef.current = true;
    setInputText("");
    setAttachment(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    await onSendMessage(content, selectedModel, currentAttachment || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden bg-[var(--bg-0)]">
      {/* Messages Scroll Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-6 max-w-3xl w-full mx-auto space-y-6"
      >
        {thread.messages.map((msg, index) => {
          const isUser = msg.role === "user";
          const isFirstAiMsg = !isUser && index === 1;

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full group animate-in fade-in duration-200`}
            >
              {isUser ? (
                /* User Message Bubble - Pill/Capsule with #242426 as in screenshot */
                <div className="max-w-[85%] sm:max-w-lg flex flex-col items-end gap-2">
                  {msg.userImageUrl && (
                    <img
                      src={msg.userImageUrl}
                      alt="Attached"
                      className="max-w-full sm:max-w-xs max-h-64 rounded-2xl border border-[var(--border)] shadow-sm block object-cover"
                    />
                  )}
                  {msg.content && (
                    <div className="bg-[var(--elevated)] text-[var(--card-foreground)] px-5 py-3 rounded-2xl shadow-sm text-[15.5px] leading-relaxed">
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </div>
                  )}
                </div>
              ) : (
                /* AI Message - Left aligned, elegant serif for greetings, clean markdown for content */
                <div className="w-full max-w-2xl space-y-3">
                  {/* Neribo.search results — a plain list of raw results
                      (title, link, snippet), never a markdown chat
                      bubble. Present only on a message the search branch
                      in src/App.tsx's handleSendMessage/handleRegenerate
                      built (see src/types.ts's searchResults field) —
                      never alongside msg.imageUrl or msg.content on the
                      same message. */}
                  {msg.searchResults && (
                    <div className="space-y-2">
                      {msg.searchResults.length === 0 ? (
                        <div className="flex items-center gap-2 text-[var(--fg-1)] text-sm px-1">
                          <Search className="w-4 h-4 shrink-0" />
                          <span>No results found.</span>
                        </div>
                      ) : (
                        msg.searchResults.map((r, i) => (
                          <a
                            key={`${msg.id}-result-${i}`}
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 hover:bg-[var(--bg-3)] transition-colors"
                          >
                            <div className="flex items-center gap-1.5 text-[13px] text-[var(--fg-1)] truncate">
                              <Search className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{r.url}</span>
                            </div>
                            <div className="flex items-start gap-1.5 mt-1">
                              <span className="text-[15px] font-medium text-[var(--card-foreground)] leading-snug">
                                {r.title}
                              </span>
                              <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-1 text-[var(--fg-1)]" />
                            </div>
                            {r.snippet && (
                              <p className="text-[13.5px] text-[var(--fg-1)] leading-relaxed mt-1 line-clamp-2">
                                {r.snippet}
                              </p>
                            )}
                          </a>
                        ))
                      )}
                    </div>
                  )}
                  {msg.imageUrl && (
                    <div className="relative inline-block max-w-full sm:max-w-md">
                      <GeneratedImage
                        src={msg.imageUrl}
                        alt="AI-generated image"
                        className="max-w-full sm:max-w-md rounded-2xl border border-[var(--border)] shadow-sm"
                      />
                      <ImageDownloadButton imageUrl={msg.imageUrl} />
                    </div>
                  )}
                  <div
                    className={`${
                      isFirstAiMsg
                        ? "font-serif text-2xl sm:text-3xl text-[var(--card-foreground)] font-medium tracking-tight leading-snug"
                        : "text-[var(--card-foreground)] text-[15.5px] leading-relaxed"
                    }`}
                  >
                    {msg.content && <MarkdownRenderer content={msg.content} />}
                  </div>

                  {/* Chat ↔ Art routing suggestion — one button per
                      target model, carrying the original prompt over so
                      the user never has to retype it (see
                      src/lib/intentDetection.ts and App.tsx's
                      handleSendMessage/handleRegenerate). Pro-gated
                      targets fall back to the same upgrade prompt as the
                      model picker below instead of switching. */}
                  {msg.routeSuggestion && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {msg.routeSuggestion.targets.map((target) => {
                        const targetModel = displayModels.find((m) => m.id === target.modelId);
                        const locked = !!targetModel?.pro && !isPremium;
                        return (
                          <button
                            key={target.modelId}
                            type="button"
                            onClick={() => {
                              if (locked) {
                                onRequirePremium();
                                return;
                              }
                              setSelectedModel(target.modelId);
                              setInputText(msg.routeSuggestion!.prompt);
                              requestAnimationFrame(() => {
                                if (textareaRef.current) {
                                  textareaRef.current.style.height = "auto";
                                  textareaRef.current.style.height = `${Math.min(
                                    textareaRef.current.scrollHeight,
                                    180
                                  )}px`;
                                  textareaRef.current.focus();
                                }
                              });
                            }}
                            className="flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-full bg-[var(--elevated)] text-[var(--card-foreground)] hover:bg-[var(--border)] transition-colors"
                          >
                            {locked && <Lock className="h-3 w-3 text-[var(--muted-foreground)]" />}
                            {target.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Message Action Bar (Copy, Share, Play, Thumbs Up, Thumbs Down, Regenerate) */}
                  <div className="flex items-center gap-1 text-[var(--muted-foreground)] pt-1">
                    <button
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="p-1.5 rounded-lg hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)] transition-colors"
                      title={copiedMsgId === msg.id ? "Copied!" : "Copy response"}
                    >
                      {copiedMsgId === msg.id ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <Copy className="h-4 w-4 stroke-[1.8]" />
                      )}
                    </button>

                    <button
                      onClick={() => handleShare(msg.content)}
                      className="p-1.5 rounded-lg hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)] transition-colors"
                      title="Share message"
                    >
                      <Share2 className="h-4 w-4 stroke-[1.8]" />
                    </button>

                    <button
                      onClick={() => handlePlayTTS(msg.id, msg.content)}
                      className={`p-1.5 rounded-lg hover:bg-[var(--elevated)] transition-colors ${
                        playingMsgId === msg.id ? "text-blue-400 bg-[var(--elevated)]" : "hover:text-[var(--card-foreground)]"
                      }`}
                      title={playingMsgId === msg.id ? "Pause speech" : "Read aloud"}
                    >
                      {playingMsgId === msg.id ? (
                        <Pause className="h-4 w-4 stroke-[1.8]" />
                      ) : (
                        <Play className="h-4 w-4 stroke-[1.8]" />
                      )}
                    </button>

                    <button
                      onClick={() => handleFeedback(msg.id, "up")}
                      className={`p-1.5 rounded-lg hover:bg-[var(--elevated)] transition-colors ${
                        feedbackState[msg.id] === "up" ? "text-blue-400" : "hover:text-[var(--card-foreground)]"
                      }`}
                      title="Good response"
                    >
                      <ThumbsUp className="h-4 w-4 stroke-[1.8]" />
                    </button>

                    <button
                      onClick={() => handleFeedback(msg.id, "down")}
                      className={`p-1.5 rounded-lg hover:bg-[var(--elevated)] transition-colors ${
                        feedbackState[msg.id] === "down" ? "text-rose-400" : "hover:text-[var(--card-foreground)]"
                      }`}
                      title="Poor response"
                    >
                      <ThumbsDown className="h-4 w-4 stroke-[1.8]" />
                    </button>

                    <button
                      onClick={onRegenerate}
                      className="p-1.5 rounded-lg hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)] transition-colors"
                      title="Regenerate response"
                    >
                      <RotateCcw className="h-4 w-4 stroke-[1.8]" />
                    </button>
                  </div>

                  {/* AI Disclaimer as shown in Screenshot 1 */}
                  <p className="text-[12px] text-[var(--muted-foreground)] select-none pt-1">
                    Neribo is AI and can make mistakes. Please double-check responses.
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {/* Real backend-activity states, in priority order: an image
            generation actually in flight, then a search actually in
            flight, then the streamed reply itself once text starts
            arriving, then a plain "thinking" indicator before any of
            that has started. Only one of these is ever true at once —
            see src/App.tsx's isGeneratingImage/searchActivity state,
            which this reads directly rather than inferring locally. */}
        {isGeneratingImage ? (
          <div className="flex flex-col items-start w-full py-2">
            <ImageGenerationProgress active={isGeneratingImage} />
          </div>
        ) : isLoading ? (
          searchActivity ? (
            <SearchActivityIndicator query={searchActivity.query} />
          ) : streamingMessage?.content ? (
            <div className="flex flex-col items-start w-full">
              <div className="w-full max-w-2xl space-y-3">
                <div className="text-[var(--card-foreground)] text-[15.5px] leading-relaxed">
                  <MarkdownRenderer content={streamingMessage.content} />
                  <span className="inline-block w-[2px] h-[1em] align-middle bg-[var(--muted-foreground)] animate-pulse" />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 text-[var(--muted-foreground)] animate-pulse py-2">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="h-2 w-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-xs text-[var(--muted-foreground)]">Neribo is thinking...</span>
            </div>
          )
        ) : null}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Floating Composer Container */}
      <div className="sticky bottom-0 w-full px-3 sm:px-6 pb-4 pt-2 bg-gradient-to-t from-[var(--bg-0)] via-[var(--bg-0)]/95 to-transparent">
        <div className="max-w-2xl mx-auto">
          {/* Quota state — server-computed, read-only (see src/lib/usage.ts
              and src/lib/imageUsage.ts). Exhausted gets its own dedicated
              system-state card (never a chat bubble, never the generic
              connection-error message); otherwise a quiet heads-up line
              once close to the limit. Neribo.art has its own,
              completely separate image quota — only one of the two
              banners is ever shown, based on which model is selected. */}
          {isArtModel ? (
            imageQuotaExhausted && imageUsage ? (
              <ImageQuotaLimitCard usage={imageUsage} onUpgrade={onRequirePremium} />
            ) : (
              imageUsage &&
              imageUsage.limit - imageUsage.used <= 2 && (
                <div className="mb-2 px-3 text-xs text-[var(--muted-foreground)]">
                  {`${imageUsage.limit - imageUsage.used} of ${imageUsage.limit} images left this hour.`}
                </div>
              )
            )
          ) : isSearchModelSelected ? null : quotaExhausted && usage ? (
            <QuotaLimitCard usage={usage} onUpgrade={onRequirePremium} />
          ) : isInGraceZone(usage) && usage ? (
            <div className="mb-2 px-3 text-xs text-amber-400">
              {`You've used your ${usage.limit} included messages this ${
                usage.periodType === "weekly" ? "week" : "day"
              }. ${totalAllowance(usage) - usage.used} of ${
                totalAllowance(usage) - usage.limit
              } bonus messages left. ${formatResetCountdown(usage.resetAt)}.`}
            </div>
          ) : (
            usage &&
            usage.limit - usage.used <= 5 && (
              <div className="mb-2 px-3 text-xs text-[var(--muted-foreground)]">
                {`${usage.limit - usage.used} of ${usage.limit} messages left this ${
                  usage.periodType === "weekly" ? "week" : "day"
                }. ${formatResetCountdown(usage.resetAt)}.`}
              </div>
            )
          )}

          {/* File Attachment Chip */}
          {attachment && (
            <div className="mb-2 flex items-center justify-between px-3 py-1.5 bg-[var(--muted)] border border-[var(--border)] rounded-xl text-xs text-[var(--card-foreground)]">
              <div className="flex items-center gap-2 truncate">
                {attachment.kind === "image" ? (
                  <ImageIcon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                )}
                <span className="truncate">{attachment.name}</span>
              </div>
              <button
                onClick={() => setAttachment(null)}
                className="p-1 hover:text-rose-400"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Floating Rounded Composer Card matching screenshot */}
          <div className="relative flex flex-col bg-[var(--popover)] border border-[var(--border)] rounded-[28px] shadow-2xl p-2.5 transition-all focus-within:border-[var(--ring)]">
            {/* Input field */}
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply to Neribo..."
              rows={1}
              className="w-full resize-none bg-transparent px-3 py-1.5 text-[15px] text-[var(--card-foreground)] placeholder-[var(--placeholder)] focus:outline-none max-h-36 overflow-y-auto"
            />

            {/* Bottom bar of Composer */}
            <div className="flex items-center justify-between pt-1 px-1">
              {/* Left group: + button & Model selector pill */}
              <div className="flex items-center gap-2">
                {/* Hidden file input */}
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--elevated)] text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--card-foreground)] transition-colors"
                  title="Attach file or code"
                >
                  <Plus className="h-4 w-4 stroke-[2]" />
                </button>

                {/* Model Selector Pill.
                    Note: this button is NOT the positioning anchor for the
                    dropdown below - it's just a small pill that can sit
                    anywhere along this row. Anchoring the dropdown to it
                    directly (a fixed w-72 measured from its left edge) is
                    what let the dropdown overflow past the right edge of
                    the screen depending on where the pill happened to
                    land. The dropdown instead anchors to the composer
                    card itself (the nearest `relative` ancestor, see the
                    outer card div above), which always spans a
                    known/visible width, and its own max-width is clamped
                    to the viewport as a second safety net. */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="flex items-center gap-1 px-3 py-1 rounded-full bg-[var(--elevated)] text-[12.5px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--card-foreground)] transition-colors"
                  >
                    <span>{displayModels.find((m) => m.id === selectedModel)?.name ?? selectedModel}</span>
                    <ChevronDown className="h-3 w-3 text-[var(--muted-foreground)]" />
                  </button>

                  {/* Model Picker Dropdown */}
                  {showModelPicker && (
                    <div className="absolute bottom-full left-0 mb-2 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-2xl bg-[var(--popover)] border border-[var(--border)] p-2 shadow-2xl space-y-1 backdrop-blur-lg">
                      <div className="px-2 py-1 text-[11px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wider">
                        Select Model
                      </div>
                      {displayModels.map((m) => {
                        const locked = m.pro && !isPremium;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              if (locked) {
                                setShowModelPicker(false);
                                onRequirePremium();
                                return;
                              }
                              setSelectedModel(m.id);
                              setShowModelPicker(false);
                            }}
                            className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-colors flex flex-col gap-0.5 ${
                              selectedModel === m.id
                                ? "bg-blue-600/20 text-[var(--card-foreground)] border border-blue-500/30"
                                : locked
                                ? "hover:bg-[var(--elevated)]/60 text-[var(--muted-foreground)]"
                                : "hover:bg-[var(--elevated)]/80 text-[var(--muted-foreground)]"
                            }`}
                          >
                            <div className="flex items-center justify-between font-medium">
                              <span className="flex items-center gap-1.5">
                                {m.name}
                                {locked && <Lock className="h-3 w-3 text-[var(--muted-foreground)]" />}
                              </span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded ${
                                  m.pro
                                    ? "bg-blue-600/30 text-blue-300"
                                    : "bg-[var(--elevated)] text-[var(--muted-foreground)]"
                                }`}
                              >
                                {m.tag}
                              </span>
                            </div>
                            <span className="text-[11px] text-[var(--muted-foreground)] leading-tight">
                              {m.desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Right group: Microphone, Waveform Live Voice, Send button —
                  or, while a hold-to-record voice message is in progress or
                  pending review, the recording/review controls in its place. */}
              {voiceStage === "recording" ? (
                <div className="flex items-center gap-2 pr-1">
                  <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                  <span className="text-xs tabular-nums text-[var(--muted-foreground)] min-w-[28px]">
                    {formatRecordingDuration(recordingSeconds)}
                  </span>
                  <button
                    type="button"
                    onPointerUp={handleMicPointerUp}
                    onPointerCancel={handleMicPointerCancel}
                    style={{ touchAction: "none" }}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-600 text-white animate-pulse select-none"
                    title="Release to stop recording"
                  >
                    <Mic className="h-4 w-4 stroke-[1.8]" />
                  </button>
                </div>
              ) : voiceStage === "review" ? (
                <div className="flex items-center gap-1.5">
                  <audio
                    ref={reviewAudioRef}
                    src={reviewAudioUrl || undefined}
                    onPlay={() => setIsReviewPlaying(true)}
                    onPause={() => setIsReviewPlaying(false)}
                    onEnded={() => setIsReviewPlaying(false)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={cancelVoiceRecording}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-rose-400 transition-colors"
                    title="Discard recording"
                  >
                    <X className="h-4 w-4 stroke-[1.8]" />
                  </button>
                  <button
                    type="button"
                    onClick={toggleReviewPlayback}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--elevated)] text-[var(--card-foreground)] hover:bg-[var(--border)] transition-colors"
                    title={isReviewPlaying ? "Pause playback" : "Play recording"}
                  >
                    {isReviewPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <span className="text-xs tabular-nums text-[var(--muted-foreground)] min-w-[32px]">
                    {formatRecordingDuration(recordingSeconds)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleVoiceSend()}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md hover:opacity-90 active:scale-95 transition-all"
                    title="Send voice message"
                  >
                    <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {/* Mic: tap = existing speech-to-text dictation, hold = real
                      voice-message recording. Pointer events detect the hold;
                      the native click (fired after pointerup) still drives the
                      existing tap behavior via handleMicClick. */}
                  <button
                    type="button"
                    onClick={handleMicClick}
                    onPointerDown={handleMicPointerDown}
                    onPointerUp={handleMicPointerUp}
                    onPointerCancel={handleMicPointerCancel}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{ touchAction: "none" }}
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-all select-none ${
                      isRecording
                        ? "bg-rose-600 text-white animate-pulse"
                        : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)]"
                    }`}
                    title={isRecording ? "Stop dictation" : "Tap to dictate · Hold to record a voice message"}
                  >
                    {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4 stroke-[1.8]" />}
                  </button>

                  {/* Audio Waveform icon - Live voice mode */}
                  <button
                    type="button"
                    onClick={onOpenVoiceMode}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)] transition-colors"
                    title="Start Interactive Voice Mode"
                  >
                    <AudioWaveform className="h-4 w-4 stroke-[1.8]" />
                  </button>

                  {/* Send Button */}
                  {inputText.trim() || attachment ? (
                    <button
                      type="button"
                      onClick={() => handleSubmit()}
                      disabled={isLoading || (quotaExhausted && !isSearchModelSelected) || imageQuotaExhausted}
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md hover:opacity-90 active:scale-95 transition-all disabled:opacity-50"
                      title="Send message"
                    >
                      <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Dedicated quota-exhaustion system-state card — never a chat bubble,
 * never routed through the generic assistant/error message path. Shown
 * above the composer whenever isQuotaExhausted(usage) is true (see
 * ChatView above); disappears on its own the moment that stops being
 * true (either a live usage-doc update, or the 30s recheck tick past
 * resetAt), with no user action required.
 */
const QuotaLimitCard: React.FC<{ usage: UsageSnapshot; onUpgrade: () => void }> = ({
  usage,
  onUpgrade,
}) => {
  const { day, time } = formatResetDayTime(usage.resetAt);
  const showUpgrade = usage.plan !== "pro";

  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--popover)] px-4 py-3">
      <div>
        <p className="text-[15px] font-semibold text-[var(--card-foreground)]">Limit reached</p>
        <p className="text-xs text-[var(--muted-foreground)] leading-snug mt-0.5">
          Resets {day}
          {time ? (
            <>
              <br />
              at {time}
            </>
          ) : null}
        </p>
      </div>
      {showUpgrade && (
        <button
          type="button"
          onClick={onUpgrade}
          className="shrink-0 rounded-full bg-[var(--elevated)] px-4 py-2 text-[13px] font-semibold text-[var(--card-foreground)] hover:bg-[var(--border)] transition-colors"
        >
          Upgrade to Pro
        </button>
      )}
    </div>
  );
};

/**
 * Dedicated image-quota-exhaustion system-state card for Neribo.art —
 * mirrors QuotaLimitCard above one for one, but reads the completely
 * separate image-generation quota (src/lib/imageUsage.ts) instead of the
 * chat quota. Shown above the composer whenever imageQuotaExhausted is
 * true (see ChatView above); disappears on its own once that stops being
 * true (a live image-usage-doc update, or the 30s recheck tick past
 * resetAt — the rolling window freeing up a slot), with no user action
 * required. Reuses the same onUpgrade handler (and so the same real Pro
 * upgrade flow) as the chat quota card — no separate/fake payment path.
 */
const ImageQuotaLimitCard: React.FC<{ usage: ImageUsageSnapshot; onUpgrade: () => void }> = ({
  usage,
  onUpgrade,
}) => {
  const showUpgrade = usage.plan !== "pro";
  const planLine =
    usage.plan === "pro"
      ? "Pro users can generate up to 10 images per hour."
      : "Free users can generate up to 5 images per hour.";

  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--popover)] px-4 py-3">
      <div>
        <p className="text-[15px] font-semibold text-[var(--card-foreground)]">Image limit reached</p>
        <p className="text-xs text-[var(--muted-foreground)] leading-snug mt-0.5">
          {planLine}
          <br />
          {formatResetCountdown(usage.resetAt)}.
        </p>
      </div>
      {showUpgrade && (
        <button
          type="button"
          onClick={onUpgrade}
          className="shrink-0 rounded-full bg-[var(--elevated)] px-4 py-2 text-[13px] font-semibold text-[var(--card-foreground)] hover:bg-[var(--border)] transition-colors"
        >
          Upgrade to Pro
        </button>
      )}
    </div>
  );
};
