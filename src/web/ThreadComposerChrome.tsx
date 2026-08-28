import React from "react";
import {
  FileCode,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Plus,
  Target,
  type LucideIcon
} from "lucide-react";
import {
  threadGranularApprovalKeys,
  type ThreadSandboxPolicy
} from "../shared/usageTypes.js";
import { approvalPolicyOptions, approvalsReviewerOptions, composerModeOptions } from "./appConfig.js";
import {
  approvalPolicyKind,
  defaultGranularApprovalPolicy,
  permissionProfileLabel,
  permissionProfileScopeKey,
  updateGranularApprovalPolicy
} from "./appHelpers.js";
import type { OpenThreadState } from "./types.js";
import type { AppWorkspaceViewModel } from "./viewModel.js";

const composerModeIconByValue: Record<OpenThreadState["composerMode"], LucideIcon> = {
  chat: MessageCircle,
  plan: ListChecks,
  goal: Target
};

const sandboxPolicyLabel = (policy: ThreadSandboxPolicy) => {
  if (policy.type === "dangerFullAccess") return "Danger Full Access";
  if (policy.type === "readOnly") return "Read Only";
  if (policy.type === "workspaceWrite") return "Workspace";
  return "External Sandbox";
};

const useDismissableMenu = (
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
) => {
  React.useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open, setOpen]);
};

export const ThreadComposerLeftActions = ({
  workspace,
  thread,
  fileInputRef
}: {
  workspace: AppWorkspaceViewModel;
  thread: OpenThreadState;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  useDismissableMenu(menuOpen, setMenuOpen);

  const approvalPolicySelection = thread.approvalPolicyDraft === "auto"
    ? thread.approvalPolicy
    : thread.approvalPolicyDraft;
  const approvalPolicySelectionKind = approvalPolicyKind(approvalPolicySelection);
  const approvalsReviewerSelection = thread.approvalsReviewerDraft === "auto"
    ? thread.approvalsReviewer
    : thread.approvalsReviewerDraft;
  const permissionProfileSelection = thread.permissionProfileDraft
    ?? thread.activePermissionProfile?.id
    ?? thread.permissions;
  const granularApprovalPolicy = approvalPolicySelection
    && typeof approvalPolicySelection === "object"
    ? approvalPolicySelection
    : defaultGranularApprovalPolicy();
  const sandboxProfileLabel = thread.sandboxPolicy
    ? sandboxPolicyLabel(thread.sandboxPolicy)
    : undefined;
  const permissionScopeKey = thread.runtime.machineId && thread.workingDirectory
    ? permissionProfileScopeKey(thread.runtime.machineId, thread.workingDirectory)
    : "";
  const permissionCatalog = permissionScopeKey
    ? workspace.permissionProfilesByScope[permissionScopeKey]
    : undefined;
  const permissionProfiles = permissionCatalog?.status === "ready"
    ? permissionCatalog.profiles
    : [];
  const permissionProfilesStatus: "unavailable" | "idle" | "loading" | "ready" | "error" = thread.runtime.online
    && thread.runtime.machineId
    ? permissionCatalog?.status ?? "idle"
    : "unavailable";
  const permissionProfilesError = permissionCatalog?.status === "error"
    ? permissionCatalog.error ?? "Permission profiles unavailable."
    : "";
  const permissionProfileUiSelection = permissionProfileSelection
    ?? (sandboxProfileLabel
      ? permissionProfiles.find((profile) =>
        permissionProfileLabel(profile.id).toLowerCase() === sandboxProfileLabel.toLowerCase()
      )?.id
      : undefined);
  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    workspace.setThreadApprovalPolicyDraft(thread.threadId, "auto");
    workspace.setThreadApprovalsReviewerDraft(thread.threadId, "auto");
    workspace.setThreadPermissionProfileDraft(thread.threadId, null);
    setMenuOpen(true);
  };

  return (
    <>
      <div className="composerMenuHost" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="composerIconButton"
          aria-label="Open composer menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
        >
          <Plus className="composerButtonIcon" size={15} strokeWidth={2.4} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="composerMenu" role="menu">
            <button
              type="button"
              className="composerMenuItem"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <span className="composerMenuIcon" aria-hidden="true">
                <Paperclip size={14} strokeWidth={2.2} />
              </span>
              <span>添加照片和文件</span>
            </button>
            <button
              type="button"
              className="composerMenuItem"
              role="menuitem"
              disabled={thread.running}
              title={thread.running
                ? "Stop the running turn before starting a review"
                : "Review uncommitted changes in this thread"}
              onClick={() => {
                setMenuOpen(false);
                void workspace.reviewThread(thread.threadId);
              }}
            >
              <span className="composerMenuIcon" aria-hidden="true">
                <FileCode size={14} strokeWidth={2.2} />
              </span>
              <span>Review changes</span>
            </button>
            <div className="composerMenuGroup" role="group" aria-label="Approval policy">
              <div className="composerMenuGroupLabel">Approval policy</div>
              <div className="composerMenuChoiceGrid">
                {approvalPolicyOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`composerMenuChoice${approvalPolicySelectionKind === option.value ? " active" : ""}`}
                    role="menuitemradio"
                    aria-checked={approvalPolicySelectionKind === option.value}
                    onClick={() => workspace.setThreadApprovalPolicyDraft(
                      thread.threadId,
                      option.value === "granular" ? granularApprovalPolicy : option.value
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {approvalPolicySelectionKind === "granular" ? (
                <div className="composerGranularGrid">
                  {threadGranularApprovalKeys.map((key) => {
                    const enabled = granularApprovalPolicy.granular[key];
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`composerMenuToggle${enabled ? " active" : ""}`}
                        role="checkbox"
                        aria-checked={enabled}
                        onClick={() => workspace.setThreadApprovalPolicyDraft(
                          thread.threadId,
                          (current) => updateGranularApprovalPolicy(
                            current === "auto" ? granularApprovalPolicy : current,
                            key,
                            !enabled
                          )
                        )}
                      >
                        <span>{permissionProfileLabel(key)}</span>
                        <span aria-hidden="true">{enabled ? "On" : "Off"}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <div className="composerMenuGroup" role="group" aria-label="Approval reviewer">
              <div className="composerMenuGroupLabel">Approval reviewer</div>
              <div className="composerMenuChoiceGrid">
                {approvalsReviewerOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`composerMenuChoice${approvalsReviewerSelection === option.value ? " active" : ""}`}
                    role="menuitemradio"
                    aria-checked={approvalsReviewerSelection === option.value}
                    onClick={() => workspace.setThreadApprovalsReviewerDraft(thread.threadId, option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="composerMenuGroup" role="group" aria-label="Permission profile">
              <div className="composerMenuGroupLabel">Permissions</div>
              <div className="composerPermissionProfileList">
                {permissionProfilesStatus === "idle" || permissionProfilesStatus === "loading" ? (
                  <div className="composerMenuNotice">Loading permission profiles…</div>
                ) : null}
                {permissionProfilesStatus === "error" ? (
                  <div className="composerMenuNotice error">{permissionProfilesError}</div>
                ) : null}
                {permissionProfilesStatus === "unavailable" ? (
                  <div className="composerMenuNotice">Permission profiles require an online runtime.</div>
                ) : null}
                {permissionProfilesStatus === "ready" && permissionProfiles.length === 0 ? (
                  <div className="composerMenuNotice">No permission profiles are available.</div>
                ) : null}
                {permissionProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`composerMenuChoice${permissionProfileUiSelection === profile.id ? " active" : ""}`}
                    role="menuitemradio"
                    aria-checked={permissionProfileUiSelection === profile.id}
                    disabled={!profile.allowed}
                    title={profile.description || profile.id}
                    onClick={() => workspace.setThreadPermissionProfileDraft(thread.threadId, profile.id)}
                  >
                    {permissionProfileLabel(profile.id)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div className="composerModeSegmented" role="radiogroup" aria-label="Composer mode">
        {composerModeOptions.map((option) => {
          const ModeIcon = composerModeIconByValue[option.value];
          return (
            <button
              key={option.value}
              type="button"
              className={`composerModeOption${thread.composerMode === option.value ? " active" : ""}`}
              role="radio"
              aria-checked={thread.composerMode === option.value}
              aria-label={option.label}
              title={option.label}
              onClick={() => workspace.setThreadComposerMode(thread.threadId, option.value)}
            >
              <ModeIcon className="composerModeIcon" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </>
  );
};

export const ThreadComposerRightActions = ({
  workspace,
  thread
}: {
  workspace: AppWorkspaceViewModel;
  thread: OpenThreadState;
}) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  useDismissableMenu(menuOpen, setMenuOpen);

  return (
    <>
      {workspace.renderComposerThreadControls(thread, "inline", () => setMenuOpen(false))}
      <div className="composerSessionMenuHost" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="composerMoreButton"
          aria-label="Show thread usage and model"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal className="composerButtonIcon" size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="composerSessionPopover">
            {workspace.renderComposerThreadControls(thread, "popover", () => setMenuOpen(false))}
          </div>
        ) : null}
      </div>
    </>
  );
};
