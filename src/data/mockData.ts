import { UserAccount, ChatThread, ProjectItem, AppSettings } from "../types";

// Sample/demo accounts, threads, and projects have been removed so the
// app starts with no pre-populated content. Real accounts come from
// Firebase Auth, real chat threads are loaded from Firestore, and
// Orders (formerly Projects) starts empty and is populated only by real
// user activity (see App.tsx). Showcase items (formerly Artifacts) are
// not seeded here at all — they're curated by the Supervisor and loaded
// from Firestore (see src/lib/showcasePersistence.ts and App.tsx).
export const INITIAL_ACCOUNTS: UserAccount[] = [];

export const INITIAL_THREADS: ChatThread[] = [];

export const INITIAL_PROJECTS: ProjectItem[] = [];

export const DEFAULT_SETTINGS: AppSettings = {
  colorMode: "Dark",
  fontStyle: "Default",
  fontSize: "Default",
  voice: "calm-female",
  notifications: false,
  privacy: true,
  sharing: true,
  capabilitiesCount: 2,
  capabilities: {
    // Premium-gated (locked for Free users, see SettingsModals.tsx)
    webGrounding: false,
    liveSearch: false,
    visualArtifact: false,
    preview: false,
    // Free
    deepResearch: true,
    multimodal: true,
    voiceMode: false,
  },
  permissions: {
    filesAndImages: false,
    notifications: "default",
  },
};
