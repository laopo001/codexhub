type SubagentOpenThreadReference = {
  threadId: string;
  workingDirectory: string;
  runtime: {
    machineId?: string;
  };
};

type SubagentRuntimeReference = {
  machineId: string;
  online: boolean;
  threads?: readonly {
    threadId: string;
  }[];
};

export type SubagentThreadTarget = {
  machineId: string;
  workingDirectory: string;
  online: boolean;
  attached: boolean;
};

export const resolveSubagentThreadTarget = (
  activeTabThreadId: string,
  childThreadId: string,
  openThreads: readonly SubagentOpenThreadReference[],
  runtimes: readonly SubagentRuntimeReference[]
): SubagentThreadTarget | null => {
  const parentThread = openThreads.find((thread) => thread.threadId === activeTabThreadId);
  const machineId = parentThread?.runtime.machineId;
  if (!parentThread || !machineId) return null;

  const runtime = runtimes.find((item) => item.machineId === machineId);
  const attached = runtime?.threads?.some((thread) => thread.threadId === childThreadId)
    || openThreads.some((thread) =>
      thread.threadId === childThreadId
      && thread.runtime.machineId === machineId
    );

  return {
    machineId,
    workingDirectory: parentThread.workingDirectory,
    online: runtime?.online === true,
    attached: Boolean(attached)
  };
};
