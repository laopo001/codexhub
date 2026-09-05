export type AgentQuestion = {
  title: string;
  options: string[] | null;
};

/** 以问题在协议数组中的稳定序号保存答案，允许 title 重复。 */
export type AgentQuestionAnswers = Record<number, string>;

const storageKey = "codexhub-agent-question-answers-v1";

const storage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const answerKey = (threadId: string, recordId: string) => `${threadId}\u0000${recordId}`;

const readStoredAnswers = (): Record<string, AgentQuestionAnswers> => {
  const target = storage();
  if (!target) return {};
  let value: string | null;
  try {
    value = target.getItem(storageKey);
  } catch {
    return {};
  }
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, answers]) => {
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];
      const normalized = Object.fromEntries(Object.entries(answers).flatMap(([index, answer]) =>
        /^\d+$/.test(index) && typeof answer === "string" ? [[index, answer]] : []
      )) as AgentQuestionAnswers;
      return [[key, normalized]];
    }));
  } catch {
    return {};
  }
};

export const storedAgentQuestionAnswers = (threadId: string, recordId: string): AgentQuestionAnswers | null =>
  readStoredAnswers()[answerKey(threadId, recordId)] ?? null;

export const rememberAgentQuestionAnswers = (
  threadId: string,
  recordId: string,
  answers: AgentQuestionAnswers
) => {
  const target = storage();
  if (!target) return;
  const next = readStoredAnswers();
  next[answerKey(threadId, recordId)] = { ...answers };
  try {
    target.setItem(storageKey, JSON.stringify(next));
  } catch {
    // 本地存储不可用时，回答仍已发送；UI 不应阻断对话。
  }
};

export const formatAgentQuestionAnswers = (
  questions: AgentQuestion[],
  answers: AgentQuestionAnswers
) => [
  "Answers to the agent's questions:",
  ...questions.map((question, index) => `- ${question.title}: ${answers[index]?.trim() || "(no answer)"}`)
].join("\n");
