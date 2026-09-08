import { describe, expect, it } from "vitest";
import { normalizeCwd, sameProject } from "./format";
import { applyUpdates, emptyTranscript } from "./reducer";
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
});
