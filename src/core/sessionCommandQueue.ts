import type { SessionCommand } from "../shared/threadTypes.js";
import type { SessionState } from "./threadHubState.js";

export const waitForSessionCommands = async (
  session: SessionState | undefined,
  sessionId: string,
  after: number,
  timeoutMs: number
) => {
  // 失效的 runtime 是终止条件，不能返回立即完成的空批次让 transport 忙循环。
  if (!session?.online) throw new Error(`Session is offline: ${sessionId}`);
  if (commandsAfter(session, after).length === 0) {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const waiter = () => {
        clearTimeout(timer);
        session.waiters.delete(waiter);
        resolve();
      };
      timer = setTimeout(waiter, timeoutMs);
      session.waiters.add(waiter);
    });
  }
  if (!session.online) throw new Error(`Session is offline: ${sessionId}`);
  const commands = commandsAfter(session, after);
  return {
    sessionId,
    cursor: commands.at(-1)?.seq ?? after,
    commands
  };
};

export const clampSessionCommandCursor = (session: SessionState | undefined, requestedCursor: number) =>
  Math.min(requestedCursor, session?.commands.at(-1)?.seq ?? 0);

export const enqueueSessionCommand = (
  session: SessionState,
  command: Omit<SessionCommand, "seq">
) => {
  const next: SessionCommand = {
    ...command,
    seq: (session.commands.at(-1)?.seq ?? 0) + 1
  };
  session.commands.push(next);
  if (session.commands.length > 500) session.commands.splice(0, session.commands.length - 500);
  for (const waiter of [...session.waiters]) waiter();
  return next;
};

const commandsAfter = (session: SessionState, after: number) =>
  session.commands.filter((command) => command.seq > after);
