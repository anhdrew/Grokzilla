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
    const modeId = String(update.currentModeId ?? "");
    return {
      ...transcript,
      modeId,
      blocks: [...transcript.blocks, { type: "mode", id: nid("mode"), modeId }],
    };
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
