import { asRecord, type CodexRecord, type CodexRecordView, type RecordUsage, type SubagentActivityView } from "../shared/recordTypes.js";
import { turnIdFromAppRecordId } from "../shared/recordIdentity.js";
import { parseJsonObject, payloadDurationMs, formatMilliseconds } from "../shared/toolFormatting.js";
export type { CodexRecordView, RecordUsage } from "../shared/recordTypes.js";

export const recordsToViews = (records: CodexRecord[]): CodexRecordView[] => {
  const views: CodexRecordView[] = [];
  const subagentAssignments = subagentActivityAssignments(records);
  const goalMessageStates = new Map<string, GoalMessageState>();
  for (const record of records) {
    const usage = tokenUsageFromRecord(record);
    if (usage) {
      if (attachUsageToLatestCodexView(views, usage)) continue;
    }

    const goalProjection = goalMessageProjection(record, goalMessageStates);
    let view = withSubagentActivityAssignment(recordToView(record), subagentAssignments.get(record.id));
    if (view && goalProjection?.reconstructedStart) {
      insertViewChronologically(views, {
        ...view,
        id: goalProjection.reconstructedStart.id,
        label: "goal start",
        at: goalProjection.reconstructedStart.at
      });
    }
    if (goalProjection?.hidden) continue;
    if (!view) continue;
    if (goalProjection) view = { ...view, label: goalProjection.label };
    views.push(view);
  }
  return views;
};

export type SubagentAssignmentView = NonNullable<SubagentActivityView["assignment"]>;

export const withSubagentActivityAssignment = (
  view: CodexRecordView | null,
  assignment: SubagentAssignmentView | undefined
): CodexRecordView | null => {
  if (!view?.subagentActivity || !assignment) return view;
  return {
    ...view,
    subagentActivity: {
      ...view.subagentActivity,
      assignment
    }
  };
};

/**
 * Join the parent turn's spawnAgent item to its subAgentActivity items.
 * Both item kinds are app-server transcript records; no child transcript or private JSONL is read.
 */
export const subagentActivityAssignments = (records: CodexRecord[]) => {
  const assignmentsByTurnAndChild = new Map<string, SubagentAssignmentView>();
  const activities: Array<{ recordId: string; key: string }> = [];
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (payload?.type === "subAgentActivity") {
      const childThreadId = nonEmptyString(payload.agentThreadId);
      const scope = subagentActivityTurnScope(record);
      if (childThreadId && scope) activities.push({
        recordId: record.id,
        key: `${scope}\u0000${childThreadId}`
      });
      continue;
    }
    if (payload?.type !== "collab_agent_tool_call" || payload.tool !== "spawnAgent") continue;
    const scope = subagentActivityTurnScope(record);
    if (!scope || !Array.isArray(payload.receiver_thread_ids)) continue;
    const assignment = subagentAssignmentFromPayload(payload);
    if (!assignment) continue;
    for (const value of payload.receiver_thread_ids) {
      const childThreadId = nonEmptyString(value);
      if (!childThreadId) continue;
      const key = `${scope}\u0000${childThreadId}`;
      const current = assignmentsByTurnAndChild.get(key);
      assignmentsByTurnAndChild.set(key, {
        ...(current ?? {}),
        ...(!current?.initialMessage && assignment.initialMessage ? { initialMessage: assignment.initialMessage } : {}),
        ...(!current?.model && assignment.model ? { model: assignment.model } : {}),
        ...(!current?.reasoningEffort && assignment.reasoningEffort
          ? { reasoningEffort: assignment.reasoningEffort }
          : {})
      });
    }
  }

  const assignmentsByActivityId = new Map<string, SubagentAssignmentView>();
  for (const activity of activities) {
    const assignment = assignmentsByTurnAndChild.get(activity.key);
    if (assignment) assignmentsByActivityId.set(activity.recordId, assignment);
  }
  return assignmentsByActivityId;
};

/**
 * Resolve the parent-side spawn assignment for a child thread without copying it
 * into the child transcript. Re-evaluating this against live parent records also
 * handles activity arriving before the completed spawnAgent item.
 */
export const subagentAssignmentForChild = (
  records: CodexRecord[],
  childThreadId: string
): SubagentAssignmentView | undefined => {
  const assignments = subagentActivityAssignments(records);
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (
      payload?.type === "subAgentActivity"
      && nonEmptyString(payload.agentThreadId) === childThreadId
    ) {
      const assignment = assignments.get(record.id);
      if (assignment) return assignment;
    }
  }
  return undefined;
};

const subagentAssignmentFromPayload = (payload: Record<string, unknown>): SubagentAssignmentView | null => {
  const initialMessage = nonEmptyString(payload.prompt);
  const model = nonEmptyString(payload.model);
  const reasoningEffort = nonEmptyString(payload.reasoning_effort);
  if (!initialMessage && !model && !reasoningEffort) return null;
  return {
    ...(initialMessage ? { initialMessage } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
};

const subagentActivityTurnScope = (record: CodexRecord) => {
  const threadId = record.sourceThreadId;
  if (!threadId) return null;
  const turnId = turnIdFromAppRecordId(threadId, record.id);
  return turnId ? `${threadId}\u0000${turnId}` : null;
};

export const recordToView = (record: CodexRecord): CodexRecordView | null => {
  const payload = asRecord(record.payload);
  if (!payload) return null;

  if (record.type === "error") {
    return withRecordViewStatusDuration({
      id: record.id,
      role: "error",
      label: typeof payload.type === "string" ? payload.type : "error",
      text: typeof payload.message === "string" ? payload.message : stringify(payload),
      at: record.timestamp,
      status: "failed",
      statusText: recordViewStatusText(payload.status),
      record
    }, payload);
  }
  if (record.type === "event_msg") return withRecordViewStatusDuration(eventMessageToView(record, payload), payload);
  if (record.type === "response_item") return withRecordViewStatusDuration(responseItemToView(record, payload), payload);
  return null;
};

export const withRecordViewStatusDuration = <T extends CodexRecordView | null>(
  view: T,
  payload: Record<string, unknown>
): T => {
  if (!view) return view;
  const statusDurationMs = recordViewStatusDurationMs(payload);
  return statusDurationMs == null ? view : { ...view, statusDurationMs } as T;
};

export const subagentActivityView = (
  record: CodexRecord,
  payload: Record<string, unknown>
): CodexRecordView => {
  const kind = nonEmptyString(payload.kind) ?? "activity";
  const agentPath = nonEmptyString(payload.agentPath);
  const agentThreadId = nonEmptyString(payload.agentThreadId);
  const statusText = subagentActivityKindLabel(kind);
  const agentName = agentPath
    ? agentPath.split("/").filter(Boolean).at(-1) ?? agentPath
    : agentThreadId ?? "Subagent";
  return {
    id: record.id,
    role: "event",
    label: "subagent",
    text: `${statusText} · ${agentName}`,
    at: record.timestamp,
    statusText,
    subagentActivity: {
      kind,
      ...(agentPath ? { agentPath } : {}),
      ...(agentThreadId ? { agentThreadId } : {})
    },
    record
  };
};

export const subagentActivityKindLabel = (kind: string) => {
  const normalized = kind.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (normalized === "started") return "Started";
  // The app-server activity does not expose the interaction direction or operation.
  if (normalized === "interacted") return "Interacted";
  if (normalized === "interrupted") return "Interrupted";
  const words = normalized.split("_").filter(Boolean);
  return words.length
    ? words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ")
    : "Activity";
};

export const recordViewStatusDurationMs = (payload: Record<string, unknown>) => {
  return payloadDurationMs(payload, "duration_ms", "durationMs");
};

const eventMessageToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (payload.type === "user_message") {
    const attachments = imageAttachments(payload);
    const text = typeof payload.message === "string" ? payload.message : "";
    return {
      id: record.id,
      role: "user",
      label: "user",
      text: text || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      attachments,
      record
    };
  }

  if (payload.type === "thread_goal_updated") return threadGoalUpdatedView(record, payload);

  if (payload.type === "agent_message" && typeof payload.message === "string") {
    const phase = typeof payload.phase === "string" ? payload.phase : "assistant";
    const status = recordViewStatusFromAppStatus(payload.status);
    const statusText = recordViewStatusText(payload.status);
    const hasAgentQuestions = Array.isArray(payload.questions)
      && payload.questions.some((question) => {
        const value = asRecord(question);
        return typeof value?.title === "string" && value.title.trim().length > 0;
      });
    return {
      id: record.id,
      role: "codex",
      label: hasAgentQuestions ? "agent_question" : phase,
      text: payload.message,
      at: record.timestamp,
      status,
      statusText,
      ...(Array.isArray(payload.questions) ? { agentQuestions: payload.questions as CodexRecordView["agentQuestions"] } : {}),
      canFork: !hasAgentQuestions && phase === "final_answer" && !isActiveRecordStatus(status),
      record
    };
  }

  if (payload.type === "plan" && typeof payload.message === "string") {
    const status = recordViewStatusFromAppStatus(payload.status);
    return {
      id: record.id,
      role: "codex",
      label: "final_answer",
      text: payload.message,
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      canFork: !isActiveRecordStatus(status),
      record
    };
  }

  if (payload.type === "image_generation_end") {
    const text = [
      "Generated image",
      typeof payload.saved_path === "string" ? `Saved to: ${payload.saved_path}` : null,
      typeof payload.revised_prompt === "string" ? `Prompt: ${payload.revised_prompt}` : null
    ].filter(Boolean).join("\n");
    return text ? {
      id: record.id,
      role: "event",
      label: "image_generation_end",
      text,
      at: record.timestamp,
      record
    } : null;
  }

  if (payload.type === "context_compaction") {
    const status = contextCompactionStatus(payload);
    return {
      id: record.id,
      role: "event",
      label: "context_compaction",
      text: typeof payload.message === "string" ? payload.message : status === "completed" ? "Compaction complete" : "Compacting",
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (typeof payload.message === "string") {
    return {
      id: record.id,
      role: "event",
      label: typeof payload.type === "string" ? payload.type : "event",
      text: payload.message,
      at: record.timestamp,
      record
    };
  }

  return {
    id: record.id,
    role: "event",
    label: typeof payload.type === "string" ? payload.type : "event",
    text: stringify(payload),
    at: record.timestamp,
    record
  };
};

/** Project the public Goal state into the conversation as a user-side message. */
export const threadGoalUpdatedView = (
  record: CodexRecord,
  payload: Record<string, unknown>
): CodexRecordView | null => {
  const goal = asRecord(payload.goal);
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
  if (!objective) return null;
  return {
    id: record.id,
    role: "user",
    label: "goal",
    text: objective,
    at: record.timestamp,
    record
  };
};

type GoalMessageState = {
  objective: string;
  status: string;
  tokenBudget: number | null;
};

type GoalMessageProjection = {
  label: string;
  hidden?: boolean;
  reconstructedStart?: {
    id: string;
    at: string;
  };
};

/**
 * `thread_goal_updated` is a full Goal snapshot, not a lifecycle event name.
 * Classify its conversation label from the Goal identity and state transition,
 * while dropping snapshots that only advance usage or elapsed time.
 */
const goalMessageProjection = (
  record: CodexRecord,
  states: Map<string, GoalMessageState>
): GoalMessageProjection | null => {
  if (record.type !== "event_msg") return null;
  const payload = asRecord(record.payload);
  if (payload?.type !== "thread_goal_updated") return null;
  const goal = asRecord(payload.goal);
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
  if (!objective) return null;
  const threadId = typeof payload.threadId === "string"
    ? payload.threadId
    : typeof goal?.threadId === "string"
      ? goal.threadId
      : record.sourceThreadId ?? "";
  const createdAt = typeof goal?.createdAt === "number" && Number.isFinite(goal.createdAt)
    ? goal.createdAt
    : null;
  const status = typeof goal?.status === "string" && goal.status ? goal.status : "active";
  const tokenBudget = typeof goal?.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)
    ? goal.tokenBudget
    : null;
  const lifecycleKey = JSON.stringify([threadId, createdAt]);
  const previous = states.get(lifecycleKey);
  const current = { objective, status, tokenBudget };
  states.set(lifecycleKey, current);

  if (!previous) {
    const createdAtTimestamp = goalTimestampFromEpochSeconds(createdAt);
    return {
      label: initialGoalMessageLabel(status),
      ...(status !== "active" && createdAtTimestamp
        ? {
            reconstructedStart: {
              id: `view:goal-start:${threadId}:${createdAt}`,
              at: createdAtTimestamp
            }
          }
        : {})
    };
  }
  if (
    previous.objective === current.objective
    && previous.status === current.status
    && previous.tokenBudget === current.tokenBudget
  ) return { label: "goal update", hidden: true };
  if (previous.status !== current.status) return { label: goalStatusTransitionLabel(status) };
  return { label: "goal update" };
};

const initialGoalMessageLabel = (status: string) =>
  status === "active" ? "goal start" : goalStatusTransitionLabel(status);

const goalStatusTransitionLabel = (status: string) => {
  if (status === "complete") return "goal end";
  if (status === "active") return "goal resumed";
  if (status === "paused") return "goal paused";
  if (status === "blocked") return "goal blocked";
  if (status === "usageLimited") return "goal usage limited";
  if (status === "budgetLimited") return "goal budget limited";
  return "goal update";
};

const goalTimestampFromEpochSeconds = (value: number | null) => {
  if (value === null) return null;
  const timestamp = new Date(value * 1000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
};

/** Insert a reconstructed creation boundary without reordering existing records. */
const insertViewChronologically = (views: CodexRecordView[], view: CodexRecordView) => {
  const timestamp = view.at ? Date.parse(view.at) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    views.push(view);
    return;
  }
  const index = views.findIndex((candidate) => {
    const candidateTimestamp = candidate.at ? Date.parse(candidate.at) : Number.NaN;
    return Number.isFinite(candidateTimestamp) && candidateTimestamp > timestamp;
  });
  if (index < 0) views.push(view);
  else views.splice(index, 0, view);
};

const responseItemToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "unknown";
    const text = responseMessageText(payload);
    const attachments = imageAttachments(payload);
    if (role === "user") {
      return {
        id: record.id,
        role: "user",
        label: "user",
        text: text || (attachments.length ? "[image]" : ""),
        at: record.timestamp,
        attachments,
        record
      };
    }
    if (role === "assistant") {
      const phase = typeof payload.phase === "string" ? payload.phase : "assistant";
      const status = recordViewStatusFromAppStatus(payload.status);
      const statusText = recordViewStatusText(payload.status);
      return {
        id: record.id,
        role: "codex",
        label: phase,
        text: text || (attachments.length ? "[image]" : ""),
        at: record.timestamp,
        attachments,
        status,
        statusText,
        canFork: phase === "final_answer" && !isActiveRecordStatus(status),
        record
      };
    }
    return {
      id: record.id,
      role: "event",
      label: `message: ${role}`,
      text: responseMessageSummary(payload) || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      attachments,
      record
    };
  }

  if (payload.type === "subAgentActivity") {
    return subagentActivityView(record, payload);
  }

  if (payload.type === "reasoning") {
    const text = reasoningText(payload);
    return {
      id: record.id,
      role: "thinking",
      label: "thinking",
      text: text ?? "Reasoning",
      at: record.timestamp,
      status: recordViewStatusFromAppStatus(payload.status),
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
    return {
      id: record.id,
      role: "tool",
      label: `tool call: ${name}`,
      text: formatFunctionCall(name, args),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "local_shell_call") {
    const presentation = localShellPresentation(payload);
    return {
      id: record.id,
      role: "tool",
      label: "shell",
      text: localShellText(payload),
      at: record.timestamp,
      status: presentation.status,
      statusText: presentation.statusText,
      record
    };
  }

  if (payload.type === "sleep") {
    const status = sleepStatus(payload.status);
    const durationMs = payloadDurationMs(payload, "durationMs", "duration_ms");
    return {
      id: record.id,
      role: "tool",
      label: "sleep",
      text: sleepSummary(durationMs),
      at: record.timestamp,
      status,
      statusText: sleepStatusText(status),
      record
    };
  }

  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : stringify(payload.output);
    return {
      id: record.id,
      role: "tool",
      label: "tool result",
      text: output,
      at: record.timestamp,
      status: "completed",
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "file_change") {
    const status = recordViewStatusFromAppStatus(payload.status) ?? "completed";
    return {
      id: record.id,
      role: "tool",
      label: `file change: ${typeof payload.status === "string" ? payload.status : "completed"}`,
      text: fileChangeText(payload),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "mcp_tool_call") {
    const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
    return {
      id: record.id,
      role: "tool",
      label: "mcp tool",
      text: mcpToolText(payload),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "permission_request") {
    const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
    return {
      id: record.id,
      role: "tool",
      label: "permission request",
      text: permissionRequestText(payload),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "user_input_request") {
    const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
    return {
      id: record.id,
      role: "tool",
      label: "user input",
      text: userInputRequestText(payload),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "web_search_call") {
    return {
      id: record.id,
      role: "tool",
      label: "web search",
      text: typeof payload.query === "string" ? payload.query : stringify(payload),
      at: record.timestamp,
      status: recordViewStatusFromAppStatus(payload.status) ?? "completed",
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "collab_agent_tool_call") {
    const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
    return {
      id: record.id,
      role: "tool",
      label: "collab agent",
      text: collabAgentToolText(payload),
      at: record.timestamp,
      status,
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (payload.type === "image_view") {
    const attachments = imageViewAttachments(payload);
    return {
      id: record.id,
      role: "tool",
      label: "image view",
      text: typeof payload.path === "string" ? payload.path : stringify(payload),
      at: record.timestamp,
      status: recordViewStatusFromAppStatus(payload.status) ?? "completed",
      statusText: recordViewStatusText(payload.status),
      attachments,
      record
    };
  }

  if (payload.type === "image_generation_call") {
    const prompt = typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.revised_prompt === "string"
        ? payload.revised_prompt
        : stringify(payload);
    const attachments = imageGenerationAttachments(payload);
    return {
      id: record.id,
      role: "tool",
      label: "image generation",
      text: prompt || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      status: imageGenerationStatus(payload),
      statusText: recordViewStatusText(payload.status),
      attachments,
      record
    };
  }

  if (payload.type === "error") {
    return {
      id: record.id,
      role: "error",
      label: "error",
      text: typeof payload.message === "string" ? payload.message : stringify(payload),
      at: record.timestamp,
      status: "failed",
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  return {
    id: record.id,
    role: responseItemRole(payload),
    label: typeof payload.type === "string" ? payload.type : "response_item",
    text: responseItemSummary(payload),
    at: record.timestamp,
    status: responseItemStatus(payload),
    statusText: recordViewStatusText(payload.status),
    record
  };
};

const responseItemRole = (payload: Record<string, unknown>): CodexRecordView["role"] => {
  if (payload.type === "error" || payload.status === "failed") return "error";
  if (payload.type === "reasoning") return "thinking";
  const type = typeof payload.type === "string" ? payload.type : "";
  return type.includes("call") || type.includes("tool") || type.includes("output") ? "tool" : "event";
};

const responseItemStatus = (payload: Record<string, unknown>): CodexRecordView["status"] | undefined => {
  if (payload.type === "error") return "failed";
  const appStatus = recordViewStatusFromAppStatus(payload.status);
  if (appStatus) return appStatus;
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") return "completed";
  if (String(payload.type ?? "").endsWith("_call")) return "pending";
  return undefined;
};

const sleepStatus = (status: unknown): NonNullable<CodexRecordView["status"]> => {
  const normalized = typeof status === "string"
    ? status.trim().replace(/[-\s]+/g, "_").toLowerCase()
    : "";
  if (normalized === "terminated" || normalized === "cancelled" || normalized === "canceled" || normalized === "interrupted" || normalized === "aborted") {
    return "terminated";
  }
  return recordViewStatusFromAppStatus(status) ?? "pending";
};

const sleepStatusText = (status: NonNullable<CodexRecordView["status"]>) =>
  status === "in_progress" ? "running" : status;

const sleepSummary = (durationMs: number | undefined) =>
  durationMs === undefined ? "sleep" : `sleep ${formatMilliseconds(durationMs)}`;

const contextCompactionStatus = (payload: Record<string, unknown>): NonNullable<CodexRecordView["status"]> => {
  const status = recordViewStatusFromAppStatus(payload.status);
  if (status) return status;
  return "pending";
};

const localShellPresentation = (payload: Record<string, unknown>): {
  status: NonNullable<CodexRecordView["status"]>;
  statusText: string;
} => {
  if (typeof payload.exit_code === "number") {
    // A nonzero exit code is tool-defined, not necessarily an execution failure.
    return payload.exit_code === -1
      ? { status: "terminated", statusText: "Terminated" }
      : { status: "completed", statusText: `Exit ${payload.exit_code}` };
  }

  const rawStatus = typeof payload.status === "string"
    ? payload.status.trim().replace(/[-\s]+/g, "_").toLowerCase()
    : "";
  if (rawStatus === "cancelled" || rawStatus === "canceled" || rawStatus === "interrupted") {
    return { status: "terminated", statusText: "Terminated" };
  }
  const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
  const statusText = status === "in_progress"
    ? "Running"
    : status === "completed"
      ? "Completed"
      : status === "failed"
        ? "Failed"
        : status === "terminated"
          ? "Terminated"
          : "Pending";
  return { status, statusText };
};

export const imageGenerationStatus = (payload: Record<string, unknown>): NonNullable<CodexRecordView["status"]> => {
  const status = recordViewStatusFromAppStatus(payload.status);
  if (status === "failed") return "failed";
  if (status === "completed" || imageGenerationResultUrl(payload)) return "completed";
  if (status === "in_progress") return "in_progress";
  return "pending";
};

export const recordViewStatusFromAppStatus = (status: unknown): CodexRecordView["status"] | undefined => {
  if (typeof status !== "string") return undefined;
  const normalized = status.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === "completed"
    || normalized === "complete"
    || normalized === "done"
    || normalized === "approved"
    || normalized === "accepted"
  ) return "completed";
  if (
    normalized === "failed"
    || normalized === "failure"
    || normalized === "error"
    || normalized === "errored"
    || normalized === "declined"
    || normalized === "denied"
    || normalized === "interrupted"
    || normalized === "aborted"
  ) return "failed";
  if (normalized === "pending" || normalized === "queued" || normalized === "pending_approval" || normalized === "pending_user_input") return "pending";
  if (normalized === "cancelled" || normalized === "canceled") return "failed";
  if (
    normalized === "in_progress"
    || normalized === "inprogress"
    || normalized === "running"
    || normalized === "incomplete"
    || normalized === "generating"
  ) return "in_progress";
  return undefined;
};

export const recordViewStatusText = (status: unknown): string | undefined => {
  if (typeof status !== "string") return undefined;
  const text = status.trim();
  return text || undefined;
};

const nonEmptyString = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export const isActiveRecordStatus = (status: CodexRecordView["status"] | undefined) =>
  status === "pending" || status === "in_progress";

export const imageGenerationAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; url: string }> => {
  const url = imageGenerationResultUrl(payload);
  return url ? [{ type: "image", url }] : [];
};

export const imageViewAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; url: string }> => {
  if (payload.type !== "image_view" || typeof payload.path !== "string") return [];
  const filePath = payload.path.trim();
  if (!filePath) return [];
  // app-server image_view gives us a filesystem path; the browser loads it through the authenticated image-only API.
  const params = new URLSearchParams({ path: filePath });
  return [{ type: "image", url: `/api/file?${params.toString()}` }];
};

export const imageGenerationResultUrl = (payload: Record<string, unknown>): string | null => {
  if (payload.type !== "image_generation_call" || typeof payload.result !== "string") return null;
  const result = payload.result.trim();
  if (!result) return null;
  if (/^(?:https?:|blob:)/i.test(result) || /^data:image\//i.test(result)) return result;
  return `data:${imageMimeTypeFromBase64(result)};base64,${result}`;
};

const imageMimeTypeFromBase64 = (value: string) => {
  if (value.startsWith("iVBOR")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("UklGR")) return "image/webp";
  if (value.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
};

const localShellText = (payload: Record<string, unknown>) => {
  const action = asRecord(payload.action);
  const commandValue = action?.command ?? payload.command ?? payload.cmd;
  const command = Array.isArray(commandValue)
    ? commandValue.filter((part): part is string => typeof part === "string").join(" ")
    : typeof commandValue === "string" ? commandValue : "";
  const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output.trimEnd() : "";
  return [`$ ${command || "<empty>"}`, output].filter(Boolean).join("\n");
};

const mcpToolText = (payload: Record<string, unknown>) => {
  const label = [
    typeof payload.server === "string" ? payload.server : "",
    typeof payload.tool === "string" ? payload.tool : ""
  ].filter(Boolean).join(".");
  const status = typeof payload.status === "string" ? payload.status : "";
  const error = asRecord(payload.error);
  const progressMessages = Array.isArray(payload.progress_messages)
    ? payload.progress_messages.filter((item): item is string => typeof item === "string")
    : [];
  if (typeof error?.message === "string") return `${label}: ${status}\n${error.message}`;
  if (payload.result != null) return `${label}: ${status}\n${stringify(payload.result)}`;
  if (progressMessages.length) return `${label}: ${status}\n${progressMessages[progressMessages.length - 1]}`;
  if (payload.arguments != null) return `${label}: ${status}\n${stringify(payload.arguments)}`;
  return `${label}: ${status}`.trim();
};

const responseMessageSummary = (payload: Record<string, unknown>) => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = responseMessageText(payload);
  const blocks = content.length ? `${content.length} block${content.length === 1 ? "" : "s"}` : "no content blocks";
  const phase = typeof payload.phase === "string" ? ` · ${payload.phase}` : "";
  return text
    ? `${blocks}${phase}\n${textPreview(text)}`
    : `${blocks}${phase}`;
};

const responseMessageText = (payload: Record<string, unknown>) => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return contentText(content) || responseItemSummary(payload);
};

const responseItemSummary = (payload: Record<string, unknown>) => {
  const type = typeof payload.type === "string" ? payload.type : "response_item";
  if (typeof payload.name === "string") return `${type}: ${payload.name}`;
  if (typeof payload.call_id === "string") return `${type}: ${payload.call_id}`;
  return stringify(payload);
};

const contentText = (content: unknown[]) => content
  .map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    if (typeof record.text === "string") return record.text;
    if (typeof record.input_text === "string") return record.input_text;
    if (typeof record.output_text === "string") return record.output_text;
    return null;
  })
  .filter((text): text is string => Boolean(text?.trim()))
  .join("\n\n");

const textPreview = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 280)}...` : normalized;
};

const attachUsageToLatestCodexView = (views: CodexRecordView[], usage: RecordUsage) => {
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].role === "codex") {
      views[i] = { ...views[i], usage };
      return true;
    }
  }
  return false;
};

const tokenUsageFromRecord = (record: CodexRecord): RecordUsage | null => {
  const payload = asRecord(record.payload);
  if (record.type !== "event_msg" || payload?.type !== "token_count") return null;
  const info = asRecord(payload.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage || typeof usage.total_tokens !== "number") return null;
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    cached_input_tokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    reasoning_output_tokens: typeof usage.reasoning_output_tokens === "number" ? usage.reasoning_output_tokens : 0,
    total_tokens: usage.total_tokens
  };
};

const imageAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; url: string }> => {
  const urls = new Set<string>();
  if (Array.isArray(payload.images)) {
    for (const url of payload.images) {
      if (typeof url === "string" && url.trim()) urls.add(url);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      const record = asRecord(item);
      if (!record || !isImageContentType(record.type)) continue;
      const imageUrl = imageUrlFromContent(record);
      if (imageUrl) urls.add(imageUrl);
    }
  }
  return [...urls].map((url) => ({ type: "image", url }));
};

const isImageContentType = (value: unknown) =>
  value === "input_image" || value === "output_image" || value === "image";

const imageUrlFromContent = (content: Record<string, unknown>) => {
  if (typeof content.image_url === "string" && content.image_url.trim()) return content.image_url;
  const imageUrl = asRecord(content.image_url);
  if (typeof imageUrl?.url === "string" && imageUrl.url.trim()) return imageUrl.url;
  if (typeof content.url === "string" && content.url.trim()) return content.url;
  return null;
};

const reasoningText = (payload: Record<string, unknown>): string | null => {
  if (typeof payload.content === "string" && payload.content.trim()) return payload.content;
  if (!Array.isArray(payload.summary)) return null;
  const parts = payload.summary
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      if (!record) return null;
      if (typeof record.text === "string") return record.text;
      if (typeof record.summary === "string") return record.summary;
      return null;
    })
    .filter((text): text is string => Boolean(text?.trim()));
  return parts.length ? parts.join("\n") : null;
};

const formatFunctionCall = (name: string, args: string) => {
  const parsed = parseJsonObject(args);
  if (name === "exec_command" && typeof parsed?.cmd === "string") return `$ ${parsed.cmd}`;
  return args ? `${name}\n${formatJsonLike(args)}` : name;
};

const fileChangeText = (payload: Record<string, unknown>) => {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const approval = asRecord(payload.approval);
  const approvalStatus = typeof approval?.status === "string" ? approval.status : "";
  const headline = approvalStatus === "pending"
    ? "Approval required before applying file changes."
    : approvalStatus === "denied"
      ? "File changes denied."
      : approvalStatus === "approved"
        ? "File changes approved."
        : payload.status === "failed" ? "Patch failed." : "Patch applied successfully.";
  return [
    headline,
    "",
    `Status: ${typeof payload.status === "string" ? payload.status : "completed"}`,
    `Changed files: ${changes.length}`,
    "",
    ...changes.map((change) => {
      const record = asRecord(change);
      const kind = typeof record?.kind === "string" ? record.kind : "update";
      const filePath = typeof record?.path === "string" ? record.path : "";
      return `- ${kind}: ${filePath}`;
    })
  ].join("\n");
};

const permissionRequestText = (payload: Record<string, unknown>) => {
  const parts = [
    "Permission request",
    stringValue(payload.reason),
    stringValue(payload.cwd) ? `cwd: ${stringValue(payload.cwd)}` : null,
    stringify(payload.permissions)
  ].filter((item): item is string => Boolean(item?.trim()));
  return parts.join("\n");
};

const userInputRequestText = (payload: Record<string, unknown>) => {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (!questions.length) return "User input requested";
  return questions.map((question, index) => {
    const record = asRecord(question);
    const header = stringValue(record?.header);
    const text = stringValue(record?.question);
    return [header ? `${index + 1}. ${header}` : `${index + 1}. Question`, text].filter(Boolean).join("\n");
  }).join("\n\n");
};

const collabAgentToolText = (payload: Record<string, unknown>) => [
  typeof payload.tool === "string" ? payload.tool : "agent",
  typeof payload.prompt === "string" && payload.prompt.trim() ? payload.prompt : null,
  Array.isArray(payload.receiver_thread_ids) && payload.receiver_thread_ids.length
    ? `receivers: ${payload.receiver_thread_ids.join(", ")}`
    : null
].filter(Boolean).join("\n");

const formatJsonLike = (value: string) => {
  const parsed = parseJsonObject(value);
  return parsed ? JSON.stringify(parsed, null, 2) : value;
};

const stringify = (value: unknown) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;
