import React from "react";
import { AppSettings, OperationsSection, ShowcaseItem } from "../types";
import { DashboardPanel } from "./operations/DashboardPanel";
import { OperationsUsersPanel } from "./OperationsUsersPanel";
import { ConversationsPanel } from "./operations/ConversationsPanel";
import { FeedbackPanel } from "./operations/FeedbackPanel";
import { EventsPanel } from "./operations/EventsPanel";
import { DeletedPanel } from "./operations/DeletedPanel";
import { ActionsPanel } from "./operations/ActionsPanel";
import { AppSettingsPanel } from "./operations/AppSettingsPanel";
import { AiModelPanel } from "./operations/AiModelPanel";
import { SystemConsolePanel } from "./operations/system-console/SystemConsolePanel";
import { DeviceSettingsPanel } from "./operations/DeviceSettingsPanel";
import { ShowcaseManagementPanel } from "./operations/ShowcaseManagementPanel";
import { OrdersManagementPanel } from "./operations/OrdersManagementPanel";
import { ChatNeriboPanel } from "./operations/ChatNeriboPanel";
import { DomainsManagementPanel } from "./operations/DomainsManagementPanel";

interface OperationsViewProps {
  // Whether the signed-in account holds the Supervisor role. Passed down
  // from App.tsx's own useIsOperations() call instead of this component
  // reading the role a second time itself — App.tsx already gates
  // whether this component renders at all behind that same check (see
  // its `operationsLoading` boot gate and the `isOperations &&` guard
  // around <OperationsView>), so re-deriving it here just meant redoing
  // the same async Firestore read and briefly showing its own "Checking
  // access…" state right after the boot animation finished, even though
  // the answer was already known. One source of truth now.
  isOperations: boolean;
  section: OperationsSection;
  onNavigate: (section: OperationsSection) => void;
  // Threaded through only for the "deviceSettings" page (Appearance /
  // Notifications live in the same AppSettings/localStorage state the
  // regular chat Settings page already reads and writes — see App.tsx).
  // No other Operations page touches this app-shell state.
  settings: AppSettings;
  onUpdateSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  // Threaded through only for the "showcaseManagement" page — App.tsx owns
  // loading the full (active + inactive) Showcase list for a Supervisor
  // and passes it down, the same way `settings` above is owned there.
  // null = still loading.
  showcaseItems: ShowcaseItem[] | null;
  showcaseLoadError: string;
  onShowcaseItemSaved: (item: ShowcaseItem) => void;
}

/**
 * Container for the Neribo Operations dashboard. Page-level navigation
 * (which of the five pages is showing) now lives in the sidebar
 * (see src/components/OperationsSidebar.tsx) and in App.tsx's
 * `operationsSection` state — this component just renders whichever page
 * `section` names. It previously owned that navigation itself via an
 * internal tab strip; that's gone now that the sidebar shows every page
 * as its own nav item the way the rest of the app's sidebar does, which
 * also makes adding a future page (another entry in OPERATIONS_NAV plus
 * a case below) a much smaller change than adding another tab used to be.
 *
 * Still gated on isOperations (see the prop doc above): a non-Operations
 * account never sees or fetches anything here — this is a client-side
 * courtesy only, the real enforcement is the
 * isSupervisor() check inside firestore.rules (for the conversations/
 * feedback/events/deletedMessages/deletedAccounts reads) and the `operations` claim check inside
 * functions/api/admin/list-users.js and set-quota-bonus.js (for Users).
 */
export const OperationsView: React.FC<OperationsViewProps> = ({
  isOperations,
  section,
  onNavigate,
  settings,
  onUpdateSettings,
  showcaseItems,
  showcaseLoadError,
  onShowcaseItemSaved,
}) => {
  // Defensive only — every current caller (App.tsx) already withholds this
  // component until its own role check resolves `true`, so this should
  // never actually render in practice. Kept so a future caller that
  // forgets that gate fails safe instead of flashing Operations content.
  if (!isOperations) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--fg-1)]">
        You don't have access to this page.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {section === "dashboard" && <DashboardPanel onNavigate={onNavigate} />}
      {section === "users" && <OperationsUsersPanel />}
      {section === "conversations" && <ConversationsPanel />}
      {section === "feedback" && <FeedbackPanel />}
      {section === "events" && <EventsPanel />}
      {section === "deleted" && <DeletedPanel />}
      {section === "showcaseManagement" && (
        <ShowcaseManagementPanel
          items={showcaseItems}
          loadError={showcaseLoadError}
          onItemSaved={onShowcaseItemSaved}
        />
      )}
      {/* Reads every user's orders itself (its own live query) — no data is
          threaded down from App.tsx, unlike showcaseManagement above. */}
      {section === "ordersManagement" && <OrdersManagementPanel />}
      {/* Phase 7: one-way messaging to users. Keeps working while the sitewide
          "Chat Neribo enabled" switch is off (messages queue for later). */}
      {section === "chatNeribo" && <ChatNeriboPanel />}
      {/* Phase 8: reads every user's domain requests itself (its own live
          query), same as ordersManagement above. Keeps working while the
          sitewide "Domains enabled" switch is off — that switch only hides
          the regular-user nav item. */}
      {section === "domainsManagement" && <DomainsManagementPanel />}
      {section === "actions" && <ActionsPanel />}
      {section === "appSettings" && <AppSettingsPanel />}
      {section === "aiModel" && <AiModelPanel />}
      {section === "systemConsole" && <SystemConsolePanel />}
      {section === "deviceSettings" && (
        <DeviceSettingsPanel settings={settings} onUpdateSettings={onUpdateSettings} />
      )}
    </div>
  );
};
