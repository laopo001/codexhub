import type { OpenThreadPresence } from "../../shared/apiContract.js";
import type { MachineSummary, OpenThreadState } from "../types.js";

export type SidebarOpenThreadItem = {
  thread: Pick<OpenThreadState, "threadId" | "title" | "workingDirectory" | "lastOpenedAt"> & { runtime: { machineId: string }; projectTarget?: OpenThreadPresence["projectTarget"] };
  machineLabel: string;
  machineType?: MachineSummary["type"];
};

const timestamp = (value: string | undefined) => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const withLatestOpenedAt = (
  thread: SidebarOpenThreadItem["thread"],
  other: Pick<SidebarOpenThreadItem["thread"], "lastOpenedAt">
): SidebarOpenThreadItem["thread"] => {
  const latest = timestamp(other.lastOpenedAt) > timestamp(thread.lastOpenedAt)
    ? other.lastOpenedAt
    : thread.lastOpenedAt;
  return latest && latest !== thread.lastOpenedAt ? { ...thread, lastOpenedAt: latest } : thread;
};

export const sidebarOpenThreadItems = (
  openThreads: readonly OpenThreadState[],
  machines: readonly MachineSummary[],
  authorityThreads: readonly OpenThreadPresence[] = []
): SidebarOpenThreadItem[] => {
  const machinesById = new Map(machines.map((machine) => [machine.machineId, machine]));
  const threads = new Map<string, SidebarOpenThreadItem["thread"]>();
  for (const entry of authorityThreads) {
    const key = JSON.stringify([entry.machineId, entry.threadId]);
    const next: SidebarOpenThreadItem["thread"] = {
      ...entry, title: entry.title ?? "", runtime: { machineId: entry.machineId }
    };
    threads.set(key, threads.has(key) ? withLatestOpenedAt(threads.get(key)!, next) : next);
  }
  for (const thread of openThreads) {
    if (!thread.runtime.machineId) continue;
    const key = JSON.stringify([thread.runtime.machineId, thread.threadId]);
    // 本窗口已经打开的 tab 保留本窗口的 project 来源，不继承其他窗口的 target。
    const next: SidebarOpenThreadItem["thread"] = { ...thread, runtime: { machineId: thread.runtime.machineId } };
    threads.set(key, threads.has(key) ? withLatestOpenedAt(next, threads.get(key)!) : next);
  }
  return [...threads.values()].map((thread) => {
    const machineId = thread.runtime.machineId;
    const machine = machineId ? machinesById.get(machineId) : undefined;
    return {
      thread,
      machineLabel: machine?.name ?? machine?.hostname ?? machineId ?? "Unknown machine",
      machineType: machine?.type
    };
  }).sort((left, right) => timestamp(right.thread.lastOpenedAt) - timestamp(left.thread.lastOpenedAt));
};
