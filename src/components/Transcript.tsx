import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ASSISTANT_CLAMP,
  ASSISTANT_PREVIEW,
  TOOL_BODY_CAP,
  USER_CLAMP,
  clampText,
  foldedRailItems,
  groupTranscript,
  isFailedToolStatus,
  isLiveToolStatus,
  isQuietRailItem,
  liveActivity,
  railItemLive,
  railStepCount,
  railSummary,
  shouldClamp,
  toolBodyText,
  toolRowDetail,
  verbRunDetail,
  verbRunNoun,
  type RailItem,
} from "../lib/activity";
import { modeLabel, planEntries, previewJson, toolVerb } from "../lib/format";
import { childIdFromTool, isSubagentTool } from "../lib/subagents";
import { toolMedia } from "../lib/media";
import { useApp } from "../lib/store";
import type { ToolBlock, TranscriptBlock } from "../lib/types";
import { ChatMedia, Markdown } from "./Markdown";
import { PlanChecklist } from "./PlanPanel";

const TranscriptSession = createContext<string | null>(null);
const EnterCtx = createContext<(id: string) => boolean>(() => false);

function useTranscriptSession() {
  const override = useContext(TranscriptSession);
  return useApp((s) => override ?? s.inspectingSubagent ?? s.selectedSession);
}

function useEnterClass(id: string): string {
  return useContext(EnterCtx)(id) ? "transcript-enter" : "";
}

function railItemKey(item: RailItem): string {
  if (item.type === "verbRun") return item.id;
  return item.block.id;
}

export function ActivityTicker({
  sessionId,
  sending,
  runningSubagents = 0,
  fallback,
}: {
  sessionId?: string | null;
  sending: boolean;
  runningSubagents?: number;
  fallback?: string;
}) {
  const blocks = useApp((s) => {
    const id = sessionId ?? s.selectedSession;
    return id ? s.transcripts[id]?.blocks : undefined;
  });
  const activity = liveActivity(blocks, sending, runningSubagents);
  const label = activity?.label || (sending ? fallback || "Working" : "");
  const [shown, setShown] = useState(label);
  const [leaving, setLeaving] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (label) {
      setShown(label);
      setLeaving(false);
      return;
    }
    if (!shownRef.current) return;
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown("");
      setLeaving(false);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [label]);

  const text = label || shown;
  if (!text) return null;
  return (
    <div className={`working-line ${leaving ? "is-leaving" : ""}`} aria-live="polite">
      <span className="act-dot running" />
      <span key={text} className="working-copy">
        {text}
      </span>
    </div>
  );
}

export const TranscriptView = memo(function TranscriptView({
  blocks,
  sessionId,
}: {
  blocks: TranscriptBlock[];
  sessionId?: string | null;
}) {
  const sending = useApp((s) => s.sending);
  const tailId = blocks[blocks.length - 1]?.id;
  const groups = useMemo(
    () => groupTranscript(blocks, sending, tailId),
    [blocks, sending, tailId],
  );
  const seenRef = useRef(new Set<string>());
  const animateRef = useRef(new Set<string>());
  const sessionRef = useRef<string | null>(null);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  if (sessionRef.current !== (sessionId ?? "")) {
    sessionRef.current = sessionId ?? "";
    const primed = new Set<string>();
    for (const group of groups) {
      if (group.type === "rail") {
        primed.add(group.id);
        for (const item of group.items) primed.add(railItemKey(item));
      } else {
        primed.add(group.block.id);
      }
    }
    seenRef.current = primed;
    animateRef.current = new Set();
  }

  const markEnter = useCallback((id: string) => {
    if (!id) return false;
    if (animateRef.current.has(id)) return true;
    if (seenRef.current.has(id)) return false;
    seenRef.current.add(id);
    if (sendingRef.current) {
      animateRef.current.add(id);
      return true;
    }
    return false;
  }, []);

  return (
    <TranscriptSession.Provider value={sessionId ?? null}>
      <EnterCtx.Provider value={markEnter}>
        {groups.map((group, index) => {
          if (group.type === "rail") {
            return <ActivityRail key={group.id || index} items={group.items} />;
          }
          return <MessageBlock key={group.block.id} block={group.block} />;
        })}
      </EnterCtx.Provider>
    </TranscriptSession.Provider>
  );
});

const ActivityRail = memo(function ActivityRail({ items }: { items: RailItem[] }) {
  const sending = useApp((s) => s.sending);
  const sessionId = useTranscriptSession();
  const tailId = useApp((s) => {
    const id = sessionId;
    const blocks = id ? s.transcripts[id]?.blocks : undefined;
    return blocks?.[blocks.length - 1]?.id;
  });
  const [open, setOpen] = useState(false);
  const live = useMemo(
    () => foldedRailItems(items, sending, tailId),
    [items, sending, tailId],
  );
  const steps = railStepCount(items);
  const summary = useMemo(() => railSummary(items), [items]);
  const shown = open ? items : live;
  const foldable = items.length > 1 || items[0]?.type === "verbRun";
  const enter = useEnterClass(items[0] ? railItemKey(items[0]) : "");
  if (!foldable) {
    const item = items[0]!;
    if (!open && railItemLive(item, sending, tailId) && isQuietRailItem(item)) return null;
    return (
      <div className={`activity ${enter}`}>
        <RailItemRow item={item} />
      </div>
    );
  }
  return (
    <div className={`activity ${open ? "" : "folded"} ${enter}`}>
      <button className="act activity-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="act-verb">{steps} steps</span>
        <span className="act-detail">{summary}</span>
        <span className="act-chev">{open ? "▾" : "▸"}</span>
      </button>
      {shown.map((item) => (
        <RailItemRow key={railItemKey(item)} item={item} />
      ))}
    </div>
  );
});

function RailItemRow({ item }: { item: RailItem }) {
  if (item.type === "thought") return <ThoughtRow block={item.block} />;
  if (item.type === "verbRun") return <VerbRunRow verb={item.verb} tools={item.tools} />;
  return <ToolRow block={item.block} />;
}

const MessageBlock = memo(function MessageBlock({ block }: { block: TranscriptBlock }) {
  const enter = useEnterClass(block.id);
  if (block.type === "user") {
    return (
      <article className={`turn turn-user ${enter}`}>
        <div className="bubble-user">
          <ClampedMarkdown text={block.text} limits={USER_CLAMP} preview={USER_CLAMP} />
        </div>
      </article>
    );
  }
  if (block.type === "assistant") {
    return (
      <article className={`turn turn-asst ${enter}`}>
        <ClampedMarkdown text={block.text} limits={ASSISTANT_CLAMP} preview={ASSISTANT_PREVIEW} liveTail />
      </article>
    );
  }
  if (block.type === "plan") {
    const entries = planEntries(block.entries);
    return (
      <div className={`plan ${enter}`}>
        <div className="plan-kicker">Plan</div>
        {entries.length ? (
          <PlanChecklist entries={entries} />
        ) : (
          <pre className="act-pre">{previewJson(block.entries, 2000)}</pre>
        )}
      </div>
    );
  }
  if (block.type === "thinking") return <ThoughtRow block={block} />;
  if (block.type === "tool") return <ToolRow block={block} />;
  if (block.type === "mode") return <div className="mode-chip">{modeLabel(block.modeId)}</div>;
  return null;
});

function ClampedMarkdown({
  text,
  limits,
  preview,
  liveTail = false,
}: {
  text: string;
  limits: { lines: number; chars: number };
  preview: { lines: number; chars: number };
  liveTail?: boolean;
}) {
  const sending = useApp((s) => s.sending);
  const sessionId = useTranscriptSession();
  const tail = useApp((s) => {
    const id = sessionId;
    const blocks = id ? s.transcripts[id]?.blocks : undefined;
    return blocks?.[blocks.length - 1]?.type === "assistant";
  });
  const [open, setOpen] = useState(false);
  const streaming = liveTail && sending && tail;
  const over = !streaming && shouldClamp(text, limits);
  const shown = open || !over ? text : clampText(text, preview);
  return (
    <div className={`clamp ${over && !open ? "is-folded" : ""}`}>
      <Markdown text={shown} />
      {over ? (
        <button className="clamp-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

const ThoughtRow = memo(function ThoughtRow({ block }: { block: Extract<TranscriptBlock, { type: "thinking" }> }) {
  const toggle = useApp((s) => s.toggle);
  const sending = useApp((s) => s.sending);
  const sessionId = useTranscriptSession();
  const enter = useEnterClass(block.id);
  const tail = useApp((s) => {
    const id = sessionId;
    const blocks = id ? s.transcripts[id]?.blocks : undefined;
    return blocks?.[blocks.length - 1]?.id === block.id;
  });
  const preview = block.text.trim().split(/\n/)[0] ?? "";
  const live = !block.collapsed || (sending && tail);
  return (
    <div className={`act-wrap ${enter}`}>
      <button className="act think-act" onClick={() => toggle(block.id)}>
        <StatusDot status={live ? "running" : "done"} />
        <span className="act-verb">Thought</span>
        {block.collapsed ? <span className="act-detail">{preview}</span> : null}
        <span className="act-chev">{block.collapsed ? "▸" : "▾"}</span>
      </button>
      {block.collapsed ? null : <div className="act-body think-body">{block.text}</div>}
    </div>
  );
});

const VerbRunRow = memo(function VerbRunRow({ verb, tools }: { verb: string; tools: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  const live = tools.some((tool) => isLiveToolStatus(tool.status));
  const failed = tools.some((tool) => isFailedToolStatus(tool.status));
  const status = failed ? "error" : live ? "running" : "done";
  const detail = verbRunDetail(tools);
  const enter = useEnterClass(tools[0] ? `run-${tools[0].id}` : verb);
  return (
    <div className={`verb-run ${open ? "is-open" : ""} ${enter}`}>
      <button className="act" onClick={() => setOpen((value) => !value)}>
        <StatusDot status={status} />
        <span className="act-verb">{verb}</span>
        <span className="act-detail">
          {verbRunNoun(verb, tools.length)}
          {detail ? ` · ${detail}` : ""}
        </span>
        <span className="act-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open
        ? tools.map((tool) => <ToolRow key={tool.id} block={tool} nested />)
        : null}
    </div>
  );
});

const ToolRow = memo(function ToolRow({ block, nested = false }: { block: ToolBlock; nested?: boolean }) {
  const toggle = useApp((s) => s.toggle);
  const expandTool = useApp((s) => s.expandTool);
  const inspectSubagent = useApp((s) => s.inspectSubagent);
  const subagents = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.subagents[id] : undefined;
  });
  const verb = toolVerb(block.kind, block.title);
  const detail = toolRowDetail(block);
  const running = isLiveToolStatus(block.status);
  const failed = isFailedToolStatus(block.status);
  const status = failed ? "error" : running ? "running" : "done";
  const enter = useEnterClass(block.id);
  const media = toolMedia(block.output, block.content);
  const raw = toolBodyText(block);
  const clipped = raw.length > TOOL_BODY_CAP;
  const output = clipped ? `${raw.slice(0, TOOL_BODY_CAP)}…` : raw;
  const childId =
    isSubagentTool(block.title) &&
    (childIdFromTool(block) ||
      subagents?.find((item) => item.description && detail && item.description === detail)?.childSessionId);
  function onToggle() {
    if (block.collapsed && block.truncated) void expandTool(block.id);
    else toggle(block.id);
  }
  return (
    <div className={`act-wrap ${nested ? "nested" : ""} ${enter}`}>
      <button className="act" onClick={onToggle}>
        <StatusDot status={status} />
        {nested ? null : <span className="act-verb">{verb}</span>}
        {detail ? <span className="act-detail">{detail}</span> : nested ? <span className="act-verb">{verb}</span> : null}
        {childId ? (
          <span
            className="act-link"
            role="link"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void inspectSubagent(childId);
            }}
          >
            Open
          </span>
        ) : null}
        <span className="act-chev">{block.collapsed ? "▸" : "▾"}</span>
      </button>
      {block.collapsed ? null : media ? (
        <div className="act-body act-media">
          <ChatMedia src={media.path} alt={media.filename ?? ""} />
        </div>
      ) : output ? (
        looksLikeMarkdown(output) ? (
          <div className="act-body act-md">
            <Markdown text={output} />
            {clipped || block.truncated ? <div className="clamp-more">…</div> : null}
          </div>
        ) : (
          <pre className="act-body act-pre">
            {output}
            {clipped || block.truncated ? "\n…" : ""}
          </pre>
        )
      ) : null}
    </div>
  );
});

function looksLikeMarkdown(text: string): boolean {
  if (text.length > 4000) return false;
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return false;
  return /(^|\n)#{1,6}\s|(^|\n)```|(^|\n)[-*]\s|(^|\n)\d+\.\s/.test(text);
}

function StatusDot({ status }: { status: "done" | "running" | "error" }) {
  return <span className={`act-dot ${status}`} />;
}
