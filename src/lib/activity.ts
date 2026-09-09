import { extractText, toolDetail, toolVerb } from "./format";
import { isSubagentTool } from "./subagents";
import type { ToolBlock, TranscriptBlock } from "./types";

const QUIET_VERBS = new Set(["Read", "Search", "List", "Fetch"]);

export type ThinkingBlock = Extract<TranscriptBlock, { type: "thinking" }>;

export type RailItem =
  | { type: "thought"; block: ThinkingBlock }
  | { type: "tool"; block: ToolBlock }
  | { type: "verbRun"; id: string; verb: string; tools: ToolBlock[] };

export type TranscriptGroup =
  | { type: "message"; block: TranscriptBlock }
  | { type: "rail"; id: string; items: RailItem[] };

export type ClampLimits = { lines: number; chars: number };

export const USER_CLAMP: ClampLimits = { lines: 8, chars: 600 };
export const ASSISTANT_CLAMP: ClampLimits = { lines: 36, chars: 1800 };
export const ASSISTANT_PREVIEW: ClampLimits = { lines: 12, chars: 900 };
export const CODE_FENCE_LINES = 16;
export const TOOL_BODY_CAP = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isQuietVerb(verb: string): boolean {
  return QUIET_VERBS.has(verb);
}

const GERUNDS: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Search: "Searching",
  List: "Listing",
  Fetch: "Fetching",
  Run: "Running",
  Thought: "Thinking",
  Think: "Thinking",
  Subagent: "Starting subagent",
  Wait: "Waiting",
  Stop: "Stopping",
  Delete: "Deleting",
  Move: "Moving",
};

export type LiveActivity = {
  gerund: string;
  detail: string;
  label: string;
};

export function activityGerund(verb: string): string {
  if (!verb || verb === "Step") return "Working";
  return GERUNDS[verb] ?? verb;
}

function joinActivityLabel(gerund: string, detail: string): string {
  return detail ? `${gerund} ${detail}` : gerund;
}

export function liveActivity(
  blocks: TranscriptBlock[] | undefined,
  sending = false,
  runningSubagents = 0,
): LiveActivity | null {
  const tailId = blocks?.length ? blocks[blocks.length - 1]!.id : null;
  if (blocks) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i]!;
      if (block.type === "tool" && isLiveToolStatus(block.status)) {
        const verb = toolVerb(block.kind, block.title);
        const gerund = activityGerund(verb);
        const detail = toolRowDetail(block);
        return { gerund, detail, label: joinActivityLabel(gerund, detail) };
      }
      if (block.type === "thinking" && isLiveActivityBlock(block, sending, tailId)) {
        return { gerund: "Thinking", detail: "", label: "Thinking" };
      }
    }
  }
  if (runningSubagents > 0) {
    const detail = `${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"} running`;
    return { gerund: "Working", detail, label: detail };
  }
  if (sending) return { gerund: "Working", detail: "", label: "Working" };
  return null;
}

export function isQuietRailItem(item: RailItem): boolean {
  if (item.type === "thought") return true;
  if (item.type === "verbRun") return isQuietVerb(item.verb);
  if (isSubagentTool(item.block.title)) return false;
  return isQuietVerb(toolVerb(item.block.kind, item.block.title));
}

export function isLiveToolStatus(status?: string): boolean {
  return /pend|run|in_progress|progress/i.test(status ?? "");
}

export function isFailedToolStatus(status?: string): boolean {
  return /fail|error|cancel/i.test(status ?? "");
}

export function isLiveActivityBlock(
  block: TranscriptBlock,
  sending = false,
  tailId?: string | null,
): boolean {
  if (block.type === "tool") return isLiveToolStatus(block.status);
  if (block.type === "thinking") return Boolean(sending && tailId && block.id === tailId);
  return false;
}

export function railItemLive(item: RailItem, sending = false, tailId?: string | null): boolean {
  if (item.type === "thought") return isLiveActivityBlock(item.block, sending, tailId);
  if (item.type === "tool") return isLiveToolStatus(item.block.status);
  return item.tools.some((tool) => isLiveToolStatus(tool.status));
}

function activityVerb(block: TranscriptBlock): string {
  if (block.type === "thinking") return "Thought";
  if (block.type === "tool") return toolVerb(block.kind, block.title);
  return "Step";
}

function canJoinQuietRun(block: TranscriptBlock, verb: string): block is ToolBlock {
  if (block.type !== "tool") return false;
  if (isSubagentTool(block.title)) return false;
  return toolVerb(block.kind, block.title) === verb && isQuietVerb(verb);
}

function packRail(
  blocks: Array<ThinkingBlock | ToolBlock>,
  sending = false,
  tailId?: string | null,
): RailItem[] {
  const items: RailItem[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (block.type === "thinking") {
      items.push({ type: "thought", block });
      index += 1;
      continue;
    }
    const verb = toolVerb(block.kind, block.title);
    if (!isQuietVerb(verb) || isSubagentTool(block.title)) {
      items.push({ type: "tool", block });
      index += 1;
      continue;
    }
    const tools: ToolBlock[] = [block];
    let cursor = index + 1;
    while (cursor < blocks.length) {
      let look = cursor;
      while (look < blocks.length && blocks[look]!.type === "thinking") {
        const thought = blocks[look] as ThinkingBlock;
        if (isLiveActivityBlock(thought, sending, tailId)) break;
        look += 1;
      }
      const next = blocks[look];
      if (!next || !canJoinQuietRun(next, verb)) break;
      tools.push(next);
      cursor = look + 1;
    }
    if (tools.length === 1) {
      items.push({ type: "tool", block });
      index += 1;
      continue;
    }
    items.push({ type: "verbRun", id: `run-${block.id}`, verb, tools });
    index = cursor;
  }
  return items;
}

export function groupTranscript(
  blocks: TranscriptBlock[],
  sending = false,
  tailId?: string | null,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let rail: Array<ThinkingBlock | ToolBlock> = [];

  function flushRail() {
    if (!rail.length) return;
    const items = packRail(rail, sending, tailId);
    groups.push({ type: "rail", id: rail[0]!.id, items });
    rail = [];
  }

  for (const block of blocks) {
    if (block.type === "mode") continue;
    if (block.type === "thinking" || block.type === "tool") {
      rail.push(block);
      continue;
    }
    flushRail();
    groups.push({ type: "message", block });
  }
  flushRail();
  return groups;
}

export function railStepCount(items: RailItem[]): number {
  let count = 0;
  for (const item of items) {
    count += item.type === "verbRun" ? item.tools.length : 1;
  }
  return count;
}

export function railSummary(items: RailItem[]): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const label = item.type === "thought" ? "Thought" : item.type === "verbRun" ? item.verb : activityVerb(item.block);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length === 4) break;
  }
  return labels.join(" · ");
}

export function foldedRailItems(items: RailItem[], sending = false, tailId?: string | null): RailItem[] {
  return items.filter((item) => railItemLive(item, sending, tailId) && !isQuietRailItem(item));
}

export function editDiffstat(block: Pick<ToolBlock, "input" | "output" | "content" | "title">): {
  additions: number;
  deletions: number;
} | null {
  const input = asRecord(block.input);
  const oldText =
    input && (typeof input.old_string === "string" ? input.old_string : typeof input.oldString === "string" ? input.oldString : null);
  const newText =
    input && (typeof input.new_string === "string" ? input.new_string : typeof input.newString === "string" ? input.newString : null);
  if (oldText != null && newText != null) {
    return { deletions: Math.max(1, oldText.split("\n").length), additions: Math.max(1, newText.split("\n").length) };
  }
  const text = extractText(block.output) || extractText(block.content) || "";
  if (!text) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  if (!additions && !deletions) return null;
  return { additions, deletions };
}

export function formatDiffstat(stat: { additions: number; deletions: number } | null): string {
  if (!stat) return "";
  return `+${stat.additions} −${stat.deletions}`;
}

export function toolRowDetail(block: ToolBlock): string {
  const detail = toolDetail(block.input, block.locations, block.title);
  const verb = toolVerb(block.kind, block.title);
  const stat = verb === "Edit" || verb === "Write" ? formatDiffstat(editDiffstat(block)) : "";
  return [detail, stat].filter(Boolean).join("  ");
}

export function toolBodyText(block: ToolBlock): string {
  const text = extractText(block.content) || extractText(block.output);
  if (text) return text;
  if (block.collapsed) return "";
  try {
    return block.input == null ? "" : JSON.stringify(block.input, null, 2);
  } catch {
    return String(block.input ?? "");
  }
}

export function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lines += 1;
  }
  return lines;
}

export function shouldClamp(text: string, limits: ClampLimits): boolean {
  if (!text) return false;
  if (text.length > limits.chars) return true;
  return countLines(text) > limits.lines;
}

export function clampText(text: string, limits: ClampLimits): string {
  if (!shouldClamp(text, limits)) return text;
  const lines = text.split("\n").slice(0, limits.lines);
  let out = lines.join("\n");
  if (out.length > limits.chars) {
    let end = Math.min(out.length, limits.chars);
    while (end > limits.chars / 2 && out[end] && out[end] !== "\n" && out[end] !== " ") end -= 1;
    out = out.slice(0, end).trimEnd();
  }
  return out;
}

export function verbRunDetail(tools: ToolBlock[]): string {
  const details = tools.map((tool) => toolDetail(tool.input, tool.locations, tool.title)).filter(Boolean);
  const unique = [...new Set(details)];
  const head = unique.slice(0, 2);
  const extra = unique.length - head.length;
  const suffix = extra > 0 ? ` · +${extra}` : "";
  return `${head.join(" · ")}${suffix}`;
}

export function verbRunNoun(verb: string, count: number): string {
  const word =
    verb === "Read" ? "file" : verb === "Search" ? "search" : verb === "List" ? "list" : verb === "Fetch" ? "fetch" : "step";
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
