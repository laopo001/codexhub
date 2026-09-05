export const defaultCommitMessageModel = "gpt-5.6-luna";

export const defaultCommitMessagePrompt = [
  "仅根据提供的 diff 生成简洁、准确的 Git 提交消息。",
  "请使用中文书写提交消息，包括 subject 和 body；如果使用 Conventional Commits，保留 feat、fix 等标准类型前缀，类型后的描述必须是中文。",
  "subject 使用祈使语气并控制在 72 个字符以内。只有在确实有助于说明变更原因时，才添加简短的中文 body。",
  "不要使用 Markdown 代码块、引号或额外说明。不要臆造 diff 中不存在的变更。"
].join(" ");
