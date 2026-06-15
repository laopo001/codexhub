/** 图片输入清晰度偏好，透传给 Codex/app-server 输入。 */
export type ImageDetail = "auto" | "low" | "high" | "original";

/** 多模态输入中的文本片段。 */
export type ProxyTextInput = {
  type: "text";
  text: string;
};

/** 多模态输入中的图片片段。 */
export type ProxyImageInput = {
  type: "image";
  url: string;
  detail?: ImageDetail;
};

/** 单个结构化用户输入片段。 */
export type ProxyUserInput = ProxyTextInput | ProxyImageInput;

/** 发送 turn 时的用户输入，可为纯文本或多模态片段数组。 */
export type ProxyInput = string | ProxyUserInput[];
