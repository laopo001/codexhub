import { Popconfirm, Tabs } from "antd";
import { X } from "lucide-react";
import { subagentAssignmentForChild } from "../core/codexRecordView.js";
import { AppDialogs } from "./AppDialogs.js";
import { AppSidebar } from "./AppSidebar.js";
import { threadDisplayRecords } from "./appHelpers.js";
import { releaseDialogOnlyThreadAttachments } from "./helpers/subagentThreadDialog.js";
import { SubagentThreadConversation } from "./SubagentThreadConversation.js";
import { SubagentThreadDialog } from "./SubagentThreadDialog.js";
import type { OpenThreadState, SubagentThreadDialogState } from "./types.js";
import type { AppViewModel } from "./viewModel.js";
import { WorkspaceThreadConversation } from "./WorkspaceThreadConversation.js";

type AppViewProps = {
  viewModel: AppViewModel;
};

type ReadySubagentThreadDialog = SubagentThreadDialogState & {
  status: "ready";
  thread: OpenThreadState;
};

export const AppView = ({ viewModel }: AppViewProps) => {
  const { workspace, sidebar, dialogs } = viewModel;
  const {
    activeRuntime,
    activeThread,
    activeThreadIsOpen,
    authError,
    authRequired,
    authTokenDraft,
    closeThread,
    openSelectedProjectThreadPicker,
    openSubagentThread,
    openThreads,
    selectedProject,
    setAuthTokenDraft,
    setSidebarCollapsed,
    setSubagentThreadDialog,
    sidebarCollapsed,
    subagentThreadDialog,
    submitAuthToken,
    switchMachineThread,
    openThreadEmptyMessage,
    openThreadTabs
  } = workspace;
  const canAddThreadForProject = Boolean(activeRuntime?.online || selectedProject?.machineOnline);
  const activeThreadKey = activeThread && activeThreadIsOpen ? activeThread.threadId : "";
  // Never render a tab strip without a valid active conversation. Ant Tabs
  // will still choose a header when activeKey is undefined, while every item
  // below has null children; that is the Tab-only/Compose-missing failure mode.
  const showThreadTabs = Boolean(activeThreadKey);
  const subagentParentThread = subagentThreadDialog
    ? openThreads.find((thread) => thread.threadId === subagentThreadDialog.parentThreadId)
    : undefined;
  const subagentAssignment = subagentThreadDialog && subagentParentThread
    ? subagentAssignmentForChild(
        threadDisplayRecords(subagentParentThread.threadId, subagentParentThread),
        subagentThreadDialog.threadId
      ) ?? subagentThreadDialog.assignment
    : subagentThreadDialog?.assignment;
  const readySubagentThreadDialog: ReadySubagentThreadDialog | null = subagentThreadDialog?.status === "ready"
    && subagentThreadDialog.thread
    ? {
        ...subagentThreadDialog,
        status: "ready",
        thread: subagentThreadDialog.thread
      }
    : null;

  if (authRequired) {
    return (
      <main className="authShell">
        <form className="authPanel" onSubmit={submitAuthToken}>
          <div className="authPanelHeader">
            <h1>Codex Hub</h1>
            <span>Access token required</span>
          </div>
          <label>
            <span>Token</span>
            <input
              type="password"
              value={authTokenDraft}
              onChange={(event) => setAuthTokenDraft(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {authError ? <div className="authError">{authError}</div> : null}
          <button type="submit">Unlock</button>
        </form>
      </main>
    );
  }

  const sidebarToggle = (
    <button
      type="button"
      className="sidebarPanelToggle"
      onClick={() => setSidebarCollapsed((current) => !current)}
      aria-label={sidebarCollapsed ? "Show menu" : "Hide menu"}
      title={sidebarCollapsed ? "Show menu" : "Hide menu"}
    >
      {sidebarCollapsed ? "Menu" : "Hide"}
    </button>
  );

  return (
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      {!sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide menu"
        />
      ) : null}
      <AppSidebar viewModel={sidebar} />

      <section className="workspace">
        {showThreadTabs ? (
          <Tabs
            className="openThreadTabs"
            tabBarExtraContent={{ left: sidebarToggle }}
            size="small"
            type="editable-card"
            activeKey={activeThreadKey || undefined}
            locale={{ removeAriaLabel: "Close thread" }}
            items={openThreadTabs.map((item) => ({
              ...item,
              closable: true,
              closeIcon: (
                <Popconfirm
                  title="Close this thread?"
                  okText="Close"
                  cancelText="Cancel"
                  placement="bottomRight"
                  arrow={false}
                  classNames={{ root: "openThreadCloseConfirm" }}
                  onConfirm={() => void closeThread(item.key)}
                >
                  <span
                    className="openThreadTabCloseTrigger"
                    aria-hidden="true"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <X size={12} strokeWidth={2.2} />
                  </span>
                </Popconfirm>
              ),
              children: activeThread && item.key === activeThreadKey
                ? <WorkspaceThreadConversation workspace={workspace} />
                : null
            }))}
            onChange={(threadId) => void switchMachineThread(threadId)}
            onEdit={(targetKey, action) => {
              if (action === "add") {
                if (canAddThreadForProject) void openSelectedProjectThreadPicker();
                return;
              }
              if (action === "remove" && typeof targetKey === "string") {
                void closeThread(targetKey);
              }
            }}
          />
        ) : (
          <div className="empty">
            <div className="emptySidebarToggle">{sidebarToggle}</div>
            <span>{openThreadEmptyMessage}</span>
            {canAddThreadForProject ? (
              <button
                type="button"
                className="emptyActionButton"
                onClick={() => void openSelectedProjectThreadPicker()}
              >
                Add thread
              </button>
            ) : null}
          </div>
        )}
      </section>

      <AppDialogs viewModel={dialogs} />

      {subagentThreadDialog ? (
        <SubagentThreadDialog
          key={`${subagentThreadDialog.parentThreadId}:${subagentThreadDialog.threadId}`}
          dialog={subagentThreadDialog}
          assignment={subagentAssignment}
          onClose={() => {
            releaseDialogOnlyThreadAttachments(
              subagentThreadDialog,
              openThreads.map((thread) => thread.threadId)
            );
            setSubagentThreadDialog(null);
          }}
          onRetry={openSubagentThread}
        >
          {readySubagentThreadDialog ? (
            <SubagentThreadConversation
              workspace={workspace}
              dialog={readySubagentThreadDialog}
              assignment={subagentAssignment}
            />
          ) : null}
        </SubagentThreadDialog>
      ) : null}
    </main>
  );
};
