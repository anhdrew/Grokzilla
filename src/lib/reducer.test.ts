import { describe, expect, it } from "vitest";
import { normalizeCwd, sameProject } from "./format";
import {
  applyUpdates,
  emptyTranscript,
  reuseTranscriptBlocks,
  transcriptViewKey,
  withStableBlockIds,
} from "./reducer";
import type { SessionUpdate } from "./types";

describe("project grouping", () => {
  it("treats trailing slashes as the same project", () => {
    expect(normalizeCwd("/Users/anh/Desktop/GrokBuildGUI/")).toBe(
      "/Users/anh/Desktop/GrokBuildGUI",
    );
    expect(
      sameProject("/Users/anh/Desktop/web-game-studio/", "/Users/anh/Desktop/web-game-studio"),
    ).toBe(true);
    expect(
      sameProject("/Users/anh/Desktop/web-game-studio", "/Users/anh/Desktop/GrokBuildGUI"),
    ).toBe(false);
  });
});

describe("applyUpdates", () => {
  it("starts empty", () => {
    expect(emptyTranscript().blocks).toEqual([]);
  });

  it("merges streaming assistant chunks and upserts tools", () => {
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "list files" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Looking around." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "list_dir",
        rawInput: { target_directory: "/tmp" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        title: "List /tmp",
        locations: [{ path: "/tmp" }],
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " they are." },
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "Compress history" }],
      },
    ];

    const result = applyUpdates(updates);
    expect(result.blocks.map((b) => b.type)).toEqual([
      "user",
      "thinking",
      "tool",
      "assistant",
    ]);
    expect(result.blocks[0]).toMatchObject({ type: "user", text: "list files" });
    expect(result.blocks[3]).toMatchObject({
      type: "assistant",
      text: "Here they are.",
    });
    expect(result.blocks[2]).toMatchObject({
      type: "tool",
      toolCallId: "call-1",
      status: "completed",
      title: "List /tmp",
    });
    expect(result.commands[0]?.name).toBe("compact");
  });

  it("treats session mode as a single current value, not stacked chips", () => {
    const result = applyUpdates([
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      { sessionUpdate: "current_mode_update", currentModeId: "ask" },
      { sessionUpdate: "current_mode_update", currentModeId: "default" },
      { sessionUpdate: "current_mode_update", currentModeId: "yolo" },
    ]);
    expect(result.modeId).toBe("yolo");
    expect(result.blocks.filter((block) => block.type === "mode")).toEqual([]);
  });

  it("clears running status on turn_completed", () => {
    const ended = applyUpdates([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      { sessionUpdate: "turn_completed" },
    ]);
    expect(ended.blocks).toHaveLength(1);
    expect(ended.status).toBe("idle");
  });

  it("keeps truncated tool previews until a later update clears them", () => {
    const result = applyUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "big",
        title: "read",
        truncated: true,
        rawOutput: "preview…",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "big",
        status: "completed",
        truncated: false,
        rawOutput: "full output",
      },
    ]);
    const tool = result.blocks[0];
    expect(tool).toMatchObject({
      type: "tool",
      truncated: false,
      output: "full output",
    });
  });

  it("keeps stable ids across full hydrates when thinking is inserted", () => {
    const first = withStableBlockIds(
      applyUpdates([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yo" } },
      ]),
    );
    const second = withStableBlockIds(
      applyUpdates([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yo" } },
      ]),
    );
    expect(first.blocks.map((block) => block.id)).toEqual(["user-0", "assistant-0"]);
    expect(second.blocks.map((block) => block.id)).toEqual(["user-0", "thinking-0", "assistant-0"]);
    expect(transcriptViewKey(first)).not.toBe(transcriptViewKey(second));
  });

  it("reuses unchanged block objects between hydrates", () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "list files" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    ];
    const first = withStableBlockIds(applyUpdates(updates));
    const second = withStableBlockIds(applyUpdates(updates));
    const reused = reuseTranscriptBlocks(first, second);
    expect(reused).toBe(first);
    expect(reused.blocks[0]).toBe(first.blocks[0]);
    expect(reused.blocks[1]).toBe(first.blocks[1]);
  });

  it("keeps an expanded thought collapsed=false when the text grows", () => {
    const first = withStableBlockIds(
      applyUpdates([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }]),
    );
    const expanded = {
      ...first,
      blocks: first.blocks.map((block) =>
        block.type === "thinking" ? { ...block, collapsed: false } : block,
      ),
    };
    const second = withStableBlockIds(
      applyUpdates([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm more" } }]),
    );
    const reused = reuseTranscriptBlocks(expanded, second);
    expect(reused.blocks[0]).toMatchObject({ type: "thinking", collapsed: false, text: "hmm more" });
  });
});
