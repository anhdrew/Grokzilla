import { memo, useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CODE_FENCE_LINES } from "../lib/activity";
import { splitMarkdownBlocks } from "../lib/markdown";
import { isLocalMediaSrc, isWebSrc, keepMediaUrl, loadChatMedia, mediaKind } from "../lib/media";
import { useApp } from "../lib/store";

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
  const text = String(children ?? "").replace(/\n$/, "");
  const lines = text ? text.split("\n") : [""];
  const extra = lines.length - CODE_FENCE_LINES;
  const [open, setOpen] = useState(false);
  const folded = extra > 0 && !open;
  const shown = folded ? lines.slice(0, CODE_FENCE_LINES).join("\n") : text;
  return (
    <div className={`code-block ${folded ? "is-folded" : ""}`}>
      <div className="code-lang">
        <span>{lang || "code"}</span>
        <span className="code-lang-meta">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
        {extra > 0 ? (
          <button className="code-fold" onClick={() => setOpen((value) => !value)}>
            {open ? "Show less" : `Show ${extra} more`}
          </button>
        ) : null}
      </div>
      <pre>
        <code className={className}>{shown}</code>
      </pre>
    </div>
  );
}

export function ChatMedia({ src, alt }: { src?: string; alt?: string }) {
  const sessionId = useApp((s) => s.inspectingSubagent ?? s.selectedSession);
  const cwd = useApp((s) => {
    const childId = s.inspectingSubagent;
    const parentId = s.selectedSession;
    if (childId && parentId) {
      const child = (s.subagents[parentId] ?? []).find(
        (item) => item.childSessionId === childId || item.subagentId === childId,
      );
      if (child?.childCwd) return child.childCwd;
    }
    return s.selectedCwd;
  });
  const [href, setHref] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [kind, setKind] = useState<"image" | "video">(mediaKind(src ?? "") === "video" ? "video" : "image");
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(false);
    setHref(null);
    setPath(null);
    if (!src) return;
    const guessed = mediaKind(src) === "video" ? "video" : "image";
    setKind(guessed);
    if (isWebSrc(src)) {
      setHref(src);
      setPath(src);
      return;
    }
    if (!sessionId || !cwd) {
      setError(true);
      return;
    }
    const load = () => loadChatMedia(sessionId, cwd, src);
    load()
      .catch(
        () =>
          new Promise<Awaited<ReturnType<typeof load>>>((resolve, reject) => {
            timer = setTimeout(() => load().then(resolve, reject), 400);
          }),
      )
      .then((row) => {
        if (!alive) return;
        setHref(row.content);
        setPath(row.path);
        setKind(row.kind);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [src, sessionId, cwd]);

  if (href) {
    if (kind === "video") {
      return <video className="md-media" src={href} controls preload="metadata" />;
    }
    return (
      <img
        className="md-media"
        src={href}
        alt={alt ?? ""}
        title={alt || path || src}
        onDoubleClick={() => {
          if (path && !isWebSrc(path)) void openPath(path).catch(() => undefined);
        }}
      />
    );
  }
  return <span className={`md-media-fallback${error ? "" : " muted"}`}>{alt || src || "Image"}</span>;
}

const components: Components = {
  a: ({ href, children }) =>
    isLocalMediaSrc(href) ? (
      <ChatMedia src={href} alt={String(children ?? href)} />
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  img: ({ src, alt }) => <ChatMedia src={src} alt={alt} />,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const fenced = typeof className === "string" && className.includes("language-");
    if (!fenced) return <code>{children}</code>;
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
};

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepMediaUrl} components={components}>
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
