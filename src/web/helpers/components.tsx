import React, { Suspense, lazy, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Switch } from "antd";
import { GripHorizontal } from "lucide-react";
import remarkGfm from "remark-gfm";
import { highlightedLanguages, languageAliases } from "../appConfig.js";
import type { ActivityStatusFile, ActivityStatusView, MemoryCitationEntry, MemoryCitationView, MessageRenderMode, WebRecordView } from "../types.js";
import type { AppServerApprovalDecision } from "../../shared/apiContract.js";
import { asRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { statusLabel } from "./common.js";
import { formatInspectDetail, formatInspectTitle, renderToolMessageBody } from "./toolPreview.js";
import { activityStatusOverlayClass, activityStatusTitle, formatMessageMeta, formatMessageMetaTitle } from "./records.js";

const SyntaxCodeBlock = lazy(() => import("../SyntaxCodeBlock.js"));

type ActivityStatusOffset = {
  x: number;
  y: number;
};

type ActivityStatusDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: ActivityStatusOffset;
};

const ACTIVITY_STATUS_DEFAULT_LEFT = 12;
const ACTIVITY_STATUS_DEFAULT_TOP = 8;
const ACTIVITY_STATUS_EDGE_GAP = 8;

const clampActivityStatusOffset = (element: HTMLDivElement | null, offset: ActivityStatusOffset): ActivityStatusOffset => {
  const parent = element?.offsetParent;
  if (!(element && parent instanceof HTMLElement)) return offset;
  const minX = ACTIVITY_STATUS_EDGE_GAP - ACTIVITY_STATUS_DEFAULT_LEFT;
  const minY = ACTIVITY_STATUS_EDGE_GAP - ACTIVITY_STATUS_DEFAULT_TOP;
  const maxX = Math.max(minX, parent.clientWidth - element.offsetWidth - ACTIVITY_STATUS_DEFAULT_LEFT - ACTIVITY_STATUS_EDGE_GAP);
  const maxY = Math.max(minY, parent.clientHeight - element.offsetHeight - ACTIVITY_STATUS_DEFAULT_TOP - ACTIVITY_STATUS_EDGE_GAP);
  return {
    x: Math.min(maxX, Math.max(minX, offset.x)),
    y: Math.min(maxY, Math.max(minY, offset.y))
  };
};

export const MessageCard = ({
  message,
  showStatus = true,
  showTimestamp = true,
  renderToolPreview = true,
  renderMode,
  markdownEnabled,
  onRenderModeChange,
  onContextMenu,
  onInspect,
  onToggleToolBatch,
  onApprovalDecision,
  onFork,
  onRollback
}: {
  message: WebRecordView;
  showStatus?: boolean;
  showTimestamp?: boolean;
  renderToolPreview?: boolean;
  renderMode: MessageRenderMode;
  markdownEnabled: boolean;
  onRenderModeChange?: (mode: MessageRenderMode) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  onInspect?: () => void;
  onToggleToolBatch?: () => void;
  onApprovalDecision?: (approvalId: string, decision: AppServerApprovalDecision) => void;
  onFork?: () => void;
  onRollback?: () => void;
}) => {
  const isThinkingMessage = message.role === "thinking";
  const isToolBatch = Boolean(message.toolBatch);
  const toolBody = !isToolBatch && renderToolPreview ? renderToolMessageBody(message, showStatus ? message.status : undefined, showStatus ? message.statusText : undefined) : null;
  const hasToolBody = toolBody !== null;
  const memoryCitation = useMemo(() => {
    if (isThinkingMessage) return emptyMemoryCitation("");
    return shouldExtractMemoryCitation(message) ? parseMemoryCitationText(message.text) : emptyMemoryCitation(message.text);
  }, [message, isThinkingMessage]);
  const messageText = memoryCitation.text;
  const approval = pendingApprovalFromMessage(message);
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
          {showStatus && message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status, message.statusText)}</em> : null}
          <span className="toolBatchSummary">{message.toolBatch.labels.join(", ")}</span>
        </button>
      </article>
    );
  }
  return (
    <article
      className={`message ${message.role} ${hasToolBody ? "richTool" : ""} ${canClickInspect ? "inspectableTool" : ""} ${onContextMenu ? "hasContextMenu" : ""} ${renderMode === "markdown" ? "markdownMode" : "rawMode"}`}
      onContextMenu={onContextMenu}
      onClick={canClickInspect ? inspectOnClick : undefined}
      onKeyDown={canClickInspect ? inspectOnKeyDown : undefined}
      role={canClickInspect ? "button" : undefined}
      tabIndex={canClickInspect ? 0 : undefined}
    >
      {hasToolBody ? null : (
        <span className="messageHeader">
          <b>{message.label ?? message.role}</b>
          {showStatus && message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status, message.statusText)}</em> : null}
        </span>
      )}
      {hasToolBody ? (
        toolBody
      ) : messageText ? (
        <MessageText text={messageText} mode={renderMode} markdownEnabled={markdownEnabled} />
      ) : null}
      {!isThinkingMessage && (memoryCitation.entries.length || memoryCitation.rolloutIds.length) ? (
        <MemoryCitationPanel citation={memoryCitation} />
      ) : null}
      {!isThinkingMessage && message.attachments?.length ? (
        <div className="messageAttachments">
          {message.attachments.map((attachment) => attachment.type === "image" ? (
            <a
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="messageImage"
              key={attachment.url}
              onClick={(event) => event.stopPropagation()}
            >
              <img src={attachment.url} alt="attachment" />
            </a>
          ) : null)}
        </div>
      ) : null}
      {hasMessageMeta ? (
        <footer className="messageMeta" title={formatMessageMetaTitle(message, { showTimestamp })} onClick={(event) => event.stopPropagation()}>
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
              <button
                type="button"
                className="approvalButton approve"
                onClick={() => onApprovalDecision(approval.approvalId, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="approvalButton deny"
                onClick={() => onApprovalDecision(approval.approvalId, "deny")}
              >
                Deny
              </button>
            </span>
          ) : null}
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
        </footer>
      ) : null}
    </article>
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
  return approvalId && status === "pending" ? { approvalId } : null;
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
  markdownEnabled
}: {
  text: string;
  mode: MessageRenderMode;
  markdownEnabled: boolean;
}) => {
  if (!markdownEnabled || mode === "raw") return <pre>{text}</pre>;
  return (
    <div className="messageMarkdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
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

export const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

export const ActivityStatusOverlay = ({
  statuses,
  expandedKeys,
  onMinimize,
  onToggle
}: {
  statuses: ActivityStatusView[];
  expandedKeys: Set<string>;
  onMinimize: () => void;
  onToggle: (key: string) => void;
}) => {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<ActivityStatusDragState | null>(null);
  const [offset, setOffset] = useState<ActivityStatusOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const title = activityStatusTitle(statuses);
  const overlayStyle: React.CSSProperties = {
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`
  };
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: offset
    };
    setDragging(true);
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = {
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY
    };
    setOffset(clampActivityStatusOffset(overlayRef.current, next));
  };
  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser on cancel.
    }
  };
  return (
    <div
      ref={overlayRef}
      className={`activityStatusOverlay ${activityStatusOverlayClass(statuses)}${dragging ? " dragging" : ""}`}
      aria-live="polite"
      title={title}
      style={overlayStyle}
    >
      <ActivityStatusRows statuses={statuses} expandedKeys={expandedKeys} onToggle={onToggle} />
      <button
        type="button"
        className="activityStatusDragHandle"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        aria-label="Drag status"
        title="Drag status"
      >
        <GripHorizontal size={13} strokeWidth={2.4} aria-hidden="true" />
      </button>
      <button type="button" className="activityStatusMinimize" onClick={onMinimize} aria-label="Minimize status" title="Minimize status">−</button>
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
          className={`activityStatusItem hasFiles${expanded ? " expanded" : ""}`}
          key={status.key}
          onClick={() => onToggle?.(status.key)}
          aria-expanded={expanded}
        >
          {content}
        </button>
      ) : (
        <div className="activityStatusItem" key={status.key}>
          {content}
        </div>
      );
    })}
  </div>
);

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

export const ToolInspectBody = ({ message }: { message: WebRecordView }) => {
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
            {detail.imageUrls.map((url) => (
              <a href={url} target="_blank" rel="noreferrer" className="messageImage" key={url}>
                <img src={url} alt="generated" />
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};
