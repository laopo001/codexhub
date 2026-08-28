import { useSyncExternalStore } from "react";
import { browserId, formatDate } from "./common.js";

export type ComposerInputHistoryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

export const COMPOSER_INPUT_HISTORY_STORAGE_KEY = "codexhub-composer-input-history-v1";
export const COMPOSER_INPUT_HISTORY_MAX_ENTRIES = 100;

export const parseComposerInputHistory = (raw: unknown): ComposerInputHistoryEntry[] => {
  if (!raw) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const seenTrimmedTexts = new Set<string>();
  const seenIds = new Set<string>();
  const validEntries: ComposerInputHistoryEntry[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string") continue;
    const text = record.text;
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (seenTrimmedTexts.has(trimmed)) continue;

    if (typeof record.id !== "string" || !record.id.trim()) continue;
    const id = record.id.trim();
    if (seenIds.has(id)) continue;
    if (typeof record.createdAt !== "string" || !record.createdAt.trim()) continue;
    const createdAt = record.createdAt.trim();
    if (Number.isNaN(new Date(createdAt).getTime())) continue;

    seenTrimmedTexts.add(trimmed);
    seenIds.add(id);
    validEntries.push({ id, text, createdAt });
    if (validEntries.length >= COMPOSER_INPUT_HISTORY_MAX_ENTRIES) break;
  }

  return validEntries;
};

export const serializeComposerInputHistory = (entries: ComposerInputHistoryEntry[]): string =>
  JSON.stringify(entries);

const readStorageSafe = (key: string): string | null => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch {
    // Local storage access can fail in restricted browser contexts.
  }
  return null;
};

const writeStorageSafe = (key: string, value: string): void => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Local storage access can fail in restricted browser contexts.
  }
};

export type ComposerInputHistoryStore = {
  get: () => ComposerInputHistoryEntry[];
  record: (text: string) => void;
  delete: (id: string) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
  syncFromStorage: (raw?: string | null) => void;
};

export const createComposerInputHistoryStore = (
  initialEntries?: ComposerInputHistoryEntry[]
): ComposerInputHistoryStore => {
  let memoryEntries = parseComposerInputHistory(
    initialEntries ?? readStorageSafe(COMPOSER_INPUT_HISTORY_STORAGE_KEY)
  );
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const persist = (next: ComposerInputHistoryEntry[]) => {
    memoryEntries = next;
    writeStorageSafe(COMPOSER_INPUT_HISTORY_STORAGE_KEY, serializeComposerInputHistory(next));
    notify();
  };

  const record = (rawText: string) => {
    if (typeof rawText !== "string") return;
    const trimmed = rawText.trim();
    if (!trimmed) return;

    const newEntry: ComposerInputHistoryEntry = {
      id: browserId(),
      text: rawText,
      createdAt: new Date().toISOString()
    };

    const remaining = memoryEntries.filter((entry) => entry.text.trim() !== trimmed);
    const nextEntries = [newEntry, ...remaining].slice(0, COMPOSER_INPUT_HISTORY_MAX_ENTRIES);
    persist(nextEntries);
  };

  const deleteEntry = (id: string) => {
    if (!id) return;
    const next = memoryEntries.filter((entry) => entry.id !== id);
    if (next.length === memoryEntries.length) return;
    persist(next);
  };

  const clear = () => {
    if (!memoryEntries.length) return;
    persist([]);
  };

  const syncFromStorage = (raw?: string | null) => {
    const nextRaw = raw !== undefined ? raw : readStorageSafe(COMPOSER_INPUT_HISTORY_STORAGE_KEY);
    const incoming = parseComposerInputHistory(nextRaw);
    if (serializeComposerInputHistory(memoryEntries) === serializeComposerInputHistory(incoming)) {
      return;
    }
    memoryEntries = incoming;
    notify();
  };

  if (initialEntries === undefined && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key === COMPOSER_INPUT_HISTORY_STORAGE_KEY) {
        syncFromStorage(event.newValue);
      }
    });
  }

  return {
    get: () => memoryEntries,
    record,
    delete: deleteEntry,
    clear,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncFromStorage
  };
};

export const composerInputHistoryStore: ComposerInputHistoryStore = createComposerInputHistoryStore();

export const useComposerInputHistory = (
  store: ComposerInputHistoryStore = composerInputHistoryStore
): ComposerInputHistoryEntry[] => {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
};

export const formatComposerInputHistoryTime = (isoString: string): string => {
  return formatDate(isoString);
};
