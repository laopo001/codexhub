import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import type {
  AppServerApprovalDecision,
  AppServerApprovalRequest,
  AppServerUserInputAnswers,
  AppServerUserInputRequest
} from "../shared/threadTypes.js";

export type PendingApproval = AppServerApprovalRequest & {
  sessionId: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "failed";
  decision?: AppServerApprovalDecision;
};

export type PendingUserInput = AppServerUserInputRequest & {
  sessionId: string;
  status: "pending" | "answered" | "failed";
  answers?: AppServerUserInputAnswers;
};

type ApprovalDecisionStatus = "approved" | "denied" | "cancelled";

export const approvalDecisionStatus = (decision: AppServerApprovalDecision): ApprovalDecisionStatus => {
  if (typeof decision !== "string" || decision === "approve" || decision === "approve_for_session") return "approved";
  if (decision === "cancel") return "cancelled";
  return "denied";
};

export const approvalRecord = (approval: PendingApproval, errorMessage?: string): CodexRecord => {
  const params = asRecord(approval.params);
  const status = approvalRecordStatus(approval.status);
  const timestamp = approval.createdAt;
  if (approval.kind === "mcp_elicitation") {
    return {
      id: approvalRecordId(approval),
      timestamp,
      type: "response_item",
      payload: {
        type: "mcp_tool_call",
        server: mcpElicitationServer(params),
        tool: "elicitation.request",
        arguments: mcpElicitationArguments(params),
        result: approval.status === "approved" ? { action: "accept" } : null,
        error: approval.status === "denied"
          ? { message: "User declined MCP request." }
          : approval.status === "failed"
            ? { message: errorMessage ?? "MCP request approval failed." }
            : null,
        status,
        approval: approvalPayload(approval, params, errorMessage)
      },
      sourceThreadId: approval.threadId
    };
  }
  if (approval.kind === "permissions_request") {
    return {
      id: approvalRecordId(approval),
      timestamp,
      type: "response_item",
      payload: {
        type: "permission_request",
        cwd: stringValue(params?.cwd) ?? null,
        reason: stringValue(params?.reason) ?? null,
        permissions: asRecord(params?.permissions) ?? {},
        result: approval.status === "approved"
          ? permissionApprovalResult(params, approval.decision)
          : null,
        error: approval.status === "denied"
          ? { message: "User declined permission request." }
          : approval.status === "cancelled"
            ? { message: "User cancelled permission request." }
            : approval.status === "failed"
              ? { message: errorMessage ?? "Permission request approval failed." }
              : null,
        status,
        approval: approvalPayload(approval, params, errorMessage)
      },
      sourceThreadId: approval.threadId
    };
  }
  if (approval.kind === "command_execution") {
    return {
      id: approvalRecordId(approval),
      timestamp,
      type: "response_item",
      payload: {
        type: "local_shell_call",
        call_id: approval.itemId ?? approval.approvalId,
        status,
        action: {
          type: "exec",
          command: approvalCommandParts(params)
        },
        aggregated_output: approvalOutputText(approval, params, errorMessage),
        exit_code: approval.status === "denied" || approval.status === "failed" ? 1 : null,
        approval: approvalPayload(approval, params, errorMessage)
      },
      sourceThreadId: approval.threadId
    };
  }

  return {
    id: approvalRecordId(approval),
    timestamp,
    type: "response_item",
    payload: {
      type: "file_change",
      changes: approvalFileChanges(params),
      status,
      approval: approvalPayload(approval, params, errorMessage)
    },
    sourceThreadId: approval.threadId
  };
};

export const userInputRecord = (userInput: PendingUserInput, errorMessage?: string): CodexRecord => ({
  id: userInputRecordId(userInput),
  timestamp: userInput.createdAt,
  type: "response_item",
  payload: {
    type: "user_input_request",
    questions: userInput.questions,
    response: userInput.answers ?? null,
    error: userInput.status === "failed"
      ? { message: errorMessage ?? "User input request failed." }
      : null,
    status: userInputRecordStatus(userInput.status),
    userInput: {
      userInputId: userInput.userInputId,
      method: userInput.method,
      requestId: userInput.requestId,
      status: userInput.status,
      ...(userInput.turnId ? { turnId: userInput.turnId } : {}),
      ...(userInput.itemId ? { itemId: userInput.itemId } : {}),
      ...(errorMessage ? { error: errorMessage } : {})
    }
  },
  sourceThreadId: userInput.threadId
});

export const fileChanges = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => {
      const record = asRecord(item);
      const kind = asRecord(record?.kind);
      return {
        path: typeof record?.path === "string" ? record.path : "",
        kind: typeof kind?.type === "string" ? kind.type : "update",
        diff: typeof record?.diff === "string" ? record.diff : undefined
      };
    })
    : [];

const userInputRecordId = (userInput: PendingUserInput) => {
  const turnId = userInput.turnId || "userInput";
  const itemId = userInput.itemId || userInput.userInputId;
  return `app:${userInput.threadId}:${turnId}:userInput:${itemId}`;
};

const userInputRecordStatus = (status: PendingUserInput["status"]) => {
  if (status === "pending") return "pending_user_input";
  if (status === "answered") return "completed";
  return "failed";
};

const approvalRecordId = (approval: PendingApproval) => {
  const turnId = approval.turnId || "approval";
  const itemId = approval.itemId || approval.approvalId;
  if (approval.kind === "command_execution") {
    const params = asRecord(approval.params);
    const callbackId = typeof params?.approvalId === "string" && params.approvalId ? params.approvalId : "";
    return callbackId
      ? `app:${approval.threadId}:${turnId}:approval:commandExecution:${itemId}:${callbackId}`
      : `app:${approval.threadId}:${turnId}:item:commandExecution:${itemId}`;
  }
  if (approval.kind === "file_change") return `app:${approval.threadId}:${turnId}:item:fileChange:${itemId}`;
  if (approval.kind === "mcp_elicitation") return `app:${approval.threadId}:${turnId}:approval:mcpElicitation:${itemId}`;
  if (approval.kind === "permissions_request") return `app:${approval.threadId}:${turnId}:approval:permissions:${itemId}`;
  return `app:${approval.threadId}:${turnId}:approval:${approval.kind}:${itemId}`;
};

const approvalRecordStatus = (status: PendingApproval["status"]) => {
  if (status === "pending") return "pending_approval";
  if (status === "approved") return "approved";
  if (status === "denied") return "denied";
  if (status === "cancelled") return "cancelled";
  return "failed";
};

const approvalPayload = (
  approval: PendingApproval,
  params: Record<string, unknown> | null,
  errorMessage?: string
) => ({
  approvalId: approval.approvalId,
  kind: approval.kind,
  method: approval.method,
  requestId: approval.requestId,
  status: approval.status,
  ...(Object.prototype.hasOwnProperty.call(approval, "availableDecisions")
    ? { availableDecisions: approval.availableDecisions }
    : {}),
  ...(approval.decision ? { decision: approval.decision } : {}),
  reason: stringValue(params?.reason) ?? null,
  ...(approval.turnId ? { turnId: approval.turnId } : {}),
  ...(approval.itemId ? { itemId: approval.itemId } : {}),
  ...(errorMessage ? { error: errorMessage } : {})
});

const permissionApprovalResult = (
  params: Record<string, unknown> | null,
  decision: AppServerApprovalDecision | undefined
) => ({
  permissions: grantedPermissionsFromRequest(params),
  scope: decision === "approve_for_session" ? "session" : "turn"
});

const grantedPermissionsFromRequest = (params: Record<string, unknown> | null) => {
  const permissions = asRecord(params?.permissions);
  if (!permissions) return {};
  const granted: Record<string, unknown> = {};
  if (permissions.network !== null && permissions.network !== undefined) granted.network = permissions.network;
  if (permissions.fileSystem !== null && permissions.fileSystem !== undefined) granted.fileSystem = permissions.fileSystem;
  return granted;
};

const approvalCommandParts = (params: Record<string, unknown> | null) => {
  const command = params?.command;
  if (typeof command === "string" && command) return [command];
  return [];
};

const approvalOutputText = (
  approval: PendingApproval,
  params: Record<string, unknown> | null,
  errorMessage?: string
) => [
  approval.status === "pending"
    ? "Approval required."
    : approval.status === "approved"
      ? "Approved."
      : approval.status === "denied"
        ? "Denied."
        : "Approval failed.",
  stringValue(params?.reason),
  approvalNetworkText(params?.networkApprovalContext),
  stringValue(params?.cwd) ? `cwd: ${stringValue(params?.cwd)}` : null,
  errorMessage ? `error: ${errorMessage}` : null
].filter(Boolean).join("\n");

const mcpElicitationServer = (params: Record<string, unknown> | null) =>
  stringValue(params?.serverName) ?? "mcp";

const mcpElicitationArguments = (params: Record<string, unknown> | null) => ({
  mode: stringValue(params?.mode) ?? "form",
  message: stringValue(params?.message) ?? "MCP server requested user approval.",
  requestedSchema: asRecord(params?.requestedSchema) ?? null,
  url: stringValue(params?.url) ?? null,
  elicitationId: stringValue(params?.elicitationId) ?? null
});

const approvalNetworkText = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return null;
  return [
    "network:",
    stringValue(record.protocol),
    stringValue(record.host)
  ].filter(Boolean).join(" ");
};

const approvalFileChanges = (params: Record<string, unknown> | null) => {
  const grantRoot = stringValue(params?.grantRoot);
  return grantRoot ? [{ path: grantRoot, kind: "grant", diff: stringValue(params?.reason) }] : [];
};

const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;
