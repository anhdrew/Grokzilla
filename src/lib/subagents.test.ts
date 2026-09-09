import { describe, expect, it } from "vitest";
import {
  childIdFromTool,
  isLiveSubagent,
  isSubagentTool,
  mergeSubagentLists,
  subagentElapsed,
  subagentFromUpdate,
  subagentStatusLabel,
  subagentsFromUpdates,
} from "./subagents";

describe("subagent events", () => {
  it("merges spawned then finished updates", () => {
    const items = subagentsFromUpdates([
      {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        parent_session_id: "parent",
        child_session_id: "child-1",
        subagent_type: "explore",
        description: "scan repo",
        model: "grok-4.6",
      },
      {
        sessionUpdate: "subagent_finished",
        subagent_id: "child-1",
        child_session_id: "child-1",
        status: "completed",
        duration_ms: 12_000,
        tool_calls: 4,
        output: "Done",
      },
    ] as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subagentId: "child-1",
      parentSessionId: "parent",
      subagentType: "explore",
      description: "scan repo",
      status: "completed",
      durationMs: 12_000,
      toolCalls: 4,
      watchStatus: "done",
    });
    expect(isLiveSubagent(items[0]!)).toBe(false);
    expect(subagentStatusLabel(items[0]!)).toBe("Done");
  });

  it("keeps a live child first when merging disk and stream lists", () => {
    const merged = mergeSubagentLists(
      [
        {
          subagentId: "done",
          parentSessionId: "p",
          childSessionId: "done",
          status: "completed",
          startedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        {
          subagentId: "live",
          parentSessionId: "p",
          childSessionId: "live",
          status: "running",
          watchStatus: "running",
          startedAt: "2026-01-01T00:01:00Z",
          description: "write plan",
        },
      ],
    );
    expect(merged.map((item) => item.subagentId)).toEqual(["live", "done"]);
    expect(isLiveSubagent(merged[0]!)).toBe(true);
  });
});

describe("subagent tools", () => {
  it("recognizes spawn_subagent and extracts the child id", () => {
    expect(isSubagentTool("spawn_subagent")).toBe(true);
    expect(isSubagentTool("grep")).toBe(false);
    expect(
      childIdFromTool({
        output: { subagent_id: "01a08242-35fe-7273-84b9-414c0aa1df10" },
      }),
    ).toBe("01a08242-35fe-7273-84b9-414c0aa1df10");
  });
});

describe("subagentFromUpdate", () => {
  it("ignores unrelated session updates", () => {
    expect(subagentFromUpdate({ sessionUpdate: "tool_call", title: "grep" })).toBeNull();
  });
});

describe("subagentElapsed", () => {
  it("formats stored duration", () => {
    expect(subagentElapsed({ durationMs: 90_000 })).toBe("2m");
  });
});
