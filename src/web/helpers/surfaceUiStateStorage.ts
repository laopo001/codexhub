export type UiStateStorage = Pick<Storage, "getItem" | "setItem">;

export type UiStateStorageTarget = {
  storage: UiStateStorage;
  key: string;
};

/** Read the exact surface snapshot first, then its stable profile fallback. */
export const readSurfaceUiStateRaw = (targets: readonly UiStateStorageTarget[]) => {
  for (const target of targets) {
    try {
      const value = target.storage.getItem(target.key);
      if (value !== null) return value;
    } catch {
      // Continue when one storage area is unavailable.
    }
  }
  return null;
};

/** Keep the exact surface snapshot and stable profile fallback in sync. */
export const writeSurfaceUiStateRaw = (
  targets: readonly UiStateStorageTarget[],
  value: string
) => {
  for (const target of targets) {
    try {
      target.storage.setItem(target.key, value);
    } catch {
      // UI persistence is best-effort and must not break the application.
    }
  }
};
