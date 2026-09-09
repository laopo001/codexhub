import React from "react";
import { createPortal } from "react-dom";
import { Bot, ExternalLink, GripVertical, Info } from "lucide-react";
import type { OpenThreadState, RuntimeSummary, SubagentThreadOpenOptions } from "./types.js";
import { threadDisplayRecords } from "./helpers/records.js";
import {
  aggregateCodexhubToolTasks,
  codexhubAttachedThread,
  type CodexhubToolCall,
  type CodexhubToolTaskState
} from "./helpers/codexhubToolCall.js";

type ContextValue = {
  runtimes: RuntimeSummary[];
  open: (call: CodexhubToolCall) => void;
};
const Context = React.createContext<ContextValue | null>(null);
const EMPTY_RECORDS = [] as const;
const DEFAULT_PANEL_WIDTH = 360;

export const CodexhubToolProvider = ({ activeThreadId, runtimes, threads, onOpen, children }: {
  activeThreadId?: string;
  runtimes: RuntimeSummary[];
  threads: OpenThreadState[];
  onOpen: (threadId: string, options?: SubagentThreadOpenOptions) => void | Promise<void>;
  children: React.ReactNode;
}) => {
  const [position, setPosition] = React.useState(() => ({
    x: typeof window === "undefined" ? 24 : Math.max(8, window.innerWidth - DEFAULT_PANEL_WIDTH - 24),
    y: 56
  }));
  const [taskState, setTaskState] = React.useState<CodexhubToolTaskState | undefined>(undefined);
  const panelRef = React.useRef<HTMLElement>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const parent = activeThreadId ? threads.find(thread => thread.threadId === activeThreadId) : undefined;
  const parentRecords = parent ? threadDisplayRecords(parent.threadId, parent) : EMPTY_RECORDS;
  React.useEffect(() => {
    if (!activeThreadId || !parent) {
      setTaskState(undefined);
      return;
    }
    setTaskState(previous => aggregateCodexhubToolTasks(previous, activeThreadId, parentRecords));
  }, [activeThreadId, parent, parentRecords]);
  const tasks = taskState && taskState.parentThreadId === activeThreadId ? taskState.tasks : [];
  const clamp = React.useCallback((x: number, y: number) => ({
    x: Math.max(8, Math.min(x, window.innerWidth - (panelRef.current?.offsetWidth ?? DEFAULT_PANEL_WIDTH) - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - (panelRef.current?.offsetHeight ?? 250) - 8))
  }), []);
  React.useEffect(() => {
    const resize = () => setPosition(p => clamp(p.x, p.y));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [clamp]);
  React.useLayoutEffect(() => {
    if (!tasks.length || !panelRef.current) return;
    const fit = () => setPosition(p => {
      const next = clamp(p.x, p.y);
      return next.x === p.x && next.y === p.y ? p : next;
    });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [clamp, tasks.length]);
  const value: ContextValue = {
    runtimes,
    open: next => {
      const target = codexhubAttachedThread(next.threadId, runtimes, next.invocation.machineId);
      if (!target?.runtime.online || !next.threadId || next.threadId === next.parentThreadId) return;
      void onOpen(next.threadId, { parentThreadId: next.parentThreadId, origin: "codexhub", machineId: target.runtime.machineId, agentPath: next.invocation.name ?? "CodexHub",
        assignment: { initialMessage: next.invocation.input, model: next.invocation.model, reasoningEffort: next.invocation.effort } });
    }
  };
  return <Context.Provider value={value}>
    {children}
    {tasks.length > 0 && typeof document !== "undefined" ? createPortal(
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
          <GripVertical size={14} /><span>任务 · {tasks.length}</span>
        </header>
        <div className="codexhubFloatingTaskList">
          {tasks.map(task => <CodexhubToolPreview key={`${task.parentThreadId}:${task.threadId ?? task.recordId}`} call={task} />)}
        </div>
      </aside>, document.body) : null}
  </Context.Provider>;
};

export const CodexhubToolPreview = ({ call, onInspect }: { call: CodexhubToolCall; onInspect?: () => void }) => {
  const context = React.useContext(Context);
  const target = codexhubAttachedThread(call.threadId, context?.runtimes ?? [], call.invocation.machineId);
  const canOpen = Boolean(context && target?.runtime.online && call.threadId !== call.parentThreadId);
  const status = call.lastOperation === "end"
    ? call.status === "failed" ? "结束失败" : "结束未确认"
    : target ? target.runtime.online ? target.thread.status === "waiting" ? "等待输入" : target.thread.running ? "运行中" : "待续接" : "离线"
      : call.status === "failed" ? "调用失败" : call.threadId ? "当前后端未找到线程" : call.status === "completed" ? "未获取 Thread ID" : "等待 Thread ID";
  const taskName = call.invocation.name ?? target?.thread.title ?? `CodexHub ${call.invocation.operation}`;
  return <section className="codexhubTaskPreview" aria-label="CodexHub 调用">
    <div className="codexhubTaskHeading"><Bot size={17} /><strong title={taskName}>{taskName}</strong>
      <span className={target?.thread.running ? "running" : ""}>{status}</span>
      {onInspect ? <button type="button" className="iconButton" aria-label="查看原始工具详情" onClick={event => { event.stopPropagation(); onInspect(); }}><Info size={14} /></button> : null}
      {context ? <button type="button" className="iconButton codexhubTaskOpen" aria-label="查看完整线程" title="查看完整线程" disabled={!canOpen} onClick={event => { event.stopPropagation(); context.open(call); }}><ExternalLink size={13} /><span>查看</span></button> : null}
    </div>
  </section>;
};
