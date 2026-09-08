import React from "react";
import { createPortal } from "react-dom";
import { Bot, ExternalLink, GripVertical, Info, Pin, X } from "lucide-react";
import type { OpenThreadState, RuntimeSummary, SubagentThreadOpenOptions } from "./types.js";
import { threadDisplayRecords } from "./helpers/records.js";
import { codexhubAttachedThread, codexhubProgressLines, refreshCodexhubToolCall, type CodexhubToolCall } from "./helpers/codexhubToolCall.js";

type ContextValue = {
  runtimes: RuntimeSummary[];
  float: (call: CodexhubToolCall, rect?: DOMRect) => void;
  open: (call: CodexhubToolCall) => void;
};
const Context = React.createContext<ContextValue | null>(null);

export const CodexhubToolProvider = ({ runtimes, threads, onOpen, children }: {
  runtimes: RuntimeSummary[];
  threads: OpenThreadState[];
  onOpen: (threadId: string, options?: SubagentThreadOpenOptions) => void | Promise<void>;
  children: React.ReactNode;
}) => {
  const [floating, setFloating] = React.useState<CodexhubToolCall | null>(null);
  const [position, setPosition] = React.useState({ x: 24, y: 90 });
  const panelRef = React.useRef<HTMLElement>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const parent = floating ? threads.find(thread => thread.threadId === floating.parentThreadId) : undefined;
  const call = floating ? refreshCodexhubToolCall(floating, parent ? threadDisplayRecords(parent.threadId, parent) : []) : null;
  const clamp = React.useCallback((x: number, y: number) => ({
    x: Math.max(8, Math.min(x, window.innerWidth - (panelRef.current?.offsetWidth ?? 340) - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - (panelRef.current?.offsetHeight ?? 250) - 8))
  }), []);
  React.useEffect(() => {
    const resize = () => setPosition(p => clamp(p.x, p.y));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [clamp]);
  React.useLayoutEffect(() => {
    if (!floating || !panelRef.current) return;
    const fit = () => setPosition(p => {
      const next = clamp(p.x, p.y);
      return next.x === p.x && next.y === p.y ? p : next;
    });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [clamp, floating?.parentThreadId, floating?.recordId]);
  const value: ContextValue = {
    runtimes,
    float: (next, rect) => {
      setFloating(next);
      setPosition(clamp(rect?.left ?? 24, rect?.top ?? 90));
    },
    open: next => {
      const target = codexhubAttachedThread(next.threadId, runtimes, next.invocation.machineId);
      if (!target?.runtime.online || !next.threadId || next.threadId === next.parentThreadId) return;
      void onOpen(next.threadId, { parentThreadId: next.parentThreadId, origin: "codexhub", machineId: target.runtime.machineId, agentPath: next.invocation.name ?? "CodexHub",
        assignment: { initialMessage: next.invocation.input, model: next.invocation.model, reasoningEffort: next.invocation.effort } });
    }
  };
  return <Context.Provider value={value}>
    {children}
    {call && typeof document !== "undefined" ? createPortal(
      <aside ref={panelRef} className="codexhubFloatingTask" style={{ left: position.x, top: position.y }} aria-label="CodexHub 浮动任务">
        <header className="codexhubFloatingHandle" tabIndex={0} aria-label="移动浮动任务，方向键移动"
          onKeyDown={event => {
            const offset: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
            if (!offset[event.key]) return;
            event.preventDefault();
            const [x, y] = offset[event.key];
            setPosition(p => clamp(p.x + x, p.y + y));
          }}
          onPointerDown={event => {
            if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
            drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => { if (drag.current) setPosition(clamp(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y)); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <GripVertical size={14} /><span>CodexHub 任务 · 拖动移动</span>
          <button type="button" className="iconButton" onClick={() => setFloating(null)} aria-label="关闭浮动任务"><X size={14} /></button>
        </header>
        <CodexhubToolPreview call={call} floating />
      </aside>, document.body) : null}
  </Context.Provider>;
};

export const CodexhubToolPreview = ({ call, floating = false, onInspect }: { call: CodexhubToolCall; floating?: boolean; onInspect?: () => void }) => {
  const context = React.useContext(Context);
  const ref = React.useRef<HTMLElement>(null);
  const target = codexhubAttachedThread(call.threadId, context?.runtimes ?? [], call.invocation.machineId);
  const canOpen = Boolean(context && target?.runtime.online && call.threadId !== call.parentThreadId);
  const status = target ? target.runtime.online ? target.thread.status === "waiting" ? "等待输入" : target.thread.running ? "运行中" : "已结束" : "离线"
    : call.status === "failed" ? "调用失败" : call.threadId ? "当前后端未找到线程" : call.status === "completed" ? "未获取 Thread ID" : "等待 Thread ID";
  const progress = codexhubProgressLines(call.output);
  return <section ref={ref} className="codexhubTaskPreview" aria-label="CodexHub 调用">
    <div className="codexhubTaskHeading"><Bot size={17} /><strong>{call.invocation.name ?? target?.thread.title ?? `CodexHub ${call.invocation.operation}`}</strong>
      <span className={target?.thread.running ? "running" : ""}>{status}</span>
      {onInspect ? <button type="button" className="iconButton" aria-label="查看原始工具详情" onClick={event => { event.stopPropagation(); onInspect(); }}><Info size={14} /></button> : null}
      {!floating && context ? <button type="button" className="iconButton" aria-label="浮动查看任务" title="浮动查看并拖动任务" onClick={event => { event.stopPropagation(); context.float(call, ref.current?.getBoundingClientRect()); }}><Pin size={14} /></button> : null}
    </div>
    <div className="codexhubTaskMeta"><code>codexhub {call.invocation.operation}</code>{call.invocation.model ? <span>{call.invocation.model}</span> : null}{call.invocation.effort ? <span>{call.invocation.effort}</span> : null}</div>
    {call.invocation.cwd ? <div className="codexhubTaskPath" title={call.invocation.cwd}>{call.invocation.cwd}</div> : null}
    {call.threadId ? <code className="codexhubTaskId" title={call.threadId}>{call.threadId}</code> : null}
    {target?.thread.latestAgentMessage ? <p className="codexhubTaskLatest">{target.thread.latestAgentMessage}</p> : null}
    {progress ? <pre className="codexhubTaskProgress" aria-label="最近执行过程">{progress}</pre> : <p className="codexhubTaskPending">尚无执行输出</p>}
    <button type="button" className="secondaryButton codexhubTaskOpen" disabled={!canOpen} onClick={event => { event.stopPropagation(); context?.open(call); }}><ExternalLink size={13} />查看完整线程</button>
  </section>;
};
