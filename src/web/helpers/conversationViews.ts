import { recordToView, recordsToViews } from "../../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews, type CompactRecordView } from "../../shared/compactRecordViews.js";
import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import {
  hideSupersededThinkingAndSleepViews,
  isSimpleMainView,
  isSimpleRecord
} from "./records.js";
import {
  recordSourceTransitionFor,
  recordVersionFor,
  recordVersionMutationsSince,
  type RecordVersionMutation
} from "./recordVersion.js";

type CachedConversationViews = {
  version: number;
  records: CodexRecord[];
  views: CompactRecordView[];
  publicViews: CompactRecordView[];
};

type ConversationProjectionStats = {
  fullRebuilds: number;
  incrementalAppends: number;
  incrementalLiveDeltas: number;
  fullInvalidations: number;
};

// Web reducers publish transcript arrays immutably, except for the explicit
// high-frequency live-delta path. Cache by source-array identity and preserve
// the projected view objects across safe append/delta updates. The transition
// metadata is internal and never enters the ThreadDetail or HTTP contract.
const conversationViewCache = new WeakMap<CodexRecord[], Map<string, CachedConversationViews>>();
const MAX_CACHED_EXPANSION_KEYS = 8;
const conversationProjectionStats: ConversationProjectionStats = {
  fullRebuilds: 0,
  incrementalAppends: 0,
  incrementalLiveDeltas: 0,
  fullInvalidations: 0
};

const readonlyValueCache = new WeakMap<object, unknown>();
const readonlyArrayCache = new WeakMap<object, unknown>();

const expansionCacheKey = (expandedToolBatchKeys: ReadonlySet<string>) =>
  JSON.stringify([...expandedToolBatchKeys].sort());

/**
 * Projection consumers never need to mutate a view. A no-op write proxy keeps
 * the cached references safe while avoiding the old per-call deep copy. The
 * original CodexRecord reference remains intact for inspect/selection logic.
 */
const readonlyNestedValue = <T extends object>(value: T): T => {
  const cached = readonlyValueCache.get(value);
  if (cached) return cached as T;
  const proxy = new Proxy(value, {
    get: (target, property, receiver) => {
      const nested = Reflect.get(target, property, receiver);
      if (nested === null || typeof nested !== "object") return nested;
      return readonlyNestedValue(nested);
    },
    set: () => true,
    deleteProperty: () => true,
    defineProperty: () => true
  });
  readonlyValueCache.set(value, proxy);
  return proxy;
};

const readonlyView = (view: CompactRecordView): CompactRecordView => {
  const cached = readonlyValueCache.get(view);
  if (cached) return cached as CompactRecordView;
  const proxy = new Proxy(view, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver);
      // Keep the canonical record identity visible to inspect and selection
      // consumers; copyConversationView had the same record-reference shape.
      if (property === "record" || value === null || typeof value !== "object") return value;
      return readonlyNestedValue(value);
    },
    set: () => true,
    deleteProperty: () => true,
    defineProperty: () => true
  });
  readonlyValueCache.set(view, proxy);
  return proxy;
};

const readonlyViews = (views: CompactRecordView[]) => {
  const cached = readonlyArrayCache.get(views);
  if (cached) return cached as CompactRecordView[];
  const proxy = new Proxy(views, {
    set: () => true,
    deleteProperty: () => true,
    defineProperty: () => true
  });
  readonlyArrayCache.set(views, proxy);
  return proxy;
};

const fullConversationProjection = (
  records: CodexRecord[],
  expandedToolBatchKeys: ReadonlySet<string>
) => {
  const views = collapseHistoricalToolBatches(
    compactToolViews(
      hideSupersededThinkingAndSleepViews(
        recordsToViews(records.filter(isSimpleRecord)).filter(isSimpleMainView)
      )
    ),
    new Set(expandedToolBatchKeys)
  ).map(readonlyView);
  return views;
};

const isAutoHiddenView = (view: CompactRecordView) =>
  view.role === "thinking" || asRecord(view.record.payload)?.type === "sleep";

const isBatchableToolView = (view: CompactRecordView) => {
  const payload = asRecord(view.record.payload);
  return view.role === "tool" && !view.toolBatch && payload?.type !== "sleep";
};

const appendableRecordView = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  const view = recordToView(record);
  if (!view || !isSimpleMainView(view)) return null;
  const compactedView = view.role === "tool" ? compactToolViews([view])[0] : view;
  if (!compactedView) return null;

  // These are the record kinds whose view is determined by this record alone.
  // Token usage, repeated events, internal messages, goal snapshots, subagent
  // assignment joins, and function-call outputs can revise an earlier view;
  // they deliberately take the full-rebuild path.
  if (record.type === "error") return compactedView;
  if (record.type === "event_msg") {
    return payload?.type === "agent_message"
      || payload?.type === "user_message"
      || payload?.type === "plan"
      ? compactedView
      : null;
  }
  if (record.type !== "response_item") return null;
  if (payload?.type === "local_shell_call") return compactedView;
  if (payload?.type === "function_call") return compactedView;
  if (payload?.type === "message" && (payload.role === "user" || payload.role === "assistant")) return compactedView;
  return null;
};

const appendConversationViews = (
  previous: CompactRecordView[],
  records: CodexRecord[]
) => {
  const next = previous.slice();
  for (const record of records) {
    const view = appendableRecordView(record);
    if (!view) return null;

    if (isBatchableToolView(view)) {
      const previousView = next.at(-1);
      // A new tool batch changes the old latest batch from expanded records to
      // a summary. A contiguous tail batch does not, so only that case is
      // safe to append without rebuilding the collapse projection.
      if (next.some(isBatchableToolView) && (!previousView || !isBatchableToolView(previousView))) return null;
    } else {
      while (next.length && isAutoHiddenView(next.at(-1)!)) next.pop();
    }
    next.push(readonlyView(view));
  }
  return next;
};

const liveDeltaConversationViews = (
  previous: CachedConversationViews,
  records: CodexRecord[],
  mutations: Array<{ version: number; mutation?: RecordVersionMutation }>
) => {
  const mutationsForOneRecord = mutations
    .map((entry) => entry.mutation)
    .filter((mutation): mutation is RecordVersionMutation => Boolean(mutation));
  if (
    mutationsForOneRecord.length !== mutations.length
    || !mutationsForOneRecord.length
    || new Set(mutationsForOneRecord.map((mutation) => mutation.index)).size !== 1
  ) return null;

  const mutation = mutationsForOneRecord[0];
  if (mutation.index !== records.length - 1 || records[mutation.index]?.id !== mutation.recordId) return null;
  const record = records[mutation.index];
  const payload = asRecord(record?.payload);
  if (record?.type !== "response_item" || payload?.type !== "local_shell_call") return null;

  const previousView = previous.views.at(-1);
  if (!previousView || previousView.record.id !== record.id || !isBatchableToolView(previousView)) return null;
  const nextView = appendableRecordView(record);
  if (!nextView || !isBatchableToolView(nextView)) return null;

  const next = previous.views.slice();
  next[next.length - 1] = readonlyView(nextView);
  return next;
};

const cacheEntry = (
  records: CodexRecord[],
  expandedKey: string,
  views: CompactRecordView[]
): CachedConversationViews => {
  let byExpansionKey = conversationViewCache.get(records);
  if (!byExpansionKey) {
    byExpansionKey = new Map();
    conversationViewCache.set(records, byExpansionKey);
  }
  if (byExpansionKey.size >= MAX_CACHED_EXPANSION_KEYS && !byExpansionKey.has(expandedKey)) {
    const oldestKey = byExpansionKey.keys().next().value;
    if (oldestKey !== undefined) byExpansionKey.delete(oldestKey);
  }
  const entry = {
    version: recordVersionFor(records),
    records,
    views,
    publicViews: readonlyViews(views)
  } satisfies CachedConversationViews;
  byExpansionKey.set(expandedKey, entry);
  return entry;
};

const cachedEntryFor = (records: CodexRecord[], expandedKey: string) =>
  conversationViewCache.get(records)?.get(expandedKey);

const transitionRequiresFullInvalidation = (
  transition: ReturnType<typeof recordSourceTransitionFor>,
  transitionPrevious: CodexRecord[] | undefined,
  previousCached: CachedConversationViews | undefined
) => {
  if (!transition || !previousCached) return false;
  if (transition.kind === "append" && transitionPrevious === previousCached.records) return false;
  // prepend/history merges, reset-shaped source replacement, non-tail live
  // revisions, insert/reorder, and unknown merges cannot prove a stable
  // projected prefix, so they intentionally invalidate the whole projection.
  return true;
};

/** Canonical Simple-mode projection shared by rendering and visible history paging. */
export const conversationViewsFromRecords = (
  records: CodexRecord[],
  expandedToolBatchKeys: ReadonlySet<string> = new Set()
) => {
  const expandedKey = expansionCacheKey(expandedToolBatchKeys);
  const version = recordVersionFor(records);
  const cached = cachedEntryFor(records, expandedKey);
  const transition = recordSourceTransitionFor(records);
  const transitionPrevious = transition?.previous.deref();
  const transitionAlternatePrevious = transition?.alternatePrevious?.deref();
  const previousCached = cached
    ?? (transition
      ? (transitionPrevious ? cachedEntryFor(transitionPrevious, expandedKey) : undefined)
        ?? (transitionAlternatePrevious
          ? cachedEntryFor(transitionAlternatePrevious, expandedKey)
          : undefined)
      : undefined);
  if (cached?.version === version) return cached.publicViews;

  let projected: CompactRecordView[] | null = null;
  let incrementalPath: "append" | "live-delta" | null = null;

  if (cached) {
    const mutations = recordVersionMutationsSince(records, cached.version);
    if (mutations && mutations.length) {
      projected = liveDeltaConversationViews(cached, records, mutations);
      if (projected) incrementalPath = "live-delta";
    }
  }

  if (
    !projected
    && transition?.kind === "append"
    && transitionPrevious
    && previousCached
    && transitionPrevious === previousCached.records
  ) {
    const start = transition.index ?? transitionPrevious.length;
    if (start === transitionPrevious.length && records.length >= start) {
      projected = appendConversationViews(previousCached.views, records.slice(start));
      if (projected) incrementalPath = "append";
    }
  }

  if (projected) {
    if (incrementalPath === "append") conversationProjectionStats.incrementalAppends += 1;
    else conversationProjectionStats.incrementalLiveDeltas += 1;
    return cacheEntry(records, expandedKey, projected).publicViews;
  }

  if (
    previousCached
    && (
      recordVersionFor(records) !== previousCached.version
      || transitionRequiresFullInvalidation(transition, transitionPrevious, previousCached)
    )
  ) conversationProjectionStats.fullInvalidations += 1;
  conversationProjectionStats.fullRebuilds += 1;
  return cacheEntry(
    records,
    expandedKey,
    fullConversationProjection(records, expandedToolBatchKeys)
  ).publicViews;
};

// Kept local to tests/benchmarks so the production projection has no logging
// or timing side effects while its invalidation choices remain verifiable.
export const resetConversationProjectionStatsForTest = () => {
  conversationProjectionStats.fullRebuilds = 0;
  conversationProjectionStats.incrementalAppends = 0;
  conversationProjectionStats.incrementalLiveDeltas = 0;
  conversationProjectionStats.fullInvalidations = 0;
};

export const conversationProjectionStatsForTest = (): ConversationProjectionStats => ({
  ...conversationProjectionStats
});
