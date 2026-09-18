import type { CodexRecord } from "../../shared/recordTypes.js";

const versions = new WeakMap<CodexRecord[], number>();

export const recordVersionFor = (records: CodexRecord[]) => versions.get(records) ?? 0;

export const bumpRecordVersion = (records: CodexRecord[]) => {
  const next = recordVersionFor(records) + 1;
  versions.set(records, next);
  return next;
};
