import { useMemo, useState } from "react";
import { Markdown } from "./Markdown";
import {
  extractText,
  modeLabel,
  planEntries,
  previewJson,
  toolDetail,
  toolVerb,
} from "../lib/format";
import { useApp } from "../lib/store";
import type { ToolBlock, TranscriptBlock } from "../lib/types";

type Group =
  | { type: "message"; block: TranscriptBlock }
  | { type: "activity"; items: TranscriptBlock[] };

function groupBlocks(blocks: TranscriptBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" || block.type === "tool" || block.type === "mode") {
      const last = groups[groups.length - 1];
      if (last?.type === "activity") last.items.push(block);
      else groups.push({ type: "activity", items: [block] });
    } else {
      groups.push({ type: "message", block });
    }
  }
  return groups;
}

export function TranscriptView({ blocks }: { blocks: TranscriptBlock[] }) {
  const groups = groupBlocks(blocks);
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
}

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
}

function MessageBlock({ block }: { block: TranscriptBlock }) {
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
          <ul className="plan-list">
            {entries.map((entry, i) => (
              <li key={`${entry.content}-${i}`} className={entry.status ?? ""}>
                <span className={`plan-mark ${entry.status ?? ""}`} />
                <span>{entry.content}</span>
              </li>
            ))}
          </ul>
        ) : (
          <pre className="act-pre">{previewJson(block.entries, 2000)}</pre>
        )}
      </div>
    );
  }
  return <ActivityBlock block={block} />;
}

function ActivityBlock({ block }: { block: TranscriptBlock }) {
  const toggle = useApp((s) => s.toggle);
  if (block.type === "thinking") {
    const preview = block.text.trim().split(/\n/)[0] ?? "";
    return (
      <div className="act-wrap">
        <button className="act think-act" onClick={() => toggle(block.id)}>
          <StatusDot status={block.collapsed ? "done" : "running"} />
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
}

function ToolRow({ block }: { block: ToolBlock }) {
  const toggle = useApp((s) => s.toggle);
  const verb = toolVerb(block.kind, block.title);
  const detail = toolDetail(block.input, block.locations, block.title);
  const running = /pend|run|in_progress|progress/i.test(block.status);
  const failed = /fail|error|cancel/i.test(block.status);
  const status = failed ? "error" : running ? "running" : "done";
  const output = extractText(block.content) || extractText(block.output);
  const body = output || (block.collapsed ? "" : previewJson(block.input, 800));
  return (
    <div className="act-wrap">
      <button className="act" onClick={() => toggle(block.id)}>
        <StatusDot status={status} />
        <span className="act-verb">{verb}</span>
        {detail ? <span className="act-detail">{detail}</span> : null}
        <span className="act-chev">{block.collapsed ? "▸" : "▾"}</span>
      </button>
      {block.collapsed ? null : <pre className="act-body act-pre">{body}</pre>}
    </div>
  );
}

function StatusDot({ status }: { status: "done" | "running" | "error" }) {
  return <span className={`act-dot ${status}`} />;
}
