import { describe, expect, it } from "vitest";
import {
  compactNumber,
  extractText,
  formatReset,
  modeLabel,
  planEntries,
  shortPath,
  toolDetail,
  toolVerb,
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

  it("ignores idle and error", () => {
    expect(workStatus(["a"], { a: { status: "idle" } })).toBeNull();
    expect(workStatus(["a"], { a: { status: "error" } })).toBeNull();
    expect(workStatus(["a"], { a: { status: "needs-input" } })).toBe("needs-input");
  });
});
