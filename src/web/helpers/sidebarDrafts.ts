import type { ParentRegistrationDraft, TaskDraft } from "../types.js";
import { defaultTaskDraft } from "./core.js";

export type SidebarDraftState = {
  parentRegistrationDraft: ParentRegistrationDraft;
  projectSearch: string;
  sshHostDraft: string;
  sshSearch: string;
  taskDraft: TaskDraft;
};

export type SidebarDraftUpdater<T> = T | ((current: T) => T);

export type SidebarDraftStore = {
  getSnapshot: () => SidebarDraftState;
  set: <Key extends keyof SidebarDraftState>(
    key: Key,
    update: SidebarDraftUpdater<SidebarDraftState[Key]>
  ) => void;
  subscribe: (listener: () => void) => () => void;
};

const defaultParentRegistrationDraft = (): ParentRegistrationDraft => ({
  url: "",
  machineId: "",
  name: ""
});

export const createSidebarDraftStore = (): SidebarDraftStore => {
  let state: SidebarDraftState = {
    parentRegistrationDraft: defaultParentRegistrationDraft(),
    projectSearch: "",
    sshHostDraft: "",
    sshSearch: "",
    taskDraft: defaultTaskDraft()
  };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    set: (key, update) => {
      const current = state[key];
      const next = typeof update === "function"
        ? (update as (value: typeof current) => typeof current)(current)
        : update;
      if (Object.is(current, next)) return;
      state = { ...state, [key]: next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
};
