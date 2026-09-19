import type { OpenThreadPresence } from "../shared/apiContract.js";

/** 每条 WebSocket 只拥有自己的显式 tab 集合，不从 runtime 历史推断打开状态。 */
export class OpenThreadPresenceHub {
  private readonly windows = new Map<object, OpenThreadPresence[]>();
  private readonly listeners = new Set<(threads: OpenThreadPresence[]) => void>();

  set(owner: object, threads: OpenThreadPresence[]) {
    if (JSON.stringify(this.windows.get(owner)) === JSON.stringify(threads)) return;
    this.windows.set(owner, threads);
    this.publish();
  }

  remove(owner: object) {
    if (this.windows.delete(owner)) this.publish();
  }

  list(): OpenThreadPresence[] {
    const threads = new Map<string, OpenThreadPresence>();
    for (const window of this.windows.values()) {
      for (const thread of window) {
        const key = JSON.stringify([thread.machineId, thread.threadId]);
        const current = threads.get(key);
        if (!current || openedAt(thread) > openedAt(current)) threads.set(key, thread);
      }
    }
    return [...threads.values()].sort((left, right) => openedAt(right) - openedAt(left));
  }

  subscribe(listener: (threads: OpenThreadPresence[]) => void) {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.listeners.delete(listener); };
  }

  private publish() {
    const threads = this.list();
    for (const listener of this.listeners) listener(threads);
  }
}

const openedAt = (thread: Pick<OpenThreadPresence, "lastOpenedAt">) => {
  if (!thread.lastOpenedAt) return 0;
  const timestamp = Date.parse(thread.lastOpenedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};
