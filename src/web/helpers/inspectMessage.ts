import type { CompactRecordView } from "../../shared/compactRecordViews.js";
import type { InspectMessageSelection } from "../types.js";

export const resolveInspectMessage = (
  selection: InspectMessageSelection | null | undefined,
  threadId: string,
  views: CompactRecordView[]
) => {
  if (!selection || selection.threadId !== threadId) return null;
  return views.find((view) => view.record.id === selection.recordId) ?? null;
};
