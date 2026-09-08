import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text || ""}
      </ReactMarkdown>
    </div>
  );
}
