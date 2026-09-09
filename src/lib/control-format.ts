import { previewJson, toolDetail, toolVerb } from "./format";
import type { PermissionRequest, ThreadInfo, Transcript, TranscriptBlock } from "./types";

export type ControlNeeds = {
  summary: string;
  running: boolean;
  headless: boolean;
  readOnly: boolean;
  lastUser: string;
  lastAssistant: string;
  inProgressTools: string[];
  permission: { title: string; options: string[] } | null;
};

export type TranscriptView = {
  sessionId: string;
  cwd: string;
  title: string;
  status: string;
  headless: boolean;
  readOnly: boolean;
  modeId?: string;
  needs: ControlNeeds;
  chat: string;
  blocks: Array<{ type: string; text: string }>;
};

export function buildTranscriptView(
  sessionId: string,
  thread: ThreadInfo,
  transcript: Transcript,
  permission: PermissionRequest | null,
  readOnly: boolean,
): TranscriptView {
  const blocks = transcript.blocks.map(blockToLine);
  const chat = blocks.map((block) => `[${block.type}]\n${block.text}`).join("\n\n");
  const needs = sessionNeeds(transcript, thread, permission, readOnly);
  return {
    sessionId,
    cwd: thread.cwd,
    title: thread.title || "Thread",
    status: transcript.status,
    headless: Boolean(thread.headless),
    readOnly,
    modeId: transcript.modeId,
    needs,
    chat,
    blocks,
  };
}

export function sessionNeeds(
  transcript: Transcript | undefined,
  thread: ThreadInfo | undefined,
  permission: PermissionRequest | null,
  readOnly: boolean,
): ControlNeeds {
  const lastUser = lastText(transcript, "user");
  const lastAssistant = lastText(transcript, "assistant");
  const inProgressTools = (transcript?.blocks ?? [])
    .filter((block): block is Extract<TranscriptBlock, { type: "tool" }> => block.type === "tool")
    .filter((block) => /running|in_progress|pending/.test(block.status))
    .map((block) =>
      `${toolVerb(block.kind, block.title)} ${toolDetail(block.input, block.locations, block.title)}`.trim(),
    );
  const running = Boolean(
    transcript?.status === "running" || thread?.watchStatus === "running" || inProgressTools.length,
  );
  let summary: string;
  if (permission) {
    summary = `Waiting for permission: ${permission.title || "tool approval"} (${permission.options.map((o) => o.name).join(", ") || "allow/deny"}).`;
  } else if (readOnly && running) {
    summary = `Watching a live grok -p run. Last user: ${clip(lastUser, 160) || "(none yet)"}.`;
  } else if (readOnly) {
    summary = `Read-only thread. Last assistant: ${clip(lastAssistant, 160) || "(no reply yet)"}.`;
  } else if (running) {
    summary = inProgressTools.length
      ? `Turn in progress (${inProgressTools.slice(0, 3).join("; ")}).`
      : "Turn in progress.";
  } else if (lastUser && !lastAssistant) {
    summary = `User asked: ${clip(lastUser, 200)}. No assistant reply yet.`;
  } else if (lastUser) {
    summary = `Latest user ask: ${clip(lastUser, 160)} Latest reply: ${clip(lastAssistant, 160)}`;
  } else {
    summary = "Empty thread. Waiting for a first prompt.";
  }
  return {
    summary,
    running,
    headless: Boolean(thread?.headless),
    readOnly,
    lastUser,
    lastAssistant,
    inProgressTools,
    permission: permission
      ? {
          title: permission.title || "Permission required",
          options: permission.options.map((o) => o.name || o.optionId),
        }
      : null,
  };
}

function lastText(transcript: Transcript | undefined, type: "user" | "assistant"): string {
  if (!transcript) return "";
  for (let i = transcript.blocks.length - 1; i >= 0; i -= 1) {
    const block = transcript.blocks[i];
    if (block.type === type) return block.text;
  }
  return "";
}

function blockToLine(block: TranscriptBlock): { type: string; text: string } {
  switch (block.type) {
    case "user":
      return { type: "user", text: block.text };
    case "assistant":
      return { type: "assistant", text: block.text };
    case "thinking":
      return { type: "thinking", text: clip(block.text, 800) };
    case "tool": {
      const verb = toolVerb(block.kind, block.title);
      const detail = toolDetail(block.input, block.locations, block.title);
      const out = block.output != null ? clip(previewJson(block.output, 400), 400) : "";
      return {
        type: "tool",
        text: `${verb}${detail ? ` ${detail}` : ""} (${block.status})${out ? `\n${out}` : ""}`,
      };
    }
    case "plan":
      return { type: "plan", text: `${block.entries.length} plan entries` };
    case "mode":
      return { type: "mode", text: block.modeId };
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
