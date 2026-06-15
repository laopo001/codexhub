import { asRecord } from "../../shared/recordTypes.js";

export const fileChangePreviewFiles = (payload: Record<string, unknown>) => {
  if (!Array.isArray(payload.changes)) return [];
  return payload.changes.map((change) => {
    const record = asRecord(change);
    const filePath = typeof record?.path === "string" ? record.path : "<unknown>";
    const stats = diffStats(typeof record?.diff === "string"
      ? record.diff
      : typeof record?.unified_diff === "string" ? record.unified_diff : "");
    return {
      path: filePath,
      ...stats
    };
  });
};

export const diffStats = (diffText: string): { added?: number; removed?: number } => {
  if (!diffText) return {};
  let added = 0;
  let removed = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
};
