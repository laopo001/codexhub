import type { CSSProperties } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import shellSession from "react-syntax-highlighter/dist/esm/languages/prism/shell-session";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("shell-session", shellSession);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);

const syntaxHighlighterStyle = oneLight as SyntaxHighlighterProps["style"];
const syntaxHighlighterCustomStyle: CSSProperties = {
  margin: 0,
  overflow: "visible",
  background: "transparent",
  padding: 0,
  fontSize: "12px",
  lineHeight: 1.55
};

type SyntaxCodeBlockProps = {
  language: string;
  children: string;
  className?: string;
  codeClassName?: string;
  customStyle?: CSSProperties;
  wrapLongLines?: boolean;
};

const SyntaxCodeBlock = ({
  language,
  children,
  className,
  codeClassName,
  customStyle,
  wrapLongLines = false
}: SyntaxCodeBlockProps) => (
  <SyntaxHighlighter
    className={className}
    PreTag="div"
    CodeTag="code"
    language={language}
    style={syntaxHighlighterStyle}
    customStyle={customStyle ? { ...syntaxHighlighterCustomStyle, ...customStyle } : syntaxHighlighterCustomStyle}
    codeTagProps={{ className: ["markdownHighlightedCode", codeClassName].filter(Boolean).join(" ") }}
    showLineNumbers={false}
    wrapLongLines={wrapLongLines}
  >
    {children}
  </SyntaxHighlighter>
);

export default SyntaxCodeBlock;
