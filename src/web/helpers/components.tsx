import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import { Button, Modal, Switch } from "antd";
import { X } from "lucide-react";
import remarkGfm from "remark-gfm";
import { highlightedLanguages, isVscodeSurface, languageAliases } from "../appConfig.js";
import { SubagentActivityMessage } from "../SubagentActivityMessage.js";
import type { ActivityStatusFile, ActivityStatusPlanStep, ActivityStatusView, BackgroundTerminalView, ImagePreviewState, MemoryCitationView, MessageRenderMode, ThreadExecutionMeta, WebRecordView } from "../types.js";
import type { AppServerApprovalDecision, AppServerUserInputAnswers, FilePreviewPayload } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import { asRecord, type SubagentActivityView } from "../../shared/recordTypes.js";
import { updatePlanStatusIcon } from "../../shared/updatePlanView.js";
import { apiRouteJson, authFetch, authToken } from "./core.js";
import { writeTextToClipboard } from "./composer.js";
import { LiveStatusLabel, StatusStartedAtContext } from "./liveTime.js";
import { emptyMemoryCitation, formatMemoryCitationCount, formatMemoryCitationLines, parseMemoryCitationText, shouldExtractMemoryCitation } from "./memoryCitation.js";
import { formatInspectDetail, renderToolMessageBody } from "./toolPreview.js";
import { activityStatusPriority, formatMessageMeta, formatMessageMetaTitle } from "./records.js";
import { createStatusRegistry, StatusPanelToggleIcon, StatusRegistryRows } from "./statusRegistry.js";

const SyntaxCodeBlock = lazy(() => import("../SyntaxCodeBlock.js"));

// <img>/<video> requests cannot carry Authorization headers, so protected file responses use the narrow query-token path.
const authenticatedFileUrl = (url: string) => {
  if (!isFileApiUrl(url)) return url;
  if (typeof window === "undefined") return url;
  const token = authToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.origin);
  if (!parsed.searchParams.has("codexhub_token")) {
    parsed.searchParams.set("codexhub_token", token);
  }
  return url.startsWith("http://") || url.startsWith("https://")
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}`;
};

const isFileApiUrl = (url: string) => {
  if (url.startsWith("/api/file?") || url === "/api/file" || url.startsWith("/api/file-stream/")) return true;
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && (
      parsed.pathname === "/api/file" || parsed.pathname.startsWith("/api/file-stream/")
    );
  } catch {
    return false;
  }
};

export const MessageCard = ({
  message,
  showStatus = true,
  showTimestamp = true,
  renderToolPreview = true,
  renderMode,
  markdownEnabled,
  threadMachineId,
  threadWorkingDirectory,
  onRenderModeChange,
  onContextMenu,
  onSelectionMenu,
  onInspect,
  onToggleToolBatch,
  onApprovalDecision,
  onUserInputResponse,
  onFork,
  forkDisabled = false,
  forking = false,
  onOpenImage,
  onOpenSubagentThread
}: {
  message: WebRecordView;
  showStatus?: boolean;
  showTimestamp?: boolean;
  renderToolPreview?: boolean;
  renderMode: MessageRenderMode;
  markdownEnabled: boolean;
  threadMachineId?: string;
  threadWorkingDirectory?: string;
  onRenderModeChange?: (mode: MessageRenderMode) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  onSelectionMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  onInspect?: () => void;
  onToggleToolBatch?: () => void;
  onApprovalDecision?: (approvalId: string, decision: AppServerApprovalDecision) => void;
  onUserInputResponse?: (userInputId: string, answers: AppServerUserInputAnswers) => void | Promise<void>;
  onFork?: () => void;
  forkDisabled?: boolean;
  forking?: boolean;
  onOpenImage?: (image: ImagePreviewState) => void;
  onOpenSubagentThread?: (activity: SubagentActivityView) => void | Promise<void>;
}) => {
  const isThinkingMessage = message.role === "thinking";
  const isToolBatch = Boolean(message.toolBatch);
  const messageToneClass = messageToneClassName(message);
  const toolBody = !isToolBatch && renderToolPreview ? renderToolMessageBody(message, showStatus ? message.status : undefined, showStatus ? message.statusText : undefined) : null;
  const hasToolBody = toolBody !== null;
  const memoryCitation = useMemo(() => {
    if (isThinkingMessage) return emptyMemoryCitation("");
    return shouldExtractMemoryCitation(message) ? parseMemoryCitationText(message.text) : emptyMemoryCitation(message.text);
  }, [message, isThinkingMessage]);
  const messageText = memoryCitation.text;
  const approval = pendingApprovalFromMessage(message);
  const userInput = pendingUserInputFromMessage(message);
  const approvalActions = approval ? approvalDecisionActions(approval.kind, approval.availableDecisions) : [];
  const hasMessageMeta = !isThinkingMessage && (
    (showTimestamp && message.at)
    || message.usage
    || markdownEnabled
    || approval
    || onFork
  );
  const canClickInspect = Boolean(hasToolBody && onInspect);
  const inspectOnKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!canClickInspect || event.defaultPrevented) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onInspect?.();
  };
  const inspectOnClick = () => {
    if (!canClickInspect || window.getSelection()?.toString()) return;
    onInspect?.();
  };
  if (message.subagentActivity) {
    return (
      <SubagentActivityMessage
        activity={message.subagentActivity}
        statusLabel={message.statusText ?? "Activity"}
        timestampText={showTimestamp ? formatMessageMeta(message) : undefined}
        timestampTitle={showTimestamp ? formatMessageMetaTitle(message) : undefined}
        onOpenThread={onOpenSubagentThread}
        onContextMenu={onContextMenu}
      />
    );
  }
  if (message.toolBatch) {
    const isExpanded = Boolean(message.toolBatch.expanded);
    return (
      <article className={`message tool toolBatchRow ${isExpanded ? "expanded" : "collapsed"}`}>
        <button
          type="button"
          className="toolBatchToggle"
          onClick={onToggleToolBatch}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${message.toolBatch.count} tool call${message.toolBatch.count === 1 ? "" : "s"}`}
        >
          <span className="toolBatchChevron" aria-hidden="true">{isExpanded ? "v" : ">"}</span>
          <span className="toolBatchTitle">tools</span>
          <span className="toolBatchCount">{message.toolBatch.count} call{message.toolBatch.count === 1 ? "" : "s"}</span>
          {showStatus && message.status ? (
            <em className={`messageStatus ${message.status}`}>
              <LiveStatusLabel status={message.status} statusText={message.statusText} statusDurationMs={message.statusDurationMs} startedAt={message.at} />
            </em>
          ) : null}
          <span className="toolBatchSummary">{message.toolBatch.labels.join(", ")}</span>
        </button>
      </article>
    );
  }
  return (
    <article
      className={`message ${message.role} ${messageToneClass} ${hasToolBody ? "richTool" : ""} ${canClickInspect ? "inspectableTool" : ""} ${onContextMenu || onSelectionMenu ? "hasContextMenu" : ""} ${renderMode === "markdown" ? "markdownMode" : "rawMode"}`}
      onContextMenu={onContextMenu}
      onMouseUp={onSelectionMenu}
      onClick={canClickInspect ? inspectOnClick : undefined}
      onKeyDown={canClickInspect ? inspectOnKeyDown : undefined}
      role={canClickInspect ? "button" : undefined}
      tabIndex={canClickInspect ? 0 : undefined}
    >
      {hasToolBody ? null : (
        <span className="messageHeader">
          <b>{message.label ?? message.role}</b>
          {showStatus && message.status ? (
            <em className={`messageStatus ${message.status}`}>
              <LiveStatusLabel status={message.status} statusText={message.statusText} statusDurationMs={message.statusDurationMs} startedAt={message.at} />
            </em>
          ) : null}
        </span>
      )}
      {hasToolBody ? (
        <StatusStartedAtContext.Provider value={message.at}>{toolBody}</StatusStartedAtContext.Provider>
      ) : messageText ? (
        <MessageText
          text={messageText}
          mode={renderMode}
          markdownEnabled={markdownEnabled}
          threadMachineId={threadMachineId}
          threadWorkingDirectory={threadWorkingDirectory}
          onOpenImage={onOpenImage}
        />
      ) : null}
      {!isThinkingMessage && (memoryCitation.entries.length || memoryCitation.rolloutIds.length) ? (
        <MemoryCitationPanel citation={memoryCitation} />
      ) : null}
      {!isThinkingMessage && message.attachments?.length ? (
        <div className="messageAttachments">
          {message.attachments.map((attachment) => {
            if (attachment.type !== "image") return null;
            const imageUrl = authenticatedFileUrl(attachment.url);
            return (
              <button
                type="button"
                className="messageImage"
                key={attachment.url}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenImage?.({ url: imageUrl, title: message.text || message.label });
                }}
                aria-label="View image"
              >
                <img src={imageUrl} alt="attachment" />
              </button>
            );
          })}
        </div>
      ) : null}
      {hasMessageMeta ? (
        <footer className="messageMeta" title={formatMessageMetaTitle(message, { showTimestamp })} onClick={(event) => event.stopPropagation()}>
          {onFork ? (
            <button
              type="button"
              className="messageMetaAction"
              disabled={forkDisabled}
              aria-busy={forking}
              onClick={() => {
                if (forkDisabled) return;
                onFork();
              }}
            >
              {forking ? "Forking…" : "Fork"}
            </button>
          ) : null}
          <span>{formatMessageMeta(message, { showTimestamp })}</span>
          {markdownEnabled && onRenderModeChange ? (
            <Switch
              size="small"
              checked={renderMode === "markdown"}
              checkedChildren="MD"
              unCheckedChildren="Raw"
              onChange={(checked) => onRenderModeChange(checked ? "markdown" : "raw")}
              aria-label="Toggle Markdown rendering"
            />
          ) : null}
          {approval && onApprovalDecision ? (
            <span className="approvalActions">
              {approvalActions.map((action) => (
                <button
                  type="button"
                  className={`approvalButton ${action.className}`}
                  onClick={() => onApprovalDecision(approval.approvalId, action.decision)}
                  title={action.title}
                  key={action.key}
                >
                  {action.label}
                </button>
              ))}
            </span>
          ) : null}
        </footer>
      ) : null}
      {userInput && onUserInputResponse ? (
        <UserInputRequestForm request={userInput} onSubmit={onUserInputResponse} />
      ) : null}
      {message.activityStatuses?.length ? (
        <MessageActivityStatusSnapshot statuses={message.activityStatuses} />
      ) : null}
    </article>
  );
};

const messageToneClassName = (message: WebRecordView) =>
  message.role === "codex" && message.label === "final_answer" ? "finalAnswer" : "";

type PendingUserInputQuestionView = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description?: string }> | null;
};

type PendingUserInputView = {
  userInputId: string;
  questions: PendingUserInputQuestionView[];
};

const UserInputRequestForm = ({
  request,
  onSubmit
}: {
  request: PendingUserInputView;
  onSubmit: (userInputId: string, answers: AppServerUserInputAnswers) => void | Promise<void>;
}) => {
  const [values, setValues] = useState<Record<string, string>>(() => defaultUserInputValues(request.questions));
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSubmitting(true);
    try {
      await onSubmit(request.userInputId, userInputAnswers(request.questions, values));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="userInputRequestForm" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
      {request.questions.length ? request.questions.map((question) => (
        <label className="userInputQuestion" key={question.id}>
          <span className="userInputQuestionHeader">{question.header || question.id}</span>
          {question.question ? <span className="userInputQuestionText">{question.question}</span> : null}
          {question.options?.length ? (
            <select
              className="userInputControl"
              value={values[question.id] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
              disabled={submitting}
            >
              <option value="">Select...</option>
              {question.options.map((option) => (
                <option value={option.label} key={option.label}>{option.label}</option>
              ))}
            </select>
          ) : null}
          {question.isOther || !question.options?.length ? (
            <input
              className="userInputControl"
              type={question.isSecret ? "password" : "text"}
              value={values[question.id] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
              disabled={submitting}
            />
          ) : null}
        </label>
      )) : (
        <p className="userInputEmpty">No questions were provided.</p>
      )}
      <button type="submit" className="approvalButton approve userInputSubmit" disabled={submitting}>
        Submit
      </button>
    </form>
  );
};

export const MemoryCitationPanel = ({ citation }: { citation: MemoryCitationView }) => (
  <details className="memoryCitation" open>
    <summary>
      <span>{formatMemoryCitationCount(citation.entries.length)}</span>
    </summary>
    <div className="memoryCitationBody">
      {citation.entries.map((entry, index) => (
        <div className="memoryCitationEntry" key={`${entry.raw}:${index}`}>
          <div className="memoryCitationSource">
            <strong>{entry.source}</strong>
            {entry.lineStart ? <span>{formatMemoryCitationLines(entry)}</span> : null}
          </div>
          {entry.note ? <p>{entry.note}</p> : null}
        </div>
      ))}
      {citation.rolloutIds.length ? (
        <div className="memoryCitationEntry">
          <div className="memoryCitationSource">
            <strong>rollout_ids</strong>
          </div>
          <p>{citation.rolloutIds.join(", ")}</p>
        </div>
      ) : null}
    </div>
  </details>
);

const pendingApprovalFromMessage = (message: WebRecordView) => {
  const payload = asRecord(message.record.payload);
  const approval = asRecord(payload?.approval);
  const approvalId = typeof approval?.approvalId === "string" ? approval.approvalId : "";
  const status = typeof approval?.status === "string" ? approval.status : "";
  const kind = typeof approval?.kind === "string" ? approval.kind : "";
  const availableDecisions = Array.isArray(approval?.availableDecisions)
    ? approval.availableDecisions.filter(isAppServerApprovalDecision)
    : null;
  return approvalId && status === "pending" ? { approvalId, kind, availableDecisions } : null;
};

const pendingUserInputFromMessage = (message: WebRecordView): PendingUserInputView | null => {
  const payload = asRecord(message.record.payload);
  const userInput = asRecord(payload?.userInput);
  const userInputId = typeof userInput?.userInputId === "string" ? userInput.userInputId : "";
  const status = typeof userInput?.status === "string" ? userInput.status : "";
  if (!userInputId || status !== "pending") return null;
  const questions = Array.isArray(payload?.questions)
    ? payload.questions.flatMap(userInputQuestionFromValue)
    : [];
  return { userInputId, questions };
};

const userInputQuestionFromValue = (value: unknown): PendingUserInputQuestionView[] => {
  const record = asRecord(value);
  const id = typeof record?.id === "string" && record.id ? record.id : "";
  if (!id) return [];
  return [{
    id,
    header: typeof record?.header === "string" ? record.header : "",
    question: typeof record?.question === "string" ? record.question : "",
    isOther: record?.isOther === true,
    isSecret: record?.isSecret === true,
    options: Array.isArray(record?.options)
      ? record.options.flatMap(userInputOptionFromValue)
      : null
  }];
};

const userInputOptionFromValue = (value: unknown) => {
  const record = asRecord(value);
  const label = typeof record?.label === "string" && record.label ? record.label : "";
  if (!label) return [];
  return [{
    label,
    ...(typeof record?.description === "string" && record.description ? { description: record.description } : {})
  }];
};

const defaultUserInputValues = (questions: PendingUserInputQuestionView[]) =>
  Object.fromEntries(questions.map((question) => [question.id, ""]));

const userInputAnswers = (
  questions: PendingUserInputQuestionView[],
  values: Record<string, string>
): AppServerUserInputAnswers =>
  Object.fromEntries(questions.map((question) => [
    question.id,
    { answers: (values[question.id]?.trim() ? [values[question.id].trim()] : []) }
  ]));

const isAppServerApprovalDecision = (value: unknown): value is AppServerApprovalDecision => {
  if (value === "approve" || value === "approve_for_session" || value === "deny" || value === "cancel") return true;
  const decision = asRecord(value);
  if (decision?.type === "accept_with_execpolicy_amendment") {
    return Array.isArray(decision.execpolicyAmendment)
      && decision.execpolicyAmendment.every((part) => typeof part === "string");
  }
  if (decision?.type !== "apply_network_policy_amendment") return false;
  const amendment = asRecord(decision.networkPolicyAmendment);
  return typeof amendment?.host === "string"
    && (amendment.action === "allow" || amendment.action === "deny");
};

export const approvalDecisionActions = (
  kind: string,
  availableDecisions: AppServerApprovalDecision[] | null = null
): Array<{
  decision: AppServerApprovalDecision;
  key: string;
  label: string;
  className: string;
  title: string;
}> => {
  const stableActions: Record<"approve" | "approve_for_session" | "deny" | "cancel", {
    decision: AppServerApprovalDecision;
    key: string;
    label: string;
    className: string;
    title: string;
  }> = {
    approve: {
      decision: "approve",
      key: "approve",
      label: "Approve",
      className: "approve",
      title: "Approve this request once"
    },
    approve_for_session: {
      decision: "approve_for_session",
      key: "approve_for_session",
      label: "Session",
      className: "approve session",
      title: "Approve similar requests for this session"
    },
    deny: {
      decision: "deny",
      key: "deny",
      label: "Deny",
      className: "deny",
      title: "Decline this request"
    },
    cancel: {
      decision: "cancel",
      key: "cancel",
      label: "Cancel",
      className: "cancel",
      title: "Cancel this request"
    }
  };
  const defaultDecisions: AppServerApprovalDecision[] = [
    "approve",
    ...(kind === "mcp_elicitation" ? [] : ["approve_for_session"] as AppServerApprovalDecision[]),
    "deny",
    ...(kind === "permissions_request" ? [] : ["cancel"] as AppServerApprovalDecision[])
  ];
  const decisions = availableDecisions ?? defaultDecisions;
  const seen = new Set<string>();
  return decisions.flatMap((decision) => {
    const key = JSON.stringify(decision);
    if (seen.has(key)) return [];
    seen.add(key);
    if (typeof decision === "string") return [stableActions[decision]];
    if (decision.type === "accept_with_execpolicy_amendment") {
      const command = decision.execpolicyAmendment.join(" ");
      return [{
        decision,
        key,
        label: "Allow pattern",
        className: "approve session",
        title: command ? `Allow commands starting with: ${command}` : "Allow this command pattern"
      }];
    }
    const { host, action } = decision.networkPolicyAmendment;
    return [{
      decision,
      key,
      label: action === "allow" ? "Allow host" : "Block host",
      className: action === "allow" ? "approve session" : "deny",
      title: `${action === "allow" ? "Allow" : "Block"} ${host} in the network policy`
    }];
  });
};

export const canRenderMarkdown = (message: WebRecordView) => {
  if (message.role !== "codex") return false;
  const label = message.label.toLowerCase();
  return label === "commentary" || label === "final_answer" || label === "assistant";
};

export const markdownCodeLanguage = (className: string | undefined) => {
  const language = className?.match(/language-([\w-]+)/)?.[1].toLowerCase();
  if (!language) return null;
  const normalized = languageAliases[language] ?? language;
  return highlightedLanguages.has(normalized) ? normalized : null;
};

export const MessageText = ({
  text,
  mode,
  markdownEnabled,
  threadMachineId,
  threadWorkingDirectory,
  onOpenImage
}: {
  text: string;
  mode: MessageRenderMode;
  markdownEnabled: boolean;
  threadMachineId?: string;
  threadWorkingDirectory?: string;
  onOpenImage?: (image: ImagePreviewState) => void;
}) => {
  const [filePreview, setFilePreview] = useState<FilePreviewDialogState | null>(null);
  const handleFileLinkClick = useCallback((target: LocalFileLinkTarget, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isVscodeSurface) {
      window.parent?.postMessage({
        type: "codexhub.openFile",
        path: target.fullPath,
        line: target.line,
        column: target.column
      }, "*");
      return;
    }
    setFilePreview({ target, machineId: threadMachineId });
  }, [threadMachineId]);
  const markdownInteraction = useMemo<MarkdownInteractionContextValue>(
    () => ({ threadWorkingDirectory, onFileLinkClick: handleFileLinkClick, onOpenImage }),
    [handleFileLinkClick, onOpenImage, threadWorkingDirectory]
  );
  if (!markdownEnabled || mode === "raw") return <pre>{text}</pre>;
  return (
    <div className="messageMarkdown">
      <MarkdownInteractionContext.Provider value={markdownInteraction}>
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownComponents} urlTransform={markdownUrlTransform}>
          {text}
        </ReactMarkdown>
      </MarkdownInteractionContext.Provider>
      {filePreview ? (
        <FilePreviewDialog preview={filePreview} onClose={() => setFilePreview(null)} />
      ) : null}
    </div>
  );
};

const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "href" && localFileLinkTargetFromHref(url, undefined)) return url;
  return defaultUrlTransform(url);
};

type FilePreviewDialogState = {
  target: LocalFileLinkTarget;
  machineId?: string;
};

const FilePreviewDialog = ({
  preview,
  onClose
}: {
  preview: FilePreviewDialogState;
  onClose: () => void;
}) => {
  const [result, setResult] = useState<FilePreviewLoadState>({ status: "loading" });
  const actions = fileLinkCopyActions(preview.target);
  useEffect(() => {
    let cancelled = false;
    setResult({ status: "loading" });
    if (!preview.machineId) {
      setResult({ status: "error", message: "This file link is not associated with a machine." });
      return () => { cancelled = true; };
    }
    void apiRouteJson(apiRoutes.machineFilePreview, preview.machineId, { path: preview.target.fullPath })
      .then((value) => {
        if (!cancelled) setResult({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ status: "error", message: filePreviewErrorMessage(error) });
      });
    return () => { cancelled = true; };
  }, [preview.machineId, preview.target.fullPath]);
  const streamUrl = result.status === "ready" && result.value.kind === "media"
    ? result.value.streamUrl
    : null;
  useEffect(() => () => {
    if (streamUrl) void authFetch(streamUrl, { method: "DELETE" }).catch(() => undefined);
  }, [streamUrl]);
  const copyValue = async (value: string) => {
    await writeTextToClipboard(value).catch(() => undefined);
  };
  return (
    <Modal
      open
      className="filePreviewModal"
      title="File preview"
      width="min(1100px, calc(100vw - 36px))"
      onCancel={onClose}
      footer={(
        <div className="filePreviewFooter">
          <div className="filePreviewCopyActions">
            {actions.map((action) => (
              <Button type="default" onClick={() => void copyValue(action.value)} key={action.key}>
                {action.label}
              </Button>
            ))}
          </div>
          <Button type="primary" onClick={onClose}>Close</Button>
        </div>
      )}
    >
      <p className="filePreviewPath" title={preview.target.title}>{preview.target.title}</p>
      <FilePreviewBody state={result} line={preview.target.line} />
    </Modal>
  );
};

type FilePreviewLoadState =
  | { status: "loading" }
  | { status: "ready"; value: FilePreviewPayload }
  | { status: "error"; message: string };

const FilePreviewBody = ({ state, line }: { state: FilePreviewLoadState; line?: number }) => {
  if (state.status === "loading") return <div className="filePreviewStatus">Loading preview...</div>;
  if (state.status === "error") return <div className="filePreviewStatus error">{state.message}</div>;
  if (state.value.kind === "image") {
    return (
      <div className="filePreviewImageBody">
        <img src={`data:${state.value.contentType};base64,${state.value.base64}`} alt={state.value.path} />
      </div>
    );
  }
  if (state.value.kind === "media") {
    const streamUrl = authenticatedFileUrl(state.value.streamUrl);
    if (state.value.contentType.startsWith("audio/")) {
      return (
        <div className="filePreviewMediaBody audio">
          <audio src={streamUrl} controls preload="metadata">
            Your browser does not support this audio format.
          </audio>
        </div>
      );
    }
    return (
      <div className="filePreviewMediaBody">
        <video
          src={streamUrl}
          controls
          playsInline
          preload="metadata"
        >
          Your browser does not support this video format.
        </video>
      </div>
    );
  }
  if (state.value.kind === "text") {
    return (
      <div className="filePreviewTextWrap">
        {state.value.truncated ? (
          <div className="filePreviewNotice">This preview is truncated because the file exceeds the preview limit.</div>
        ) : null}
        <FilePreviewText text={state.value.text} line={line} />
      </div>
    );
  }
  return (
    <div className="filePreviewStatus">
      {state.value.reason === "file_too_large"
        ? `This file is too large to preview (${formatByteSize(state.value.size)}; limit ${formatByteSize(state.value.maxBytes ?? 0)}).`
        : "Preview is not available for this binary file type."}
    </div>
  );
};

const FilePreviewText = ({ text, line }: { text: string; line?: number }) => {
  const highlightedLineRef = useRef<HTMLElement | null>(null);
  const parts = useMemo(() => filePreviewTextParts(text, line), [line, text]);
  useEffect(() => {
    highlightedLineRef.current?.scrollIntoView({ block: "center" });
  }, [parts]);
  if (!parts) return <pre className="filePreviewText">{text || "Empty file."}</pre>;
  return (
    <pre className="filePreviewText">
      {parts.before}
      <mark ref={highlightedLineRef}>{parts.highlighted || " "}</mark>
      {parts.after}
    </pre>
  );
};

const filePreviewTextParts = (text: string, line: number | undefined) => {
  if (!line) return null;
  const lines = text.split("\n");
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  return {
    before: index ? `${lines.slice(0, index).join("\n")}\n` : "",
    highlighted: lines[index] ?? "",
    after: index < lines.length - 1 ? `\n${lines.slice(index + 1).join("\n")}` : ""
  };
};

const filePreviewErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("file_not_found") || message.includes("ENOENT")) return "The file no longer exists on this machine.";
  if (message.includes("Machine is offline")) return "The machine that owns this file is offline.";
  if (message.includes("absolute_path_required") || message.includes("invalid_path")) return "The file path is invalid.";
  return `Could not load this file: ${message}`;
};

const formatByteSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fileLinkCopyActions = (target: LocalFileLinkTarget) => {
  const actions = [
    { key: "relative", label: "Copy relative path", value: target.label },
    { key: "path", label: "Copy file path", value: target.fullPath },
    { key: "full", label: "Copy path with line", value: target.title }
  ];
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.value)) return false;
    seen.add(action.value);
    return true;
  });
};

type MarkdownInteractionContextValue = {
  threadWorkingDirectory?: string;
  onFileLinkClick: (target: LocalFileLinkTarget, event: React.MouseEvent<HTMLAnchorElement>) => void;
  onOpenImage?: (image: ImagePreviewState) => void;
};

const MarkdownInteractionContext = React.createContext<MarkdownInteractionContextValue | null>(null);
const markdownRemarkPlugins = [remarkGfm];

export const markdownComponents: Components = {
  a: ({ children, href, className, title, ...props }) => {
    const interaction = React.useContext(MarkdownInteractionContext);
    const fileTarget = localFileLinkTargetFromHref(href, interaction?.threadWorkingDirectory);
    const linkClassName = [className, fileTarget ? "localFileLink" : null].filter(Boolean).join(" ") || undefined;
    return (
      <a
        {...props}
        href={href}
        className={linkClassName}
        target={fileTarget ? undefined : "_blank"}
        rel={fileTarget ? undefined : "noreferrer"}
        title={fileTarget?.title ?? title}
        aria-label={fileTarget ? `File link ${fileTarget.title}` : props["aria-label"]}
        onClick={fileTarget && interaction ? (event) => interaction.onFileLinkClick(fileTarget, event) : undefined}
      >
        {fileTarget?.label ?? children}
      </a>
    );
  },
  img: ({ src, alt, className, title, ...props }) => {
    const { onOpenImage } = React.useContext(MarkdownInteractionContext) ?? {};
    // Markdown images and attachment thumbnails share the same preview dialog behavior.
    const imageUrl = typeof src === "string" ? authenticatedFileUrl(src) : src;
    const imageTitle = title || alt || imageUrl || "Image";
    const imageClassName = [className, onOpenImage ? "messageMarkdownImage interactive" : "messageMarkdownImage"].filter(Boolean).join(" ");
    const openImage = (event: React.MouseEvent<HTMLImageElement> | React.KeyboardEvent<HTMLImageElement>) => {
      if (!onOpenImage || typeof imageUrl !== "string") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenImage({ url: imageUrl, title: imageTitle });
    };
    return (
      <img
        {...props}
        src={imageUrl}
        alt={alt ?? ""}
        className={imageClassName}
        title={imageTitle}
        role={onOpenImage ? "button" : undefined}
        tabIndex={onOpenImage ? 0 : undefined}
        onClick={onOpenImage ? openImage : undefined}
        onKeyDown={onOpenImage ? (event) => {
          if (event.key === "Enter" || event.key === " ") openImage(event);
        } : undefined}
      />
    );
  },
  pre: ({ children }) => (
    <div className="markdownCodeBlock">
      {children}
    </div>
  ),
  code: ({ children, className, ...props }) => {
    const language = markdownCodeLanguage(className);
    if (!language) return <code className={className} {...props}>{children}</code>;
    const code = String(children).replace(/\n$/, "");
    return (
      <Suspense fallback={<code className="markdownHighlightedCode">{code}</code>}>
        <SyntaxCodeBlock language={language}>{code}</SyntaxCodeBlock>
      </Suspense>
    );
  },
  table: ({ children }) => (
    <div className="markdownTableScroll">
      <table>{children}</table>
    </div>
  )
};

type LocalFileLinkTarget = {
  path: string;
  line?: number;
  column?: number;
  fullPath: string;
  label: string;
  title: string;
};

const localFileLinkTargetFromHref = (
  href: string | undefined,
  threadWorkingDirectory: string | undefined
): LocalFileLinkTarget | null => {
  if (!href) return null;
  const decoded = decodeHref(href.trim());
  if (!decoded) return null;
  const isFileUrl = decoded.startsWith("file://");
  const filePath = isFileUrl ? filePathFromFileUrl(decoded) : decoded;
  if (!filePath || !isAbsoluteFilePath(filePath)) return null;
  const location = splitFileLocation(filePath);
  if (!isFileUrl && !hasFileLinkSignal(location)) return null;
  const fullPath = normalizePathSeparators(location.path);
  return {
    ...location,
    fullPath,
    label: formatFileLocation(displayFilePathForThread(location.path, threadWorkingDirectory), location),
    title: formatFileLocation(fullPath, location)
  };
};

const decodeHref = (href: string) => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

const filePathFromFileUrl = (href: string) => {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const filePath = decodeURIComponent(url.pathname);
    return /^\/[a-zA-Z]:\//.test(filePath) ? filePath.slice(1) : filePath;
  } catch {
    return null;
  }
};

const isAbsoluteFilePath = (value: string) =>
  value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);

const splitFileLocation = (value: string): Pick<LocalFileLinkTarget, "path" | "line" | "column"> => {
  const match = /^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$/.exec(value);
  if (!match) return { path: value };
  const line = match[2] ? Number(match[2]) : undefined;
  const column = match[3] ? Number(match[3]) : undefined;
  return {
    path: match[1] || value,
    ...(line ? { line } : {}),
    ...(column ? { column } : {})
  };
};

const hasFileLinkSignal = (location: Pick<LocalFileLinkTarget, "path" | "line">) =>
  Boolean(location.line) || /(^|\/)[^/]+\.[^/]+$/.test(normalizePathSeparators(location.path));

const formatFileLocation = (
  filePath: string,
  location: Pick<LocalFileLinkTarget, "line" | "column">
) => [
  filePath,
  location.line ? String(location.line) : null,
  location.column ? String(location.column) : null
].filter(Boolean).join(":");

const displayFilePathForThread = (filePath: string, threadWorkingDirectory: string | undefined) => {
  const normalizedPath = normalizePathSeparators(filePath);
  const normalizedBase = normalizeThreadBasePath(threadWorkingDirectory);
  if (!normalizedBase) return normalizedPath;
  const isWindowsPath = /^[a-zA-Z]:\//.test(normalizedPath);
  const comparablePath = comparableFilePath(normalizedPath, isWindowsPath);
  const comparableBase = comparableFilePath(normalizedBase, isWindowsPath);
  if (comparablePath === comparableBase) return ".";
  const prefix = normalizedBase === "/" ? "/" : `${normalizedBase}/`;
  const comparablePrefix = comparableBase === "/" ? "/" : `${comparableBase}/`;
  return comparablePath.startsWith(comparablePrefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
};

const normalizeThreadBasePath = (value: string | undefined) => {
  if (!value?.trim()) return "";
  const normalized = normalizePathSeparators(value.trim());
  if (normalized === "/") return normalized;
  if (/^[a-zA-Z]:\/?$/.test(normalized)) return normalized.replace(/\/$/, "");
  return normalized.replace(/\/+$/, "");
};

const normalizePathSeparators = (value: string) => value.replace(/\\/g, "/");

const comparableFilePath = (value: string, isWindowsPath: boolean) =>
  isWindowsPath ? value.toLowerCase() : value;

const orderedActivityStatuses = (statuses: ActivityStatusView[]) => [...statuses]
  .sort((left, right) => activityStatusPriority(left.key) - activityStatusPriority(right.key));

export const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

export const StatusCardOverview = ({
  executionMeta,
  turnActive,
  statuses,
  backgroundTerminals = [],
  expanded,
  onToggleExpanded
}: {
  executionMeta: ThreadExecutionMeta;
  turnActive: boolean;
  statuses: ActivityStatusView[];
  backgroundTerminals?: BackgroundTerminalView[];
  expanded: boolean;
  onToggleExpanded: () => void;
}) => {
  const orderedStatuses = turnActive ? orderedActivityStatuses(statuses) : [];
  const summaryStatuses = orderedStatuses.filter((status) => status.summaryText);
  const hasBackgroundTerminals = backgroundTerminals.length > 0;
  const hasPanelDetails = statuses.length > 0 || hasBackgroundTerminals;
  const hasHeaderMetrics = summaryStatuses.length > 0 || hasBackgroundTerminals;
  return (
    <div
      className="activityStatusCardOverview"
      aria-label={`Thread status: ${executionMeta.label}`}
      title={`Thread · ${executionMeta.text}`}
    >
      <span className={`activityStatusSummary ${executionMeta.status}`}>
        <span className="activityStatusIndicator" aria-hidden="true" />
        <strong>{executionMeta.label}</strong>
      </span>
      {hasHeaderMetrics ? (
        <span className="activityStatusHeaderMetrics">
          {summaryStatuses.map((status) => (
            <span className={`activityStatusHeaderMetric ${status.key}`} title={`${status.label}: ${status.text}`} key={status.key}>
              <strong>{status.label}</strong>
              <span>{renderActivityStatusText(status.summaryText ?? status.text)}</span>
            </span>
          ))}
          {hasBackgroundTerminals ? (
            <span
              className="activityStatusHeaderMetric background"
              title={`${backgroundTerminals.length} background process${backgroundTerminals.length === 1 ? "" : "es"}`}
            >
              <strong>BG</strong>
              <span>{backgroundTerminals.length}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {hasPanelDetails ? (
        <button
          type="button"
          className="activityStatusToggle"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse activity details" : "Expand activity details"}
          title={expanded ? "Collapse activity details" : "Expand activity details"}
        >
          <StatusPanelToggleIcon expanded={expanded} size={14} strokeWidth={2.4} />
        </button>
      ) : null}
    </div>
  );
};

export const ThreadStatusCard = ({
  backgroundTerminals = [],
  visible = true,
  onTerminate,
}: {
  backgroundTerminals?: BackgroundTerminalView[];
  visible?: boolean;
  onTerminate: (processId: string) => void | Promise<void>;
}) => {
  const [expanded, setExpanded] = useState(true);
  const [terminatingProcessIds, setTerminatingProcessIds] = useState<Set<string>>(() => new Set());
  if (!visible || !backgroundTerminals.length) return null;
  const backgroundRegistry = createStatusRegistry();
  for (const terminal of backgroundTerminals) {
    const terminating = terminatingProcessIds.has(terminal.processId);
    backgroundRegistry.register({
      id: `thread:background-terminal:${terminal.itemId}:${terminal.processId}`,
      scope: "thread",
      status: "in_progress",
      preview: backgroundTerminalPreview(terminal),
      actions: (
        <button
          type="button"
          className="statusRegistryAction"
          disabled={terminating}
          aria-busy={terminating}
          aria-label={`Terminate background process ${terminal.command}`}
          title={terminating ? "Terminating background process" : "Terminate background process"}
          onClick={() => {
            setTerminatingProcessIds((current) => new Set(current).add(terminal.processId));
            void Promise.resolve(onTerminate(terminal.processId)).catch(() => undefined).finally(() => {
              setTerminatingProcessIds((current) => {
                const next = new Set(current);
                next.delete(terminal.processId);
                return next;
              });
            });
          }}
        >
          <X size={13} strokeWidth={2.3} aria-hidden="true" />
        </button>
      ),
      ariaLabel: `Background process: ${terminal.command}`
    });
  }
  const registry = createStatusRegistry();
  registry.register({
    id: "thread:backgrounds",
    scope: "thread",
    status: "in_progress",
    preview: (
      <>
        <span className="statusRegistryLabel">BACKGROUNDS</span>
        <span className="statusRegistryText">
          {backgroundTerminals.length} process{backgroundTerminals.length === 1 ? "" : "es"}
        </span>
      </>
    ),
    detail: <StatusRegistryRows entries={backgroundRegistry.entries("thread")} />,
    expanded,
    onToggle: () => setExpanded((current) => !current),
    ariaLabel: `Backgrounds: ${backgroundTerminals.length} process${backgroundTerminals.length === 1 ? "" : "es"}`
  });
  return (
    <div className="activityStatusSection threadStatusCard" aria-label="Thread background processes">
      <StatusRegistryRows entries={registry.entries("thread")} />
    </div>
  );
};

export const ActivityStatusBar = ({
  statuses,
  expanded,
  expandedKeys,
  expandedKeysInitialized = true,
  onToggle
}: {
  statuses: ActivityStatusView[];
  expanded: boolean;
  expandedKeys: Set<string>;
  expandedKeysInitialized?: boolean;
  onToggle: (key: string, expanded: boolean) => void;
}) => {
  if (!expanded) return null;
  const registry = createStatusRegistry();
  for (const status of orderedActivityStatuses(statuses)) {
    const detail = status.steps?.length || status.files?.length ? (
      <>
        {status.steps?.length ? <ActivityStatusPlanSteps steps={status.steps} /> : null}
        {status.files?.length ? <ActivityStatusFiles files={status.files} /> : null}
      </>
    ) : undefined;
    registry.register({
      id: `turn:${status.key}`,
      scope: "turn",
      status: status.status,
      preview: (
        <>
          <span className="statusRegistryLabel">{status.label}</span>
          <span className="statusRegistryText">{renderActivityStatusText(status.text)}</span>
        </>
      ),
      detail,
      defaultExpanded: status.key === "plan",
      expanded: expandedKeysInitialized ? expandedKeys.has(status.key) : undefined,
      onToggle: () => onToggle(status.key, expandedKeysInitialized ? expandedKeys.has(status.key) : status.key === "plan"),
      ariaLabel: `${status.label}: ${status.text}`
    });
  }
  return (
    <div className="activityStatusSection turnStatusCard expanded" aria-label="Turn details">
      <StatusRegistryRows entries={registry.entries("turn")} />
    </div>
  );
};

const backgroundTerminalPreview = (terminal: BackgroundTerminalView) => {
  const metrics = [
    terminal.cpuPercent == null ? null : `CPU ${terminal.cpuPercent.toFixed(1)}%`,
    terminal.rssKb == null ? null : `RSS ${formatByteSize(terminal.rssKb * 1024)}`
  ].filter(Boolean).join(" · ");
  return (
    <>
      <span className="statusRegistryMain backgroundTerminalMain">
        <code className="backgroundTerminalCommand" title={terminal.command}>{terminal.command}</code>
        <span className="backgroundTerminalSeparator" aria-hidden="true">·</span>
        <span className="backgroundTerminalMeta" title={terminal.cwd}>
          {terminal.cwd}
          {metrics ? ` · ${metrics}` : ""}
        </span>
      </span>
      <span className="backgroundTerminalStatus">
        <LiveStatusLabel status="in_progress" statusText="running" startedAt={terminal.startedAt} />
      </span>
    </>
  );
};

export const ActivityStatusRows = ({
  statuses,
  expandedKeys,
  onToggle,
  showPlanSteps = false
}: {
  statuses: ActivityStatusView[];
  expandedKeys?: Set<string>;
  onToggle?: (key: string) => void;
  showPlanSteps?: boolean;
}) => (
  <div className={`activityStatusRows${expandedKeys?.size ? " expanded" : ""}`}>
    {statuses.map((status) => {
      const planExpanded = Boolean(showPlanSteps || expandedKeys?.has(status.key));
      const expandable = Boolean(!showPlanSteps && onToggle && (status.files?.length || status.steps?.length));
      const expanded = Boolean(expandedKeys?.has(status.key));
      const itemClass = [
        "activityStatusItem",
        status.status ?? "",
        expandable ? "hasDetails" : "",
        expanded ? "expanded" : ""
      ].filter(Boolean).join(" ");
      const content = (
        <>
          <span className="activityStatusLabel">{status.label}</span>
          <span className="activityStatusViewport">
            <span className="activityStatusTrack">{renderActivityStatusText(status.text)}</span>
          </span>
          {status.steps?.length && planExpanded ? <ActivityStatusPlanSteps steps={status.steps} /> : null}
          {expanded && status.files?.length ? <ActivityStatusFiles files={status.files} /> : null}
        </>
      );
      return expandable ? (
        <button
          type="button"
          className={itemClass}
          key={status.key}
          onClick={() => onToggle?.(status.key)}
          aria-expanded={expanded}
        >
          {content}
        </button>
      ) : (
        <div className={itemClass} key={status.key}>
          {content}
        </div>
      );
    })}
  </div>
);

const ActivityStatusPlanSteps = ({ steps }: { steps: ActivityStatusPlanStep[] }) => (
  <ol className="activityStatusPlanSteps" aria-label="Plan steps">
    {steps.map((step, index) => (
      <li className={`activityStatusPlanStep ${step.status}`} key={`${index}:${step.step}`}>
        <span className="activityStatusPlanStepIcon" aria-hidden="true">
          {updatePlanStatusIcon(step.status)}
        </span>
        <span className="activityStatusPlanStepText">{step.step}</span>
      </li>
    ))}
  </ol>
);

const MessageActivityStatusSnapshot = ({ statuses }: { statuses: ActivityStatusView[] }) => {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  return (
    <div className="messageActivityStatusSnapshot" aria-label="Run status details">
      <ActivityStatusRows
        statuses={statuses}
        expandedKeys={expandedKeys}
        onToggle={(key) => setExpandedKeys((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })}
      />
    </div>
  );
};

const renderActivityStatusText = (text: string) =>
  text.split(/([+-]\d+)/g).map((part, index) => {
    if (!part) return null;
    if (/^\+\d+$/.test(part)) return <span className="activityStatusDelta added" key={`${part}:${index}`}>{part}</span>;
    if (/^-\d+$/.test(part)) return <span className="activityStatusDelta removed" key={`${part}:${index}`}>{part}</span>;
    return <React.Fragment key={`${part}:${index}`}>{part}</React.Fragment>;
  });

export const ActivityStatusFiles = ({ files }: { files: ActivityStatusFile[] }) => (
  <div className="activityStatusFiles">
    {files.map((file, index) => (
      <div className="fileChangeRow" key={`${file.path}:${index}`} title={file.path}>
        <span className="fileChangePath">{file.path}</span>
        <span className="fileChangeStat added">+{file.added ?? "?"}</span>
        <span className="fileChangeStat removed">-{file.removed ?? "?"}</span>
      </div>
    ))}
  </div>
);

export const ToolInspectBody = ({
  message,
  onOpenImage
}: {
  message: WebRecordView;
  onOpenImage?: (image: ImagePreviewState) => void;
}) => {
  const detail = formatInspectDetail(message);
  return (
    <div className="detailBody">
      <section className="detailSection">
        <h3>Input</h3>
        <pre>{detail.inputMeta || "(empty)"}</pre>
        {detail.inputBlock ? (
          <div className="detailCodeBlock">
            <h4>{detail.inputBlockLabel ?? "Content"}</h4>
            <pre>{detail.inputBlock}</pre>
          </div>
        ) : null}
      </section>
      {detail.memoryCitation?.entries.length || detail.memoryCitation?.rolloutIds.length ? (
        <section className="detailSection">
          <h3>Memory</h3>
          <MemoryCitationPanel citation={detail.memoryCitation} />
        </section>
      ) : null}
      {detail.outputMeta || detail.outputBlock ? (
        <section className="detailSection">
          <h3>Output</h3>
          {detail.outputMeta ? <pre>{detail.outputMeta}</pre> : null}
          {detail.outputBlock ? (
            <div className="detailCodeBlock">
              <h4>{detail.outputBlockLabel ?? "Text"}</h4>
              <pre>{detail.outputBlock}</pre>
            </div>
          ) : null}
        </section>
      ) : null}
      {detail.imageUrls?.length ? (
        <section className="detailSection">
          <h3>Images</h3>
          <div className="messageAttachments">
            {detail.imageUrls.map((url) => {
              const imageUrl = authenticatedFileUrl(url);
              return (
                <button
                  type="button"
                  className="messageImage"
                  key={url}
                  onClick={() => onOpenImage?.({ url: imageUrl, title: message.text || message.label })}
                  aria-label="View image"
                >
                  <img src={imageUrl} alt="generated" />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
};
