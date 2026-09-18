import { recordsToViews } from "../../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews, type CompactRecordView } from "../../shared/compactRecordViews.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import {
  hideSupersededThinkingAndSleepViews,
  isSimpleMainView,
  isSimpleRecord
} from "./records.js";
import { recordVersionFor } from "./recordVersion.js";

// Web reducers publish transcript arrays immutably. Keep the expensive
// projection local to this module and key it by that array identity plus the
// expanded batch keys; mutating an input array in place is outside this
// helper's contract.
const conversationViewCache = new WeakMap<CodexRecord[], Map<string, CompactRecordView[]>>();
const MAX_CACHED_EXPANSION_KEYS = 8;

const expansionCacheKey = (expandedToolBatchKeys: ReadonlySet<string>) =>
  JSON.stringify([...expandedToolBatchKeys].sort());

const copyConversationView = (view: CompactRecordView): CompactRecordView => ({
  ...view,
  ...(view.attachments ? { attachments: view.attachments.map((attachment) => ({ ...attachment })) } : {}),
  ...(view.usage ? { usage: { ...view.usage } } : {}),
  ...(view.subagentActivity
    ? {
        subagentActivity: {
          ...view.subagentActivity,
          ...(view.subagentActivity.assignment
            ? { assignment: { ...view.subagentActivity.assignment } }
            : {})
        }
      }
    : {}),
  ...(view.agentQuestions
    ? {
        agentQuestions: view.agentQuestions.map((question) => ({
          title: question.title,
          options: question.options ? [...question.options] : null
        }))
      }
    : {}),
  ...(view.toolBatch
    ? { toolBatch: { ...view.toolBatch, labels: [...view.toolBatch.labels] } }
    : {})
});

const copyConversationViews = (views: CompactRecordView[]) => views.map(copyConversationView);

/** Canonical Simple-mode projection shared by rendering and visible history paging. */
export const conversationViewsFromRecords = (
  records: CodexRecord[],
  expandedToolBatchKeys: ReadonlySet<string> = new Set()
) => {
  const cacheKey = `${recordVersionFor(records)}:${expansionCacheKey(expandedToolBatchKeys)}`;
  let byExpansionKey = conversationViewCache.get(records);
  const cached = byExpansionKey?.get(cacheKey);
  if (cached) return copyConversationViews(cached);

  const views = collapseHistoricalToolBatches(
    compactToolViews(
      hideSupersededThinkingAndSleepViews(
        recordsToViews(records.filter(isSimpleRecord)).filter(isSimpleMainView)
      )
    ),
    new Set(expandedToolBatchKeys)
  );
  if (!byExpansionKey) {
    byExpansionKey = new Map();
    conversationViewCache.set(records, byExpansionKey);
  }
  if (byExpansionKey.size >= MAX_CACHED_EXPANSION_KEYS) {
    const oldestKey = byExpansionKey.keys().next().value;
    if (oldestKey !== undefined) byExpansionKey.delete(oldestKey);
  }
  byExpansionKey.set(cacheKey, views);
  return copyConversationViews(views);
};
