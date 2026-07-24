import type { SetStateAction } from "react";
import type { CodexRecord } from "../shared/recordTypes.js";
import type { ThreadSummary } from "../shared/threadTypes.js";
import type {
  ApprovalPolicyDraft,
  ApprovalsReviewerDraft,
  ComposerMode,
  ModelSelection,
  OpenThreadState,
  ReasoningSelection,
  PermissionProfileDraft,
  ServiceTierSelection,
  ThreadDetail
} from "./types.js";
import { mergeRecord } from "./helpers/records.js";

type DraftAction =
  | { field: "modelDraft"; value: SetStateAction<ModelSelection> }
  | { field: "reasoningDraft"; value: SetStateAction<ReasoningSelection> }
  | { field: "serviceTierDraft"; value: SetStateAction<ServiceTierSelection> }
  | { field: "approvalPolicyDraft"; value: SetStateAction<ApprovalPolicyDraft> }
  | { field: "approvalsReviewerDraft"; value: SetStateAction<ApprovalsReviewerDraft> }
  | { field: "permissionProfileDraft"; value: SetStateAction<PermissionProfileDraft> };

export type OpenThreadAction =
  | { type: "upsert-detail"; thread: ThreadDetail }
  | { type: "merge-stream"; thread: ThreadSummary; record?: CodexRecord }
  | { type: "remove"; threadId: string }
  | { type: "reorder"; threadIds: string[] }
  | { type: "append-record"; threadId: string; record: CodexRecord }
  | { type: "set-fields"; threadId: string; fields: Partial<OpenThreadState> }
  | ({ type: "set-draft"; threadId: string } & DraftAction)
  | { type: "set-composer-mode"; threadId: string; mode: ComposerMode }
  | { type: "reset-composer-mode"; threadId: string; expected: ComposerMode }
  | { type: "add-images"; threadId: string; images: OpenThreadState["imageAttachments"] }
  | { type: "add-texts"; threadId: string; texts: OpenThreadState["textAttachments"] }
  | { type: "remove-image"; threadId: string; imageId: string }
  | { type: "remove-text"; threadId: string; textId: string }
  | { type: "clear-attachments"; threadId: string };

const serviceTierDraftFromThread = (serviceTier: string | null | undefined) =>
  serviceTier && serviceTier !== "default" ? serviceTier : "auto";

export const openThreadStateFromDetail = (
  thread: ThreadDetail,
  existing?: OpenThreadState
): OpenThreadState => ({
  ...thread,
  composerMode: existing?.composerMode ?? "chat",
  modelDraft: existing?.modelDraft ?? thread.model ?? "auto",
  reasoningDraft: existing?.reasoningDraft ?? thread.modelReasoningEffort ?? "auto",
  serviceTierDraft: existing?.serviceTierDraft ?? serviceTierDraftFromThread(thread.serviceTier),
  approvalPolicyDraft: existing?.approvalPolicyDraft ?? "auto",
  approvalsReviewerDraft: existing?.approvalsReviewerDraft ?? "auto",
  permissionProfileDraft: existing?.permissionProfileDraft ?? null,
  imageAttachments: existing?.imageAttachments ?? [],
  textAttachments: existing?.textAttachments ?? []
});

const updateThread = (
  state: OpenThreadState[],
  threadId: string,
  update: (thread: OpenThreadState) => OpenThreadState
) => state.map((thread) => thread.threadId === threadId ? update(thread) : thread);

const resolveStateAction = <Value,>(value: SetStateAction<Value>, current: Value) =>
  typeof value === "function" ? (value as (current: Value) => Value)(current) : value;

export const openThreadReducer = (state: OpenThreadState[], action: OpenThreadAction): OpenThreadState[] => {
  if (action.type === "upsert-detail") {
    const existing = state.find((thread) => thread.threadId === action.thread.threadId);
    const next = openThreadStateFromDetail(action.thread, existing);
    return existing
      ? state.map((thread) => thread.threadId === next.threadId ? next : thread)
      : [...state, next];
  }
  if (action.type === "merge-stream") {
    return updateThread(state, action.thread.threadId, (thread) => ({
      ...thread,
      ...action.thread,
      records: action.record ? mergeRecord(thread.records, action.record) : thread.records
    }));
  }
  if (action.type === "remove") return state.filter((thread) => thread.threadId !== action.threadId);
  if (action.type === "reorder") {
    const order = new Map(action.threadIds.map((threadId, index) => [threadId, index]));
    return [...state].sort((left, right) => {
      const leftIndex = order.get(left.threadId);
      const rightIndex = order.get(right.threadId);
      if (leftIndex == null && rightIndex == null) return 0;
      if (leftIndex == null) return 1;
      if (rightIndex == null) return -1;
      return leftIndex - rightIndex;
    });
  }
  if (action.type === "append-record") {
    return updateThread(state, action.threadId, (thread) => ({ ...thread, records: [...thread.records, action.record] }));
  }
  if (action.type === "set-fields") {
    return updateThread(state, action.threadId, (thread) => ({ ...thread, ...action.fields }));
  }
  if (action.type === "set-composer-mode") {
    return updateThread(state, action.threadId, (thread) => ({ ...thread, composerMode: action.mode }));
  }
  if (action.type === "reset-composer-mode") {
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      composerMode: thread.composerMode === action.expected ? "chat" : thread.composerMode
    }));
  }
  if (action.type === "set-draft") {
    if (action.field === "modelDraft") {
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        modelDraft: resolveStateAction(action.value, thread.modelDraft)
      }));
    }
    if (action.field === "reasoningDraft") {
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        reasoningDraft: resolveStateAction(action.value, thread.reasoningDraft)
      }));
    }
    if (action.field === "serviceTierDraft") {
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        serviceTierDraft: resolveStateAction(action.value, thread.serviceTierDraft)
      }));
    }
    if (action.field === "approvalPolicyDraft") {
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        approvalPolicyDraft: resolveStateAction(action.value, thread.approvalPolicyDraft)
      }));
    }
    if (action.field === "approvalsReviewerDraft") {
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        approvalsReviewerDraft: resolveStateAction(action.value, thread.approvalsReviewerDraft)
      }));
    }
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      permissionProfileDraft: resolveStateAction(action.value, thread.permissionProfileDraft)
    }));
  }
  if (action.type === "add-images") {
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      imageAttachments: [...thread.imageAttachments, ...action.images]
    }));
  }
  if (action.type === "add-texts") {
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      textAttachments: [...thread.textAttachments, ...action.texts]
    }));
  }
  if (action.type === "remove-image") {
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      imageAttachments: thread.imageAttachments.filter((image) => image.id !== action.imageId)
    }));
  }
  if (action.type === "remove-text") {
    return updateThread(state, action.threadId, (thread) => ({
      ...thread,
      textAttachments: thread.textAttachments.filter((text) => text.id !== action.textId)
    }));
  }
  return updateThread(state, action.threadId, (thread) => ({
    ...thread,
    imageAttachments: [],
    textAttachments: []
  }));
};
