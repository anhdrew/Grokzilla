import { describe, expect, it } from "vitest";
import {
  acceptsEvent,
  addPermission,
  emptyRuntime,
  isRunning,
  nextQueued,
  type TaskRuntime,
} from "./runtime";

function task(patch: Partial<TaskRuntime> = {}): TaskRuntime {
  return { ...emptyRuntime(), ...patch };
}

describe("task runtime", () => {
  it("treats running and needs-input as active", () => {
    expect(isRunning(task({ status: "running" }))).toBe(true);
    expect(isRunning(task({ status: "needs-input" }))).toBe(true);
    expect(isRunning(task({ status: "queued" }))).toBe(false);
    expect(isRunning(task())).toBe(false);
  });

  it("starts queued work up to the concurrency limit", () => {
    const tasks = {
      a: task({ status: "running" }),
      b: task({ queue: [{ id: "1", text: "next", attachments: [] }] }),
      c: task({ queue: [{ id: "2", text: "later", attachments: [] }] }),
      d: task({
        status: "failed",
        queue: [{ id: "3", text: "blocked", attachments: [] }],
      }),
    };
    expect(nextQueued(tasks, 2)).toEqual(["b"]);
    expect(nextQueued(tasks, 3)).toEqual(["b", "c"]);
    expect(nextQueued(tasks, 1)).toEqual([]);
  });

  it("starts a queued prompt even if loading was left stuck", () => {
    expect(
      nextQueued(
        {
          a: task({
            status: "queued",
            loading: true,
            queue: [{ id: "1", text: "hi", attachments: [] }],
          }),
        },
        3,
      ),
    ).toEqual(["a"]);
  });

  it("ignores events from a previous process", () => {
    const live = task({ processId: 9 });
    expect(acceptsEvent(live, 9)).toBe(true);
    expect(acceptsEvent(live, 8)).toBe(false);
    expect(acceptsEvent(undefined, 9)).toBe(false);
  });

  it("queues permissions without dropping an earlier request", () => {
    const first = addPermission(task(), {
      id: 1,
      processId: 4,
      sessionId: "s",
      options: [],
      raw: {},
    });
    const next = addPermission(first, {
      id: 2,
      processId: 4,
      sessionId: "s",
      options: [],
      raw: {},
    });
    expect(next.status).toBe("needs-input");
    expect(next.permissions.map((item) => item.id)).toEqual([1, 2]);
    expect(addPermission(next, next.permissions[0]!).permissions).toHaveLength(2);
  });
});
