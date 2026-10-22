import React, { useState } from "react";
import { X, Feather, Shield, Plus, Check } from "lucide-react";
import { UserAccount } from "../types";

interface AccountSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: UserAccount[];
  currentUserId: string;
  onSelectAccount: (account: UserAccount) => void;
  onAddAccount: (name: string, email: string) => void;
}

export const AccountSelectionModal: React.FC<AccountSelectionModalProps> = ({
  isOpen,
  onClose,
  accounts,
  currentUserId,
  onSelectAccount,
  onAddAccount,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  if (!isOpen) return null;

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    onAddAccount(newName.trim(), newEmail.trim());
    setNewName("");
    setNewEmail("");
    setShowAddForm(false);
  };

  const renderAvatar = (account: UserAccount) => {
    if (account.avatarType === "icon") {
      if (account.avatarValue === "pen") {
        return (
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-sm"
            style={{ backgroundColor: account.bgColor || "#0d9488" }}
          >
            <Feather className="h-5 w-5 stroke-[2]" />
          </div>
        );
      }
      if (account.avatarValue === "shield") {
        return (
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-amber-300 shadow-sm border border-amber-400/40"
            style={{ backgroundColor: account.bgColor || "#1e1b4b" }}
          >
            <Shield className="h-5 w-5 fill-amber-400/30 stroke-[2]" />
          </div>
        );
      }
    }

    return (
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white font-semibold text-base shadow-sm"
        style={{ backgroundColor: account.bgColor || "#475569" }}
      >
        {account.avatarValue || account.name.charAt(0).toUpperCase()}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      {/* Centered Modal Card matching Screenshot 2 Left */}
      <div className="relative w-full max-w-md max-h-[90vh] bg-[var(--popover)] border border-[var(--border)] rounded-3xl p-6 sm:p-7 shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 p-2 rounded-full text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] hover:bg-[var(--elevated)] transition-colors"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="text-center space-y-1 mb-6 shrink-0">
          <h2 className="text-2xl font-semibold text-[var(--popover-foreground)] tracking-tight">
            Choose an account
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">to continue to Neribo</p>
        </div>

        {/* Scrollable list of accounts. flex-1 + min-h-0 (instead of a
            fixed max-h) lets this shrink on short/landscape viewports
            where the card's own max-h-[90vh] leaves little room, rather
            than overflowing past the bottom of the screen. */}
        {!showAddForm ? (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 -mr-1">
            {accounts.map((acc) => {
              const isSelected = acc.id === currentUserId;
              return (
                <button
                  key={acc.id}
                  onClick={() => {
                    onSelectAccount(acc);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between p-2.5 rounded-2xl transition-all text-left ${
                    isSelected
                      ? "bg-[var(--elevated)] ring-1 ring-[var(--border)]"
                      : "hover:bg-[var(--elevated)]/50"
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0 pr-2">
                    {renderAvatar(acc)}
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium text-[var(--popover-foreground)] truncate">
                        {acc.name}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)] truncate">
                        {acc.email}
                      </div>
                    </div>
                  </div>

                  {isSelected && (
                    <div className="h-5 w-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                      <Check className="h-3 w-3 text-white stroke-[3]" />
                    </div>
                  )}
                </button>
              );
            })}

            {/* Add account button */}
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full flex items-center gap-3.5 p-3 rounded-2xl hover:bg-[var(--elevated)]/50 text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] transition-colors mt-2"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--elevated)] text-[var(--muted-foreground)] border border-[var(--border)]">
                <Plus className="h-5 w-5" />
              </div>
              <span className="text-[14.5px] font-medium">Use another account</span>
            </button>
          </div>
        ) : (
          /* Add Account Form */
          <form onSubmit={handleAddSubmit} className="flex-1 min-h-0 overflow-y-auto space-y-4 pt-2 pr-1 -mr-1">
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Account Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Westly Enterprise"
                className="w-full py-2.5 px-3.5 rounded-xl bg-[var(--input)] border border-[var(--input-border)] text-[var(--input-foreground)] text-sm focus:outline-none focus:border-[var(--ring)]"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Email Address</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="e.g. westly.work@domain.com"
                className="w-full py-2.5 px-3.5 rounded-xl bg-[var(--input)] border border-[var(--input-border)] text-[var(--input-foreground)] text-sm focus:outline-none focus:border-[var(--ring)]"
                required
              />
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="flex-1 py-2.5 rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)] text-sm hover:opacity-90"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 py-2.5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-sm hover:opacity-90"
              >
                Add Account
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
