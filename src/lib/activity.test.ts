import { describe, expect, it } from "vitest";
import {
  activityGerund,
  clampText,
  editDiffstat,
  foldedRailItems,
  groupTranscript,
  isQuietVerb,
  liveActivity,
  railStepCount,
  railSummary,
  shouldClamp,
  verbRunDetail,
} from "./activity";
import type { ToolBlock, TranscriptBlock } from "./types";

function thought(id: string, text: string): TranscriptBlock {
  return { type: "thinking", id, text, collapsed: true };
}

function tool(id: string, title: string, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: "tool",
    id,
    toolCallId: id,
    title,
    status: "completed",
    collapsed: true,
    ...extra,
  };
}

describe("groupTranscript", () => {
  it("keeps messages and packs a quiet read run, swallowing finished thoughts among them", () => {
    const groups = groupTranscript([
      { type: "user", id: "u0", text: "look around" },
      thought("t0", "hmm"),
      tool("r1", "read_file", { input: { target_file: "/tmp/a.ts" } }),
      thought("t1", "next file"),
      tool("r2", "read_file", { input: { target_file: "/tmp/b.ts" } }),
      tool("r3", "read_file", { input: { target_file: "/tmp/c.ts" } }),
      { type: "assistant", id: "a0", text: "done" },
    ]);
    expect(groups.map((group) => group.type)).toEqual(["message", "rail", "message"]);
    const rail = groups[1];
    if (rail.type !== "rail") throw new Error("expected rail");
    expect(rail.items).toHaveLength(2);
    expect(rail.items[0]).toMatchObject({ type: "thought" });
    expect(rail.items[1]).toMatchObject({ type: "verbRun", verb: "Read" });
    if (rail.items[1]!.type !== "verbRun") throw new Error("expected run");
    expect(rail.items[1].tools.map((item) => item.id)).toEqual(["r1", "r2", "r3"]);
    expect(railStepCount(rail.items)).toBe(4);
    expect(railSummary(rail.items)).toBe("Thought · Read");
  });

  it("does not fold Edit, Run, or subagent into a quiet run", () => {
    const groups = groupTranscript([
      tool("r1", "read_file", { kind: "read" }),
      tool("e1", "search_replace", { kind: "edit" }),
      tool("b1", "run_terminal_command", { kind: "execute" }),
      tool("s1", "spawn_subagent"),
    ]);
    const rail = groups[0];
    if (rail.type !== "rail") throw new Error("expected rail");
    expect(rail.items.map((item) => item.type)).toEqual(["tool", "tool", "tool", "tool"]);
  });

  it("does not swallow a live thought into a read run", () => {
    const groups = groupTranscript(
      [
        tool("r1", "read_file"),
        thought("t-live", "still thinking"),
        tool("r2", "read_file"),
      ],
      true,
      "t-live",
    );
    const rail = groups[0];
    if (rail.type !== "rail") throw new Error("expected rail");
    expect(rail.items.map((item) => item.type)).toEqual(["tool", "thought", "tool"]);
  });

  it("keeps a live loud tool visible when the rail is folded", () => {
    const groups = groupTranscript([
      tool("r1", "read_file"),
      tool("r2", "read_file"),
      tool("e1", "search_replace", { kind: "edit", status: "in_progress" }),
    ]);
    const rail = groups[0];
    if (rail.type !== "rail") throw new Error("expected rail");
    const folded = foldedRailItems(rail.items);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ type: "tool" });
  });

  it("hides a live quiet read when the rail is folded", () => {
    const groups = groupTranscript([
      tool("r1", "read_file"),
      tool("r2", "read_file", { status: "in_progress" }),
    ]);
    const rail = groups[0];
    if (rail.type !== "rail") throw new Error("expected rail");
    expect(foldedRailItems(rail.items)).toEqual([]);
  });
});

describe("liveActivity", () => {
  it("names a live read with its path", () => {
    expect(
      liveActivity(
        [tool("r1", "read_file", { kind: "read", status: "in_progress", input: { target_file: "/tmp/foo/a.ts" } })],
        true,
      ),
    ).toMatchObject({ gerund: "Reading", detail: "foo/a.ts", label: "Reading foo/a.ts" });
  });

  it("names a live write", () => {
    expect(
      liveActivity(
        [tool("w1", "write", { status: "in_progress", input: { path: "/tmp/out.rs" } })],
        true,
      ),
    ).toMatchObject({ gerund: "Writing", label: "Writing tmp/out.rs" });
  });

  it("names a live edit", () => {
    expect(
      liveActivity(
        [tool("e1", "search_replace", { kind: "edit", status: "in_progress", input: { path: "src/App.tsx" } })],
        true,
      ),
    ).toMatchObject({ gerund: "Editing", label: "Editing src/App.tsx" });
  });

  it("names thinking when the tail thought is live", () => {
    expect(liveActivity([thought("t0", "hmm")], true)).toEqual({
      gerund: "Thinking",
      detail: "",
      label: "Thinking",
    });
  });

  it("returns Working when sending with no live tool", () => {
    expect(liveActivity([tool("r1", "read_file")], true)).toEqual({
      gerund: "Working",
      detail: "",
      label: "Working",
    });
  });

  it("returns null when idle", () => {
    expect(liveActivity([tool("r1", "read_file")], false)).toBeNull();
  });

  it("prefers a live tool over the subagent count", () => {
    expect(
      liveActivity(
        [tool("r1", "read_file", { status: "in_progress", input: { target_file: "a.ts" } })],
        true,
        2,
      ),
    ).toMatchObject({ gerund: "Reading", label: "Reading a.ts" });
  });

  it("names running subagents when nothing else is live", () => {
    expect(liveActivity([tool("r1", "read_file")], false, 2)).toEqual({
      gerund: "Working",
      detail: "2 subagents running",
      label: "2 subagents running",
    });
  });
});

describe("activityGerund", () => {
  it("maps verbs to gerunds and leaves unknown labels alone", () => {
    expect(activityGerund("Read")).toBe("Reading");
    expect(activityGerund("Run")).toBe("Running");
    expect(activityGerund("Blender")).toBe("Blender");
    expect(activityGerund("Step")).toBe("Working");
  });
});

describe("quiet verbs", () => {
  it("treats Read/Search/List/Fetch as quiet", () => {
    expect(isQuietVerb("Read")).toBe(true);
    expect(isQuietVerb("Edit")).toBe(false);
    expect(isQuietVerb("Run")).toBe(false);
  });
});

describe("editDiffstat", () => {
  it("counts old/new strings and unified diffs", () => {
    expect(
      editDiffstat({
        title: "search_replace",
        input: { old_string: "a\nb", new_string: "a\nb\nc" },
      }),
    ).toEqual({ deletions: 2, additions: 3 });
    expect(
      editDiffstat({
        title: "edit",
        output: "--- a\n+++ b\n@@\n-old\n+new\n+more\n",
      }),
    ).toEqual({ deletions: 1, additions: 2 });
  });
});

describe("clampText", () => {
  it("clamps by lines and characters", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(shouldClamp(long, { lines: 8, chars: 600 })).toBe(true);
    expect(clampText(long, { lines: 3, chars: 600 }).split("\n")).toHaveLength(3);
    expect(shouldClamp("short", { lines: 8, chars: 600 })).toBe(false);
  });
});

describe("verbRunDetail", () => {
  it("shows two paths then a remainder", () => {
    expect(
      verbRunDetail([
        tool("a", "read_file", { input: { target_file: "/tmp/foo/a.ts" } }),
        tool("b", "read_file", { input: { target_file: "/tmp/foo/b.ts" } }),
        tool("c", "read_file", { input: { target_file: "/tmp/foo/c.ts" } }),
      ]),
    ).toBe("foo/a.ts · foo/b.ts · +1");
  });
});
