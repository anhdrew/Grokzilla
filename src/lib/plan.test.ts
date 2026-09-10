import { describe, expect, it } from "vitest";
import {
  formatPlanFeedback,
  isExitPlanLabel,
  isExitPlanExtMethod,
  isExitPlanUpdate,
  isPlanPermission,
  planEntries,
  planProgress,
  planTitle,
  preferAllowOption,
  preferRejectOption,
  quotePlanLines,
  statusLabel,
} from "./plan";

describe("planEntries", () => {
  it("keeps status and priority", () => {
    expect(
      planEntries([
        { content: "Ship UI", status: "completed", priority: "high" },
        { text: "Write tests", status: "in_progress", priority: "medium" },
      ]),
    ).toEqual([
      { content: "Ship UI", status: "completed", priority: "high" },
      { content: "Write tests", status: "in_progress", priority: "medium" },
    ]);
  });
});

describe("plan helpers", () => {
  it("summarizes progress and titles", () => {
    expect(
      planProgress([
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3, current: "B" });
    expect(planTitle("# Grokzilla: lightweight but rock\n\nKeep features.")).toBe(
      "Grokzilla: lightweight but rock",
    );
    expect(statusLabel("in_progress")).toBe("Doing");
  });

  it("detects exit-plan tools and permission options", () => {
    expect(isExitPlanLabel("exit_plan_mode")).toBe(true);
    expect(isExitPlanLabel("Plan: Exit")).toBe(true);
    expect(
      isExitPlanLabel("Ready", {
        _meta: { "x.ai/tool": { name: "exit_plan_mode", kind: "exit_plan" } },
      }),
    ).toBe(true);
    expect(isExitPlanUpdate({ sessionUpdate: "tool_call", title: "exit_plan_mode" })).toBe(true);
    expect(isExitPlanExtMethod("x.ai/exit_plan_mode")).toBe(true);
    expect(isExitPlanExtMethod("_x.ai/exit_plan_mode")).toBe(true);
    expect(isExitPlanExtMethod("session/request_permission")).toBe(false);
    expect(
      isPlanPermission({
        id: 1,
        sessionId: "s",
        title: "Exit Plan Mode",
        options: [],
        raw: {},
        toolCall: { title: "exit_plan_mode" },
      }),
    ).toBe(true);
    const allow = preferAllowOption([
      { optionId: "no", name: "Stay in plan", kind: "reject_once" },
      { optionId: "yes", name: "Approve and start", kind: "allow_once" },
    ]);
    const reject = preferRejectOption([
      { optionId: "no", name: "Stay in plan", kind: "reject_once" },
      { optionId: "yes", name: "Approve and start", kind: "allow_once" },
    ]);
    expect(allow?.optionId).toBe("yes");
    expect(reject?.optionId).toBe("no");
  });
});

describe("plan review feedback", () => {
  it("quotes a line range and formats comments", () => {
    const lines = ["# Title", "Use Flask", "Add tests"];
    expect(quotePlanLines(lines, 2, 2)).toBe("Use Flask");
    expect(
      formatPlanFeedback(
        [
          { id: "1", start: 2, end: 2, quote: "Use Flask", body: "Use FastAPI instead." },
          { id: "2", start: 12, end: 14, quote: "Redis cache", body: "Skip Redis." },
        ],
        "Keep auth as-is.",
      ),
    ).toBe(
      [
        "Plan comments:",
        "L2 (Use Flask): Use FastAPI instead.",
        "L12–14 (Redis cache): Skip Redis.",
        "",
        "Notes:",
        "Keep auth as-is.",
      ].join("\n"),
    );
    expect(formatPlanFeedback([], "  just notes  ")).toBe("just notes");
    expect(formatPlanFeedback([])).toBe("");
  });
});
