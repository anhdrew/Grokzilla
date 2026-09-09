import { memo, useMemo, useState } from "react";
import { ChatMedia, Markdown } from "./Markdown";
import { PlanChecklist } from "./PlanPanel";
import {
  extractText,
  modeLabel,
  planEntries,
  previewJson,
  toolDetail,
  toolVerb,
} from "../lib/format";
import { toolMedia } from "../lib/media";
import { useApp } from "../lib/store";
import type { ToolBlock, TranscriptBlock } from "../lib/types";

const TOOL_BODY_CAP = 32_000;

type Group =
  | { type: "message"; block: TranscriptBlock }
  | { type: "activity"; items: TranscriptBlock[] };

function groupBlocks(blocks: TranscriptBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.type === "mode") continue;
    if (block.type === "thinking" || block.type === "tool") {
      const last = groups[groups.length - 1];
      if (last?.type === "activity") last.items.push(block);
      else groups.push({ type: "activity", items: [block] });
    } else {
      groups.push({ type: "message", block });
    }
  }
  return groups;
}

export const TranscriptView = memo(function TranscriptView({
  blocks,
}: {
  blocks: TranscriptBlock[];
}) {
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  return (
    <>
      {groups.map((group, index) => {
        if (group.type === "activity") {
          return <ActivityGroup key={group.items[0]?.id ?? index} items={group.items} />;
        }
        return <MessageBlock key={group.block.id} block={group.block} />;
      })}
    </>
  );
});

function activityLabel(block: TranscriptBlock): string {
  if (block.type === "thinking") return "Thought";
  if (block.type === "mode") return modeLabel(block.modeId);
  if (block.type === "tool") return toolVerb(block.kind, block.title);
  return "Step";
}

function isLiveBlock(block: TranscriptBlock, sending: boolean, last: TranscriptBlock): boolean {
  if (block.type === "tool") return /pend|run|in_progress|progress/i.test(block.status);
  if (block.type === "thinking") return sending && block === last;
  return false;
}

function sameBlocks(a: TranscriptBlock[], b: TranscriptBlock[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const ActivityGroup = memo(
  function ActivityGroup({ items }: { items: TranscriptBlock[] }) {
  const sending = useApp((s) => s.sending);
  const [open, setOpen] = useState(false);
  const last = items[items.length - 1]!;
  const live = items.filter((block) => isLiveBlock(block, sending, last));
  const summary = useMemo(() => {
    const labels = items.map(activityLabel);
    const unique = [...new Set(labels)];
    return unique.slice(0, 4).join(" · ");
  }, [items]);
  const shown = open ? items : live;
  if (items.length === 1) {
    return (
      <div className="activity">
        <ActivityBlock block={items[0]!} />
      </div>
    );
  }
  return (
    <div className={`activity ${open ? "" : "folded"}`}>
      <button className="act activity-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="act-verb">{items.length} steps</span>
        <span className="act-detail">{summary}</span>
        <span className="act-chev">{open ? "▾" : "▸"}</span>
      </button>
      {shown.map((block) => (
        <ActivityBlock key={block.id} block={block} />
      ))}
    </div>
  );
  },
  (prev, next) => sameBlocks(prev.items, next.items),
);

const MessageBlock = memo(function MessageBlock({ block }: { block: TranscriptBlock }) {
  if (block.type === "user") {
    return (
      <article className="turn turn-user">
        <div className="bubble-user">
          <Markdown text={block.text} />
        </div>
      </article>
    );
  }
  if (block.type === "assistant") {
    return (
      <article className="turn turn-asst">
        <Markdown text={block.text} />
      </article>
    );
  }
  if (block.type === "plan") {
    const entries = planEntries(block.entries);
    return (
      <div className="plan">
        <div className="plan-kicker">Plan</div>
        {entries.length ? (
          <PlanChecklist entries={entries} />
        ) : (
          <pre className="act-pre">{previewJson(block.entries, 2000)}</pre>
        )}
      </div>
    );
  }
  return <ActivityBlock block={block} />;
});

const ActivityBlock = memo(function ActivityBlock({ block }: { block: TranscriptBlock }) {
  const toggle = useApp((s) => s.toggle);
  const sending = useApp((s) => s.sending);
  const tail = useApp((s) => {
    const id = s.selectedSession;
    const blocks = id ? s.transcripts[id]?.blocks : undefined;
    return blocks?.[blocks.length - 1]?.id === block.id;
  });
  if (block.type === "thinking") {
    const preview = block.text.trim().split(/\n/)[0] ?? "";
    const live = !block.collapsed || (sending && tail);
    return (
      <div className="act-wrap">
        <button className="act think-act" onClick={() => toggle(block.id)}>
          <StatusDot status={live ? "running" : "done"} />
          <span className="act-verb">Thought</span>
          {block.collapsed ? <span className="act-detail">{preview}</span> : null}
          <span className="act-chev">{block.collapsed ? "▸" : "▾"}</span>
        </button>
        {block.collapsed ? null : <div className="act-body think-body">{block.text}</div>}
      </div>
    );
  }
  if (block.type === "tool") {
    return <ToolRow block={block} />;
  }
  if (block.type === "mode") {
    return <div className="mode-chip">{modeLabel(block.modeId)}</div>;
  }
  return null;
});

const ToolRow = memo(function ToolRow({ block }: { block: ToolBlock }) {
  const toggle = useApp((s) => s.toggle);
  const expandTool = useApp((s) => s.expandTool);
  const verb = toolVerb(block.kind, block.title);
  const detail = toolDetail(block.input, block.locations, block.title);
  const running = /pend|run|in_progress|progress/i.test(block.status);
  const failed = /fail|error|cancel/i.test(block.status);
  const status = failed ? "error" : running ? "running" : "done";
  const media = toolMedia(block.output, block.content);
  const raw = extractText(block.content) || extractText(block.output);
  const clipped = raw.length > TOOL_BODY_CAP;
  const output = clipped ? `${raw.slice(0, TOOL_BODY_CAP)}…` : raw;
  const body = output || (block.collapsed ? "" : previewJson(block.input, 800));
  function onToggle() {
    if (block.collapsed && block.truncated) void expandTool(block.id);
    else toggle(block.id);
  }
  return (
    <div className="act-wrap">
      <button className="act" onClick={onToggle}>
        <StatusDot status={status} />
        <span className="act-verb">{verb}</span>
        {detail ? <span className="act-detail">{detail}</span> : null}
        <span className="act-chev">{block.collapsed ? "▸" : "▾"}</span>
      </button>
      {block.collapsed ? null : media ? (
        <div className="act-body act-media">
          <ChatMedia src={media.path} alt={media.filename ?? ""} />
        </div>
      ) : (
        <pre className="act-body act-pre">
          {body}
          {clipped || block.truncated ? "\n…" : ""}
        </pre>
      )}
    </div>
  );
});

function StatusDot({ status }: { status: "done" | "running" | "error" }) {
  return <span className={`act-dot ${status}`} />;
}
