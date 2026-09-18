import type { CodexRecord } from "../../shared/recordTypes.js";

export type RecordVersionMutation = {
  kind: "live-delta";
  index: number;
  recordId: string;
};

export type RecordSourceTransitionInput = {
  kind: "append" | "prepend" | "insert" | "replace" | "live-delta" | "unknown";
  previous: CodexRecord[];
  /** A source merge can be append-shaped for either input ordering. */
  alternatePrevious?: CodexRecord[];
  index?: number;
};

export type RecordSourceTransition = Omit<RecordSourceTransitionInput, "previous" | "alternatePrevious"> & {
  previous: WeakRef<CodexRecord[]>;
  alternatePrevious?: WeakRef<CodexRecord[]>;
};

type VersionState = {
  version: number;
  mutations: Array<{ version: number; mutation?: RecordVersionMutation }>;
};

const versionStates = new WeakMap<CodexRecord[], VersionState>();
const transitions = new WeakMap<CodexRecord[], RecordSourceTransition>();
const MAX_RETAINED_MUTATIONS = 64;

export const recordVersionFor = (records: CodexRecord[]) => versionStates.get(records)?.version ?? 0;

export const bumpRecordVersion = (records: CodexRecord[], mutation?: RecordVersionMutation) => {
  const state = versionStates.get(records) ?? { version: 0, mutations: [] };
  const next = state.version + 1;
  state.version = next;
  state.mutations.push({ version: next, mutation });
  if (state.mutations.length > MAX_RETAINED_MUTATIONS) state.mutations.shift();
  versionStates.set(records, state);
  return next;
};

export const recordVersionMutationsSince = (records: CodexRecord[], version: number) => {
  const state = versionStates.get(records);
  if (!state || state.version === version) return [];
  const firstRetainedVersion = state.mutations[0]?.version ?? state.version;
  if (version < firstRetainedVersion - 1) return null;
  return state.mutations.filter((entry) => entry.version > version);
};

export const markRecordSourceTransition = (
  records: CodexRecord[],
  transition: RecordSourceTransitionInput
) => {
  const { previous, alternatePrevious, ...rest } = transition;
  transitions.set(records, {
    ...rest,
    previous: new WeakRef(previous),
    ...(alternatePrevious ? { alternatePrevious: new WeakRef(alternatePrevious) } : {})
  });
};

export const recordSourceTransitionFor = (records: CodexRecord[]) => transitions.get(records);
