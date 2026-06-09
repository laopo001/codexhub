import { listCodexSessionsForCwd } from "./codexSession.js";
import { writeCodexhubThreadIndex } from "./codexhubCache.js";

export const listLoadableCodexThreads = async (workingDirectory: string, options: { limit?: number } = {}) => {
  const threads = await listCodexSessionsForCwd(workingDirectory, options);
  await writeCodexhubThreadIndex(workingDirectory, threads);
  return threads;
};
