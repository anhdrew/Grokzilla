import { describe, expect, it } from "vitest";
import { buildTranscriptView, sessionNeeds } from "./control-format";
import { emptyTranscript } from "./reducer";
import type { ThreadInfo, Transcript } from "./types";

const thread: ThreadInfo = {
  sessionId: "sess1",
  cwd: "/tmp/demo",
  title: "Fix the login",
};

describe("sessionNeeds", () => {
  it("summarizes the latest user ask and assistant reply", () => {
    const transcript: Transcript = {
      ...emptyTranscript(),
      blocks: [
        { type: "user", id: "u0", text: "Why is login failing?" },
        { type: "assistant", id: "a0", text: "The token cookie is expired." },
      ],
    };
    const needs = sessionNeeds(transcript, thread, null, false);
    expect(needs.lastUser).toBe("Why is login failing?");
    expect(needs.lastAssistant).toContain("token cookie");
    expect(needs.summary).toContain("Why is login failing?");
    expect(needs.summary).toContain("token cookie");
  });

  it("calls out a waiting plan approval", () => {
    const needs = sessionNeeds(emptyTranscript(), thread, null, false, true);
    expect(needs.summary).toContain("plan approval");
  });

  it("calls out a waiting permission", () => {
    const needs = sessionNeeds(emptyTranscript(), thread, {
      id: 1,
      sessionId: "sess1",
      title: "Run tests",
      options: [{ optionId: "allow", name: "Allow" }],
      raw: {},
    }, false);
    expect(needs.permission?.title).toBe("Run tests");
    expect(needs.summary).toContain("Waiting for permission");
  });

  it("mentions running subagents", () => {
    const needs = sessionNeeds(emptyTranscript(), { ...thread, runningSubagents: 2 }, null, false);
    expect(needs.running).toBe(true);
    expect(needs.summary).toContain("2 subagents running");
  });
});

describe("buildTranscriptView", () => {
  it("renders a readable chat log", () => {
    const transcript: Transcript = {
      ...emptyTranscript(),
      status: "idle",
      blocks: [
        { type: "user", id: "u0", text: "List the files" },
        {
          type: "tool",
          id: "t0",
          toolCallId: "c1",
          title: "list_dir",
          kind: "list",
          status: "completed",
          input: { path: "/tmp/demo/src" },
          collapsed: true,
        },
        { type: "assistant", id: "a0", text: "src has App.tsx and main.tsx." },
      ],
    };
    const view = buildTranscriptView("sess1", thread, transcript, null, false);
    expect(view.chat).toContain("[user]");
    expect(view.chat).toContain("List the files");
    expect(view.chat).toContain("[assistant]");
    expect(view.chat).toContain("App.tsx");
    expect(view.needs.lastUser).toBe("List the files");
  });
});
