export const defaultCommitMessageModel = "gpt-5.6-luna";

export const defaultCommitMessagePrompt = [
  "Generate a concise Git commit message based only on the supplied diff.",
  "Use a conventional commit subject when the change has a clear type and scope.",
  "Keep the subject imperative and at most 72 characters. Add a short body only when it materially explains why the change was made.",
  "Do not use markdown fences, quotes, or commentary. Do not invent changes that are absent from the diff."
].join(" ");
