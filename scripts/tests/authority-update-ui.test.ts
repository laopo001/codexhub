import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultAppSettings } from "../../src/web/appConfig.js";
import { AppDialogs } from "../../src/web/AppDialogs.js";
import { AppSidebar } from "../../src/web/AppSidebar.js";
import { createSidebarDraftStore } from "../../src/web/helpers/sidebarDrafts.js";
import type { AppDialogsViewModel, AppSidebarViewModel } from "../../src/web/viewModel.js";
import type { SystemStatus } from "../../src/web/types.js";

const systemStatus = (updateAvailable: boolean): SystemStatus => ({
  version: "0.9.0",
  authority: {
    authorityId: "authority-test",
    kind: "linux" as const,
    surfaceProtocolVersion: 2
  },
  ...(updateAvailable ? {
    authorityUpdate: {
      buildId: "build-new",
      detectedAt: new Date(0).toISOString(),
      restartable: true
    }
  } : {}),
  model: null,
  modelReasoningEffort: null,
  serviceTier: null,
  contextWindowTokens: null
});

const noop = () => undefined;

const sidebarViewModel = (updateAvailable: boolean): AppSidebarViewModel => ({
  activeProjectKey: "",
  collapsedProjectMachineKeys: [],
  deleteProject: noop,
  deletingProjectId: "",
  machines: [],
  offlineProjectsCollapsed: false,
  openingProjectKey: "",
  showProjectPicker: noop,
  projectGroups: [],
  projectScopeLocked: false,
  projectActionError: "",
  selectProject: noop,
  sidebarDraftStore: createSidebarDraftStore(),
  setOfflineProjectsCollapsed: noop,
  setSettingsDialogOpen: noop,
  setTasksDialogOpen: noop,
  systemStatus: systemStatus(updateAvailable),
  toggleProjectMachineGroup: noop,
  toggleProjectPinned: noop
});

const dialogsViewModel = (updateAvailable: boolean) => ({
  appSettings: defaultAppSettings(),
  settingsDialogOpen: true,
  tasksDialogOpen: false,
  taskFormOpen: false,
  tasks: [],
  projectList: [],
  projectScopeLocked: false,
  selectedProject: undefined,
  taskBusyId: "",
  taskError: "",
  threadModelDialogOpen: false,
  projectPicker: null,
  threadPicker: null,
  inspectMessage: null,
  imagePreview: null,
  goalDialog: null,
  threadRenameDialog: null,
  threadTabContextMenu: null,
  messageSelectionToolbar: null,
  machines: [],
  onlineMachines: [],
  modelOptions: [],
  reasoningOptions: [],
  serviceTierOptions: [],
  runtimeList: [],
  openThreads: [],
  threadOrderByMachine: {},
  sidebarDraftStore: createSidebarDraftStore(),
  petEnabled: false,
  petName: "",
  systemStatus: systemStatus(updateAvailable),
  setSettingsDialogOpen: noop,
  setAppSettings: noop
}) as unknown as AppDialogsViewModel;

test("Settings button exposes a red update indicator only when an authority build is available", () => {
  const current = renderToStaticMarkup(createElement(AppSidebar, { viewModel: sidebarViewModel(false) }));
  const update = renderToStaticMarkup(createElement(AppSidebar, { viewModel: sidebarViewModel(true) }));
  assert.doesNotMatch(current, /sidebarSettingsUpdateDot/);
  assert.match(update, /sidebarSettingsButton has-update/);
  assert.match(update, /sidebarSettingsUpdateDot/);
  assert.match(update, /aria-label="Open settings, update available"/);
});

test("Settings separates frontend reload from authority restart and marks updates", () => {
  const current = renderToStaticMarkup(createElement(AppDialogs, { viewModel: dialogsViewModel(false) }));
  const update = renderToStaticMarkup(createElement(AppDialogs, { viewModel: dialogsViewModel(true) }));
  assert.match(current, />Reload frontend</);
  assert.match(current, /The authority, Codex runtime, and other windows keep running/);
  assert.match(current, />Restart authority and frontends</);
  assert.match(current, />Restart all</);
  assert.doesNotMatch(current, /Update and restart all/);
  assert.match(update, />Reload frontend</);
  assert.match(update, />Update authority and frontends</);
  assert.match(update, />Update and restart all</);
  assert.match(update, /A new CodexHub build is ready/);
});

test("Settings does not offer an unsafe surface-only update", () => {
  const status = systemStatus(true);
  status.authorityUpdate = {
    buildId: "surface-only",
    detectedAt: new Date(0).toISOString(),
    restartable: false,
    reason: "surface-build-not-verified"
  };
  const viewModel = dialogsViewModel(false);
  viewModel.systemStatus = status;
  const markup = renderToStaticMarkup(createElement(AppDialogs, { viewModel }));
  assert.match(markup, /Update unavailable/);
  assert.match(markup, /has not verified its service and frontend files/);
  assert.match(markup, /disabled/);
});
