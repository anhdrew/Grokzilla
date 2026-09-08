import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "../lib/markdown";

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
  const text = String(children ?? "").replace(/\n$/, "");
  return (
    <div className="code-block">
      {lang ? <div className="code-lang">{lang}</div> : null}
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const fenced = typeof className === "string" && className.includes("language-");
    if (!fenced) return <code>{children}</code>;
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
};

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text || ""), [text]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
});
