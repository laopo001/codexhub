import { randomUUID } from "node:crypto";
import type { MachineHub } from "../core/machineHub.js";
import type { CodexhubServerState } from "../core/serverState.js";
import type { ThreadHub } from "../core/threadHub.js";
import type { TaskMutationPayload, TasksStreamEvent, TaskView } from "../shared/apiContract.js";
import type { StoredTask } from "../shared/projectTypes.js";
import {
  cronMatches,
  cronMinuteKey,
  cronMinuteKeyFromIso,
  defaultTaskTimezone,
  nextCronRun
} from "../shared/taskCron.js";

export type TaskSchedulerOptions = {
  enabled: boolean;
  state: CodexhubServerState;
  machines: MachineHub;
  threads: ThreadHub;
  waitForSession: (sessionId: string) => Promise<unknown>;
};

export class TaskScheduler {
  readonly subscribers = new Set<(event: TasksStreamEvent) => void>();
  private readonly runningTasks = new Set<string>();
  private readonly triggeredTaskMinutes = new Map<string, string>();
  private seq = 0;

  constructor(private readonly options: TaskSchedulerOptions) {}

  start(intervalMs: number) {
    if (!this.options.enabled) return null;
    const timer = setInterval(() => void this.scan(new Date()), intervalMs);
    timer.unref?.();
    return timer;
  }

  snapshotEvent(): TasksStreamEvent {
    return { seq: this.seq, kind: "tasks", tasks: this.views() };
  }

  view(task: StoredTask): TaskView {
    return {
      ...task,
      nextRunAt: task.enabled
        ? nextCronRun(task.schedule, new Date(), defaultTaskTimezone)?.toISOString() ?? null
        : null
    };
  }

  views() {
    return this.options.state.listTasks().map((task) => this.view(task));
  }

  publish() {
    const event = { seq: ++this.seq, kind: "tasks" as const, tasks: this.views() } satisfies TasksStreamEvent;
    for (const subscriber of this.subscribers) subscriber(event);
  }

  async run(taskId: string): Promise<TaskMutationPayload> {
    if (!this.options.enabled) throw new Error("Tasks are disabled for this codexhub surface.");
    const task = this.options.state.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const runId = randomUUID();
    if (this.runningTasks.has(task.taskId)) {
      this.options.state.startTaskRun(task.taskId, { runId, machineId: task.machineId });
      const skippedTask = this.options.state.finishTaskRun(task.taskId, runId, {
        status: "skipped",
        machineId: task.machineId,
        error: "Task already running"
      });
      this.publish();
      return { ok: true, skipped: true, task: this.view(skippedTask) };
    }

    let releaseOnReturn = true;
    this.runningTasks.add(task.taskId);
    this.options.state.startTaskRun(task.taskId, { runId, machineId: task.machineId });
    this.publish();
    try {
      const started = this.options.machines.startSession(task.machineId, {
        cwd: task.projectPath,
        reuse: true
      });
      const session = await started.promise;
      const sessionId = session.sessionId;
      await this.options.waitForSession(sessionId);
      let threadId = task.threadId ?? session.threadId;
      if (task.threadId) {
        threadId = (await this.options.threads.resumeSessionThread(sessionId, task.threadId, task.projectPath)).threadId;
      } else {
        this.options.threads.attachSessionThread(sessionId, threadId, session.cwd);
      }
      const localCommand = this.options.threads.runLocalCommand(threadId, task.input, "task");
      if (localCommand.handled) {
        const completedTask = this.options.state.finishTaskRun(task.taskId, runId, {
          status: "completed",
          machineId: task.machineId,
          threadId
        });
        this.publish();
        return {
          ok: true,
          task: this.view(completedTask),
          machineId: task.machineId,
          threadId,
          command: localCommand.command
        };
      }
      const turn = this.options.threads.runTurn(threadId, task.input, "task");
      const queuedTask = this.options.state.updateTaskRun(task.taskId, { lastStatus: "queued", threadId });
      this.publish();
      releaseOnReturn = false;
      turn.then(() => {
        this.options.state.finishTaskRun(task.taskId, runId, {
          status: "completed",
          machineId: task.machineId,
          threadId
        });
        this.publish();
      }).catch((error: unknown) => {
        this.options.state.finishTaskRun(task.taskId, runId, {
          status: "failed",
          machineId: task.machineId,
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        this.publish();
      }).finally(() => this.runningTasks.delete(task.taskId));
      return { ok: true, task: this.view(queuedTask), machineId: task.machineId, threadId };
    } catch (error) {
      this.options.state.finishTaskRun(task.taskId, runId, {
        status: "failed",
        machineId: task.machineId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.publish();
      throw error;
    } finally {
      if (releaseOnReturn) this.runningTasks.delete(task.taskId);
    }
  }

  async scan(now: Date) {
    if (!this.options.enabled) return;
    for (const task of this.options.state.listTasks()) {
      if (!task.enabled || !cronMatches(task.schedule, now, defaultTaskTimezone)) continue;
      const minuteKey = cronMinuteKey(now, defaultTaskTimezone);
      if (this.triggeredTaskMinutes.get(task.taskId) === minuteKey) continue;
      if (cronMinuteKeyFromIso(task.lastRunAt, defaultTaskTimezone) === minuteKey) {
        this.triggeredTaskMinutes.set(task.taskId, minuteKey);
        continue;
      }
      this.triggeredTaskMinutes.set(task.taskId, minuteKey);
      void this.run(task.taskId).catch((error: unknown) => {
        console.error(`codexhub task failed: ${task.name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
