import { recordsToViews } from "../../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews } from "../../shared/compactRecordViews.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import {
  hideSupersededSimpleThinkingViews,
  isSimpleMainView,
  isSimpleRecord
} from "./records.js";

/** Canonical Simple-mode projection shared by rendering and visible history paging. */
export const conversationViewsFromRecords = (
  records: CodexRecord[],
  expandedToolBatchKeys: ReadonlySet<string> = new Set()
) => collapseHistoricalToolBatches(
  compactToolViews(
    hideSupersededSimpleThinkingViews(
      recordsToViews(records.filter(isSimpleRecord)).filter(isSimpleMainView)
    )
  ),
  new Set(expandedToolBatchKeys)
);
