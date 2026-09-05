import type { OpenThreadPresence } from "../../shared/apiContract.js";
import type { MachineSummary, OpenThreadState } from "../types.js";

export type SidebarOpenThreadItem = {
  thread: Pick<OpenThreadState, "threadId" | "title" | "workingDirectory"> & { runtime: { machineId: string }; projectTarget?: OpenThreadPresence["projectTarget"] };
  machineLabel: string;
  machineType?: MachineSummary["type"];
};

export const sidebarOpenThreadItems = (
  openThreads: readonly OpenThreadState[],
  machines: readonly MachineSummary[],
  authorityThreads: readonly OpenThreadPresence[] = []
): SidebarOpenThreadItem[] => {
  const machinesById = new Map(machines.map((machine) => [machine.machineId, machine]));
  const threads = new Map<string, SidebarOpenThreadItem["thread"]>();
  for (const entry of authorityThreads) {
    threads.set(JSON.stringify([entry.machineId, entry.threadId]), {
      ...entry, title: entry.title ?? "", runtime: { machineId: entry.machineId }
    });
  }
  for (const thread of openThreads) {
    if (!thread.runtime.machineId) continue;
    const key = JSON.stringify([thread.runtime.machineId, thread.threadId]);
    // 本窗口已经打开的 tab 保留本窗口的 project 来源，不继承其他窗口的 target。
    threads.set(key, { ...thread, runtime: { machineId: thread.runtime.machineId } });
  }
  return [...threads.values()].map((thread) => {
    const machineId = thread.runtime.machineId;
    const machine = machineId ? machinesById.get(machineId) : undefined;
    return {
      thread,
      machineLabel: machine?.name ?? machine?.hostname ?? machineId ?? "Unknown machine",
      machineType: machine?.type
    };
  });
};
