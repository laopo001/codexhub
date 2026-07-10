import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import { Switch } from "antd";
import { ChevronDown, ChevronUp } from "lucide-react";
import remarkGfm from "remark-gfm";
import { highlightedLanguages, isVscodeSurface, languageAliases } from "../appConfig.js";
import type { ActivityStatusFile, ActivityStatusView, ImagePreviewState, MemoryCitationEntry, MemoryCitationView, MessageRenderMode, ThreadExecutionMeta, WebRecordView } from "../types.js";
import type { AppServerApprovalDecision, AppServerUserInputAnswers } from "../../shared/apiContract.js";
import { asRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { authToken } from "./core.js";
import { contextMenuPosition, writeTextToClipboard } from "./composer.js";
import { LiveStatusLabel, LiveThreadExecutionText, StatusStartedAtContext } from "./liveTime.js";
import { formatInspectDetail, formatInspectTitle, renderToolMessageBody } from "./toolPreview.js";
import { activityStatusTitle, formatMessageMeta, formatMessageMetaTitle } from "./records.js";

const SyntaxCodeBlock = lazy(() => import("../SyntaxCodeBlock.js"));

// <img> requests cannot carry Authorization headers, so auth-protected file previews use the existing query token path.
const authenticatedImageUrl = (url: string) => {
  if (!isFileApiUrl(url)) return url;
  if (typeof window === "undefined") return url;
  const token = authToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.origin);
  if (!parsed.searchParams.has("codexhub_token") && !parsed.searchParams.has("token")) {
    parsed.searchParams.set("codexhub_token", token);
  }
  return url.startsWith("http://") || url.startsWith("https://")
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}`;
};

const isFileApiUrl = (url: string) => {
  if (url.startsWith("/api/file?") || url === "/api/file") return true;
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname === "/api/file";
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
  threadWorkingDirectory,
  onRenderModeChange,
  onContextMenu,
  onInspect,
  onToggleToolBatch,
  onApprovalDecision,
  onUserInputResponse,
  onFork,
  onRollback,
  onOpenImage
}: {
  message: WebRecordView;
  showStatus?: boolean;
  showTimestamp?: boolean;
  renderToolPreview?: boolean;
  renderMode: MessageRenderMode;
  markdownEnabled: boolean;
  threadWorkingDirectory?: string;
  onRenderModeChange?: (mode: MessageRenderMode) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  onInspect?: () => void;
  onToggleToolBatch?: () => void;
  onApprovalDecision?: (approvalId: string, decision: AppServerApprovalDecision) => void;
  onUserInputResponse?: (userInputId: string, answers: AppServerUserInputAnswers) => void | Promise<void>;
  onFork?: () => void;
  onRollback?: () => void;
  onOpenImage?: (image: ImagePreviewState) => void;
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
  const approvalActions = approval ? approvalDecisionActions(approval.kind) : [];
  const hasMessageMeta = !isThinkingMessage && (
    (showTimestamp && message.at)
    || message.usage
    || markdownEnabled
    || approval
    || onFork
    || onRollback
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
      className={`message ${message.role} ${messageToneClass} ${hasToolBody ? "richTool" : ""} ${canClickInspect ? "inspectableTool" : ""} ${onContextMenu ? "hasContextMenu" : ""} ${renderMode === "markdown" ? "markdownMode" : "rawMode"}`}
      onContextMenu={onContextMenu}
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
            const imageUrl = authenticatedImageUrl(attachment.url);
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
            <a href="#" onClick={(event) => {
              event.preventDefault();
              onFork();
            }}>Fork</a>
          ) : null}
          {onRollback ? (
            <a href="#" onClick={(event) => {
              event.preventDefault();
              onRollback();
            }}>Rollback</a>
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
                  key={action.decision}
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

export const memoryCitationBlockPattern = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;

export const emptyMemoryCitation = (text: string): MemoryCitationView => ({ text, entries: [], rolloutIds: [] });

const pendingApprovalFromMessage = (message: WebRecordView) => {
  const payload = asRecord(message.record.payload);
  const approval = asRecord(payload?.approval);
  const approvalId = typeof approval?.approvalId === "string" ? approval.approvalId : "";
  const status = typeof approval?.status === "string" ? approval.status : "";
  const kind = typeof approval?.kind === "string" ? approval.kind : "";
  return approvalId && status === "pending" ? { approvalId, kind } : null;
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

const approvalDecisionActions = (kind: string): Array<{
  decision: AppServerApprovalDecision;
  label: string;
  className: string;
  title: string;
}> => {
  const actions: Array<{
    decision: AppServerApprovalDecision;
    label: string;
    className: string;
    title: string;
  }> = [{
    decision: "approve",
    label: "Approve",
    className: "approve",
    title: "Approve this request once"
  }];
  if (kind !== "mcp_elicitation") {
    actions.push({
      decision: "approve_for_session",
      label: "Session",
      className: "approve session",
      title: "Approve similar requests for this session"
    });
  }
  actions.push({
    decision: "deny",
    label: "Deny",
    className: "deny",
    title: "Decline this request"
  });
  if (kind !== "permissions_request") {
    actions.push({
      decision: "cancel",
      label: "Cancel",
      className: "cancel",
      title: "Cancel this request"
    });
  }
  return actions;
};

export const shouldExtractMemoryCitation = (message: WebRecordView) =>
  message.role === "codex" && message.label === "final_answer";

export const parseMemoryCitationText = (text: string): MemoryCitationView => {
  const blocks = text.match(memoryCitationBlockPattern) ?? [];
  if (!blocks.length) return { text, entries: [], rolloutIds: [] };
  const entries = blocks.flatMap(parseMemoryCitationEntries);
  const rolloutIds = [...new Set(blocks.flatMap(parseMemoryCitationRolloutIds))];
  return {
    text: text.replace(memoryCitationBlockPattern, "").trimEnd(),
    entries,
    rolloutIds
  };
};

export const parseMemoryCitationEntries = (block: string): MemoryCitationEntry[] =>
  xmlSectionLines(block, "citation_entries").flatMap((line) => {
    const parsed = parseMemoryCitationEntry(line);
    return parsed ? [parsed] : [];
  });

export const parseMemoryCitationRolloutIds = (block: string) =>
  xmlSectionLines(block, "rollout_ids").filter((line) => line.trim().length > 0);

export const parseMemoryCitationEntry = (line: string): MemoryCitationEntry | null => {
  const raw = line.trim();
  if (!raw) return null;
  const [location, notePart] = splitMemoryCitationNote(raw);
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(location.trim());
  if (!match) return { source: location.trim() || raw, note: notePart, raw };
  const source = match[1]?.trim() || raw;
  const lineStart = match[2] ? Number(match[2]) : undefined;
  const lineEnd = match[3] ? Number(match[3]) : lineStart;
  return {
    source,
    lineStart,
    lineEnd,
    note: notePart,
    raw
  };
};

export const splitMemoryCitationNote = (line: string): [string, string | undefined] => {
  const marker = "|note=";
  const index = line.indexOf(marker);
  if (index === -1) return [line, undefined];
  const note = line.slice(index + marker.length).trim();
  return [
    line.slice(0, index),
    note.startsWith("[") && note.endsWith("]") ? note.slice(1, -1) : note
  ];
};

export const xmlSectionLines = (block: string, tag: string) => {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(block);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => decodeXmlText(line.trim()))
    .filter(Boolean);
};

export const decodeXmlText = (text: string) => text
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'");

export const formatMemoryCitationCount = (count: number) => `${count} 条记忆引用`;

export const formatMemoryCitationLines = (entry: MemoryCitationEntry) => {
  if (!entry.lineStart) return "";
  if (!entry.lineEnd || entry.lineEnd === entry.lineStart) return `${entry.lineStart} 行`;
  return `${entry.lineStart}-${entry.lineEnd} 行`;
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
  threadWorkingDirectory,
  onOpenImage
}: {
  text: string;
  mode: MessageRenderMode;
  markdownEnabled: boolean;
  threadWorkingDirectory?: string;
  onOpenImage?: (image: ImagePreviewState) => void;
}) => {
  const [fileLinkMenu, setFileLinkMenu] = useState<FileLinkMenuState | null>(null);
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
    setFileLinkMenu({
      target,
      ...contextMenuPosition(event.clientX, event.clientY)
    });
  }, []);
  const components = useMemo(
    () => markdownComponents(threadWorkingDirectory, handleFileLinkClick, onOpenImage),
    [handleFileLinkClick, onOpenImage, threadWorkingDirectory]
  );
  useEffect(() => {
    if (!fileLinkMenu) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".fileLinkCopyMenu")) return;
      setFileLinkMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFileLinkMenu(null);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [fileLinkMenu]);
  if (!markdownEnabled || mode === "raw") return <pre>{text}</pre>;
  return (
    <div className="messageMarkdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
        {text}
      </ReactMarkdown>
      {fileLinkMenu ? (
        <FileLinkCopyMenu menu={fileLinkMenu} onClose={() => setFileLinkMenu(null)} />
      ) : null}
    </div>
  );
};

const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "href" && localFileLinkTargetFromHref(url, undefined)) return url;
  return defaultUrlTransform(url);
};

type FileLinkMenuState = {
  target: LocalFileLinkTarget;
  x: number;
  y: number;
};

const FileLinkCopyMenu = ({
  menu,
  onClose
}: {
  menu: FileLinkMenuState;
  onClose: () => void;
}) => {
  const actions = fileLinkCopyActions(menu.target);
  const copyValue = async (value: string) => {
    await writeTextToClipboard(value).catch(() => undefined);
    onClose();
  };
  return (
    <div
      className="fileLinkCopyMenu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="fileLinkCopyTitle" title={menu.target.title}>{menu.target.label}</div>
      {actions.map((action) => (
        <button type="button" role="menuitem" onClick={() => void copyValue(action.value)} key={action.key}>
          {action.label}
        </button>
      ))}
    </div>
  );
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

export const markdownComponents = (
  threadWorkingDirectory: string | undefined,
  onFileLinkClick: (target: LocalFileLinkTarget, event: React.MouseEvent<HTMLAnchorElement>) => void,
  onOpenImage?: (image: ImagePreviewState) => void
): Components => ({
  a: ({ children, href, className, title, ...props }) => {
    const fileTarget = localFileLinkTargetFromHref(href, threadWorkingDirectory);
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
        onClick={fileTarget ? (event) => onFileLinkClick(fileTarget, event) : undefined}
      >
        {fileTarget?.label ?? children}
      </a>
    );
  },
  img: ({ src, alt, className, title, ...props }) => {
    // Markdown images and attachment thumbnails share the same preview dialog behavior.
    const imageUrl = typeof src === "string" ? authenticatedImageUrl(src) : src;
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
});

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

export const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

export const ActivityStatusBar = ({
  statuses,
  executionMeta,
  expanded,
  expandedKeys,
  onToggleExpanded,
  onToggle
}: {
  statuses: ActivityStatusView[];
  executionMeta: ThreadExecutionMeta;
  expanded: boolean;
  expandedKeys: Set<string>;
  onToggleExpanded: () => void;
  onToggle: (key: string) => void;
}) => {
  const title = [executionMeta.text, statuses.length ? activityStatusTitle(statuses) : null]
    .filter(Boolean)
    .join("\n");
  const summaryStatuses = statuses.filter((status) => status.summaryText);
  const ToggleIcon = expanded ? ChevronDown : ChevronUp;
  return (
    <div
      className={`activityStatusBar ${executionMeta.status}${expanded ? " expanded" : ""}`}
      aria-live="polite"
      title={title}
    >
      <div className="activityStatusHeader" aria-label={`Status: ${executionMeta.text}`}>
        <span className={`activityStatusSummary ${executionMeta.status}`}>
          <span className="activityStatusIndicator" aria-hidden="true" />
          <strong>{executionMeta.label}</strong>
          {executionMeta.duration || executionMeta.startedAt ? (
            <span className="activityStatusDuration"><LiveThreadExecutionText executionMeta={executionMeta} includeLabel={false} /></span>
          ) : null}
        </span>
        {summaryStatuses.length ? (
          <span className="activityStatusHeaderMetrics">
            {summaryStatuses.map((status) => (
              <span className={`activityStatusHeaderMetric ${status.key}`} title={`${status.label}: ${status.text}`} key={status.key}>
                <strong>{status.label}</strong>
                <span>{renderActivityStatusText(status.summaryText ?? status.text)}</span>
              </span>
            ))}
          </span>
        ) : null}
        {statuses.length ? (
          <button
            type="button"
            className="activityStatusToggle"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse status details" : "Expand status details"}
            title={expanded ? "Collapse status details" : "Expand status details"}
          >
            <ToggleIcon size={14} strokeWidth={2.4} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {expanded && statuses.length ? (
        <ActivityStatusRows statuses={statuses} expandedKeys={expandedKeys} onToggle={onToggle} />
      ) : null}
    </div>
  );
};

export const ActivityStatusRows = ({
  statuses,
  expandedKeys,
  onToggle
}: {
  statuses: ActivityStatusView[];
  expandedKeys?: Set<string>;
  onToggle?: (key: string) => void;
}) => (
  <div className={`activityStatusRows${expandedKeys?.size ? " expanded" : ""}`}>
    {statuses.map((status) => {
      const expandable = Boolean(status.files?.length && onToggle);
      const expanded = Boolean(expandedKeys?.has(status.key));
      const itemClass = [
        "activityStatusItem",
        status.status ?? "",
        expandable ? "hasFiles" : "",
        expanded ? "expanded" : ""
      ].filter(Boolean).join(" ");
      const content = (
        <>
          <span className="activityStatusLabel">{status.label}</span>
          <span className="activityStatusViewport">
            <span className="activityStatusTrack">{renderActivityStatusText(status.text)}</span>
          </span>
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
              const imageUrl = authenticatedImageUrl(url);
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
