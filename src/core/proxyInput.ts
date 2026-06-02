export type ImageDetail = "auto" | "low" | "high" | "original";

export type ProxyTextInput = {
  type: "text";
  text: string;
};

export type ProxyImageInput = {
  type: "image";
  url: string;
  detail?: ImageDetail;
};

export type ProxyUserInput = ProxyTextInput | ProxyImageInput;

export type ProxyInput = string | ProxyUserInput[];
