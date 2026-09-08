import { describe, expect, it } from "vitest";
import {
  compactNumber,
  extractText,
  formatReset,
  isReadOnlySession,
  isSafeSessionId,
  modeLabel,
  normalizeModeId,
  parseSessionId,
  planEntries,
  shortPath,
  toolDetail,
  toolVerb,
  hasInProgressTools,
  isTranscriptLive,
  workStatus,
} from "./format";

describe("compactNumber", () => {
  it("shortens thousands and millions", () => {
    expect(compactNumber(384803)).toBe("385k");
    expect(compactNumber(500000)).toBe("500k");
    expect(compactNumber(8)).toBe("8");
    expect(compactNumber(1500)).toBe("1.5k");
  });
});

describe("formatReset", () => {
  it("describes time until a reset", () => {
    const inHours = new Date(Date.now() + 3.5 * 3600_000).toISOString();
    expect(formatReset(inHours)).toMatch(/^\d+h$/);
    expect(formatReset("not-a-date")).toBe("");
  });
});

describe("shortPath", () => {
  it("keeps short paths and trims long ones", () => {
    expect(shortPath("src/App.tsx")).toBe("src/App.tsx");
    expect(shortPath("/Users/anh/Desktop/GrokBuildGUI/src/App.tsx")).toBe("src/App.tsx");
  });
});

describe("toolVerb / toolDetail", () => {
  it("maps kind and file path", () => {
    expect(toolVerb("read", "read_file")).toBe("Read");
    expect(toolVerb("search", "grep")).toBe("Search");
    expect(toolVerb("", "read_file")).toBe("Read");
    expect(toolVerb("other", "blender get scene info")).toBe("Blender");
    expect(toolDetail({ target_file: "/tmp/foo/bar.ts" }, undefined, "read_file")).toBe("foo/bar.ts");
    expect(toolDetail({}, [{ path: "/Users/anh/src/lib/store.ts" }], "Read store")).toBe("lib/store.ts");
  });

  it("uses grep pattern when there is no path", () => {
    expect(toolDetail({ pattern: "sessionConfig" }, [], "grep")).toBe("sessionConfig");
  });
});

describe("extractText", () => {
  it("unwraps ACP content arrays", () => {
    expect(
      extractText([{ type: "content", content: { type: "text", text: "hello" } }]),
    ).toBe("hello");
  });
});

describe("planEntries / modeLabel", () => {
  it("reads plan rows and mode names", () => {
    expect(planEntries([{ content: "Ship UI", status: "completed" }])).toEqual([
      { content: "Ship UI", status: "completed" },
    ]);
    expect(modeLabel("yolo")).toBe("Always");
    expect(modeLabel("ask")).toBe("Ask");
    expect(modeLabel("default")).toBe("Ask");
    expect(modeLabel("always-approve")).toBe("Always");
    expect(normalizeModeId("default")).toBe("ask");
    expect(normalizeModeId("yolo")).toBe("yolo");
  });
});

describe("workStatus", () => {
  it("prefers a running thread over waiting for input", () => {
    expect(
      workStatus(
        ["a", "b"],
        { a: { status: "needs-input" }, b: { status: "running" } },
      ),
    ).toBe("running");
  });

  it("treats an in-flight send as running", () => {
    expect(workStatus(["a"], { a: { status: "idle" } }, true, "a")).toBe("running");
    expect(workStatus(["a"], { a: { status: "idle" } }, true, "other")).toBeNull();
  });

  it("treats in-progress tools as running even after send() settles", () => {
    expect(
      workStatus(["a"], {
        a: { status: "idle", blocks: [{ type: "tool", status: "in_progress" }] },
      }),
    ).toBe("running");
    expect(hasInProgressTools([{ type: "tool", status: "pending" }])).toBe(false);
    expect(hasInProgressTools([{ type: "assistant" }])).toBe(false);
    expect(isTranscriptLive({ status: "running" })).toBe(true);
  });

  it("ignores idle and error", () => {
    expect(workStatus(["a"], { a: { status: "idle" } })).toBeNull();
    expect(workStatus(["a"], { a: { status: "error" } })).toBeNull();
    expect(workStatus(["a"], { a: { status: "needs-input" } })).toBe("needs-input");
  });
});

describe("parseSessionId", () => {
  it("extracts a UUID from pasted text or a path", () => {
    expect(parseSessionId("  01a07ece-f6f9-7d61-930f-cc789f20cae6  ")).toBe(
      "01a07ece-f6f9-7d61-930f-cc789f20cae6",
    );
    expect(parseSessionId("01A07ECE-F6F9-7D61-930F-CC789F20CAE6")).toBe(
      "01a07ece-f6f9-7d61-930f-cc789f20cae6",
    );
    expect(
      parseSessionId("resume 01a07ece-f6f9-7d61-930f-cc789f20cae6 now"),
    ).toBe("01a07ece-f6f9-7d61-930f-cc789f20cae6");
    expect(
      parseSessionId("/Users/anh/.grok/sessions/proj/01a07ece-f6f9-7d61-930f-cc789f20cae6"),
    ).toBe("01a07ece-f6f9-7d61-930f-cc789f20cae6");
  });

  it("keeps custom ids from a path", () => {
    expect(parseSessionId("sess-custom_1")).toBe("sess-custom_1");
    expect(parseSessionId("~/.grok/sessions/proj/sess-custom_1")).toBe("sess-custom_1");
    expect(parseSessionId("")).toBe("");
  });
});

describe("isSafeSessionId / isReadOnlySession", () => {
  it("rejects path-like ids", () => {
    expect(isSafeSessionId("01a07ece-f6f9-7d61-930f-cc789f20cae6")).toBe(true);
    expect(isSafeSessionId("../etc")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
  });

  it("treats headless and explicit ids as read-only", () => {
    const threads = [
      { sessionId: "live" },
      { sessionId: "head", headless: true },
    ];
    expect(isReadOnlySession("live", threads)).toBe(false);
    expect(isReadOnlySession("head", threads)).toBe(true);
    expect(isReadOnlySession("live", threads, ["live"])).toBe(true);
    expect(isReadOnlySession(null, threads, ["live"])).toBe(false);
  });
});
