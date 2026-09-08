import { hasInProgressTools, isTurnEndUpdate, normalizeModeId } from "./format";
import type { SessionUpdate, Transcript, TranscriptBlock } from "./types";

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function emptyTranscript(): Transcript {
  return { blocks: [], commands: [], status: "idle" };
}

function textOf(update: SessionUpdate): string {
  const content = update.content;
  if (content && typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof update.text === "string") return update.text;
  return "";
}

function lastOfType<T extends TranscriptBlock["type"]>(
  blocks: TranscriptBlock[],
  type: T,
): Extract<TranscriptBlock, { type: T }> | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.type === type) return block as Extract<TranscriptBlock, { type: T }>;
  }
  return undefined;
}

function upsertTool(blocks: TranscriptBlock[], update: SessionUpdate): TranscriptBlock[] {
  const toolCallId = String(update.toolCallId ?? "");
  if (!toolCallId) return blocks;
  const index = blocks.findIndex(
    (block) => block.type === "tool" && block.toolCallId === toolCallId,
  );
  const prev = index >= 0 && blocks[index].type === "tool" ? blocks[index] : undefined;
  const next = {
    type: "tool" as const,
    id: prev && prev.type === "tool" ? prev.id : nid("tool"),
    toolCallId,
    title: String(update.title ?? (prev && prev.type === "tool" ? prev.title : "Tool")),
    kind: String(update.kind ?? (prev && prev.type === "tool" ? prev.kind : "") ?? ""),
    status: String(update.status ?? (prev && prev.type === "tool" ? prev.status : "pending")),
    input: update.rawInput ?? (prev && prev.type === "tool" ? prev.input : undefined),
    output: update.rawOutput ?? (prev && prev.type === "tool" ? prev.output : undefined),
    content:
      update.content ??
      (Array.isArray(update.content) ? update.content : undefined) ??
      (prev && prev.type === "tool" ? prev.content : undefined),
    locations: update.locations ?? (prev && prev.type === "tool" ? prev.locations : undefined),
    collapsed: prev && prev.type === "tool" ? prev.collapsed : true,
    truncated:
      update.truncated ?? (prev && prev.type === "tool" ? prev.truncated : undefined),
  };
  if (index >= 0) {
    const copy = blocks.slice();
    copy[index] = next;
    return copy;
  }
  return [...blocks, next];
}

export function applyUpdate(transcript: Transcript, update: SessionUpdate): Transcript {
  const kind = update.sessionUpdate;
  if (!kind) return transcript;

  if (kind === "user_message_chunk") {
    const chunk = textOf(update);
    const last = lastOfType(transcript.blocks, "user");
    const lastIsTail = transcript.blocks[transcript.blocks.length - 1]?.type === "user";
    if (last && lastIsTail) {
      if (last.text === chunk || last.text.startsWith(chunk)) return transcript;
      const merged = chunk.startsWith(last.text) ? chunk : last.text + chunk;
      const blocks = transcript.blocks.slice();
      blocks[blocks.length - 1] = { ...last, text: merged };
      return { ...transcript, blocks };
    }
    return {
      ...transcript,
      blocks: [...transcript.blocks, { type: "user", id: nid("user"), text: chunk }],
    };
  }

  if (kind === "agent_message_chunk") {
    const chunk = textOf(update);
    const last = lastOfType(transcript.blocks, "assistant");
    const lastIsTail = transcript.blocks[transcript.blocks.length - 1]?.type === "assistant";
    if (last && lastIsTail) {
      const blocks = transcript.blocks.slice();
      blocks[blocks.length - 1] = { ...last, text: last.text + chunk };
      return { ...transcript, blocks };
    }
    return {
      ...transcript,
      blocks: [...transcript.blocks, { type: "assistant", id: nid("asst"), text: chunk }],
    };
  }

  if (kind === "agent_thought_chunk") {
    const chunk = textOf(update);
    const last = lastOfType(transcript.blocks, "thinking");
    const lastIsTail = transcript.blocks[transcript.blocks.length - 1]?.type === "thinking";
    if (last && lastIsTail) {
      const blocks = transcript.blocks.slice();
      blocks[blocks.length - 1] = { ...last, text: last.text + chunk };
      return { ...transcript, blocks };
    }
    return {
      ...transcript,
      blocks: [
        ...transcript.blocks,
        { type: "thinking", id: nid("think"), text: chunk, collapsed: true },
      ],
    };
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    return { ...transcript, blocks: upsertTool(transcript.blocks, update) };
  }

  if (kind === "plan") {
    return {
      ...transcript,
      blocks: [
        ...transcript.blocks.filter((b) => b.type !== "plan"),
        { type: "plan", id: nid("plan"), entries: update.entries ?? [] },
      ],
    };
  }

  if (kind === "current_mode_update") {
    const modeId = normalizeModeId(String(update.currentModeId ?? update.modeId ?? "")) ?? "";
    if (transcript.modeId === modeId) return transcript;
    return { ...transcript, modeId };
  }

  if (isTurnEndUpdate(kind)) {
    if (hasInProgressTools(transcript.blocks)) return transcript;
    if (transcript.status === "idle") return transcript;
    return { ...transcript, status: "idle" };
  }

  if (kind === "available_commands_update") {
    const commands = (update.availableCommands ?? transcript.commands).map((command) => ({
      name: command.name,
      description: command.description,
      hint: command.hint ?? (command as { input?: { hint?: string } }).input?.hint,
      source: command.source ?? "session",
    }));
    return { ...transcript, commands };
  }

  return transcript;
}

export function applyUpdates(updates: SessionUpdate[]): Transcript {
  return updates.reduce(applyUpdate, emptyTranscript());
}

export function withStableBlockIds(transcript: Transcript): Transcript {
  const counts: Record<string, number> = {};
  return {
    ...transcript,
    blocks: transcript.blocks.map((block, index) => {
      if (block.type === "tool") {
        const id = `tool-${block.toolCallId || index}`;
        return block.id === id ? block : { ...block, id };
      }
      const n = counts[block.type] ?? 0;
      counts[block.type] = n + 1;
      const id = `${block.type}-${n}`;
      return block.id === id ? block : { ...block, id };
    }),
  };
}

function payloadKey(block: TranscriptBlock): string {
  switch (block.type) {
    case "user":
    case "assistant":
    case "thinking":
      return `${block.type}:${block.text.length}:${block.text.slice(-96)}`;
    case "tool": {
      const out = block.output;
      const outLen = typeof out === "string" ? out.length : out == null ? 0 : 1;
      return `tool:${block.toolCallId}:${block.status}:${block.title}:${outLen}:${block.truncated ? 1 : 0}`;
    }
    case "plan":
      return `plan:${block.entries.length}`;
    case "mode":
      return `mode:${block.modeId}`;
  }
}

export function reuseTranscriptBlocks(prev: Transcript | undefined, next: Transcript): Transcript {
  if (!prev) return next;
  if (prev === next) return prev;
  let changed =
    prev.status !== next.status ||
    prev.modeId !== next.modeId ||
    prev.blocks.length !== next.blocks.length;
  const blocks = next.blocks.map((block, index) => {
    const old = prev.blocks[index];
    if (!old || old.type !== block.type || old.id !== block.id) {
      changed = true;
      return block;
    }
    if (block.type === "thinking" && old.type === "thinking") {
      if (old.text === block.text) return old;
      changed = true;
      return { ...block, collapsed: old.collapsed };
    }
    if (block.type === "tool" && old.type === "tool") {
      if (payloadKey(old) === payloadKey(block) && old.output === block.output && old.content === block.content) {
        return old;
      }
      changed = true;
      return { ...block, collapsed: old.collapsed };
    }
    if (payloadKey(old) === payloadKey(block)) {
      if (block.type === "user" || block.type === "assistant") {
        if (old.type === block.type && old.text === block.text) return old;
      } else if (block.type === "plan" && old.type === "plan" && old.entries === block.entries) {
        return old;
      } else if (block.type === "mode" && old.type === "mode") {
        return old;
      }
    }
    changed = true;
    return block;
  });
  if (!changed) return prev;
  return { ...next, blocks };
}

export function transcriptViewKey(transcript: Transcript): string {
  const last = transcript.blocks[transcript.blocks.length - 1];
  let live = "";
  for (const block of transcript.blocks) {
    if (block.type === "tool") {
      live += `${block.toolCallId}:${block.status};`;
    } else if (block.type === "assistant" || block.type === "user" || block.type === "thinking") {
      live += `${block.type}:${block.text.length};`;
    }
  }
  return `${transcript.blocks.length}:${transcript.status}:${last ? payloadKey(last) : ""}:${live}`;
}

export function toggleBlock(transcript: Transcript, id: string): Transcript {
  return {
    ...transcript,
    blocks: transcript.blocks.map((block) => {
      if (block.id !== id) return block;
      if (block.type === "thinking" || block.type === "tool") {
        return { ...block, collapsed: !block.collapsed };
      }
      return block;
    }),
  };
}

export function collectFiles(transcript: Pick<Transcript, "blocks">): string[] {
  const files = new Set<string>();
  for (const block of transcript.blocks) {
    if (block.type !== "tool") continue;
    for (const loc of block.locations ?? []) {
      if (loc.path) files.add(loc.path);
    }
  }
  return [...files];
}
