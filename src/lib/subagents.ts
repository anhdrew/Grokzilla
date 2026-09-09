import type { SessionUpdate, SubagentInfo } from "./types";

export function isLiveSubagent(info: Pick<SubagentInfo, "status" | "watchStatus">): boolean {
  if (info.watchStatus === "running") return true;
  return /^(running|in_progress|in-progress|pending|queued)$/i.test(info.status ?? "");
}

export function subagentStatusLabel(info: Pick<SubagentInfo, "status" | "watchStatus">): string {
  if (isLiveSubagent(info)) return "Running";
  const status = (info.status ?? "").toLowerCase();
  if (status === "cancelled" || status === "canceled") return "Cancelled";
  if (status === "failed" || status === "error") return "Failed";
  if (status === "completed" || status === "done") return "Done";
  return info.status || "Idle";
}

export function subagentDot(info: Pick<SubagentInfo, "status" | "watchStatus">): "running" | "done" | "error" {
  if (isLiveSubagent(info)) return "running";
  const status = (info.status ?? "").toLowerCase();
  if (status === "failed" || status === "error") return "error";
  return "done";
}

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function num(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function subagentFromUpdate(update: SessionUpdate | Record<string, unknown>): SubagentInfo | null {
  const row = rec(update);
  if (!row) return null;
  const kind = str(row, "sessionUpdate", "session_update") ?? "";
  if (kind !== "subagent_spawned" && kind !== "subagent_finished") return null;
  const subagentId = str(row, "subagentId", "subagent_id", "childSessionId", "child_session_id");
  if (!subagentId) return null;
  const finished = kind === "subagent_finished";
  const status = str(row, "status") ?? (finished ? "completed" : "running");
  return {
    subagentId,
    parentSessionId: str(row, "parentSessionId", "parent_session_id") ?? "",
    childSessionId: str(row, "childSessionId", "child_session_id") ?? subagentId,
    subagentType: str(row, "subagentType", "subagent_type") ?? null,
    description: str(row, "description") ?? null,
    status,
    durationMs: num(row, "durationMs", "duration_ms") ?? null,
    toolCalls: num(row, "toolCalls", "tool_calls") ?? null,
    turns: num(row, "turns") ?? null,
    model: str(row, "model", "effectiveModelId", "effective_model_id") ?? null,
    error: str(row, "error") ?? null,
    watchStatus: /^(running|in_progress|pending|queued)/i.test(status) ? "running" : "done",
    activity: finished ? str(row, "output") ?? null : null,
  };
}

export function subagentsFromUpdates(updates: Array<SessionUpdate | Record<string, unknown>>): SubagentInfo[] {
  const map = new Map<string, SubagentInfo>();
  for (const update of updates) {
    const next = subagentFromUpdate(update);
    if (!next) continue;
    map.set(next.subagentId, mergeSubagent(map.get(next.subagentId), next));
  }
  return [...map.values()];
}

export function mergeSubagent(prev: SubagentInfo | undefined, next: SubagentInfo): SubagentInfo {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    parentSessionId: next.parentSessionId || prev.parentSessionId,
    childSessionId: next.childSessionId || prev.childSessionId,
    subagentType: next.subagentType ?? prev.subagentType,
    description: next.description ?? prev.description,
    startedAt: next.startedAt ?? prev.startedAt,
    completedAt: next.completedAt ?? prev.completedAt,
    durationMs: next.durationMs ?? prev.durationMs,
    toolCalls: next.toolCalls ?? prev.toolCalls,
    turns: next.turns ?? prev.turns,
    model: next.model ?? prev.model,
    error: next.error ?? prev.error,
    childCwd: next.childCwd ?? prev.childCwd,
    activity: next.activity ?? prev.activity,
    watchStatus: next.watchStatus ?? prev.watchStatus,
  };
}

export function mergeSubagentLists(...lists: Array<SubagentInfo[] | undefined>): SubagentInfo[] {
  const map = new Map<string, SubagentInfo>();
  for (const list of lists) {
    for (const row of list ?? []) {
      if (!row?.subagentId) continue;
      map.set(row.subagentId, mergeSubagent(map.get(row.subagentId), row));
    }
  }
  return [...map.values()].sort((a, b) => {
    const rank = (info: SubagentInfo) => {
      if (isLiveSubagent(info)) return 0;
      const status = (info.status ?? "").toLowerCase();
      if (status === "failed" || status === "error") return 1;
      if (status === "cancelled" || status === "canceled") return 2;
      return 3;
    };
    return rank(a) - rank(b) || (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

export function isSubagentTool(title?: string): boolean {
  const raw = (title ?? "").trim().toLowerCase();
  const name = raw.split(/[\s(`/]/)[0] ?? "";
  return name === "spawn_subagent" || raw.startsWith("spawn_subagent");
}

const SESSION_ID_RE = /01[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function childIdFromTool(block: {
  output?: unknown;
  content?: unknown;
  input?: unknown;
}): string | undefined {
  for (const bag of [block.output, block.content, block.input]) {
    const row = rec(bag);
    if (row) {
      const id = str(row, "subagentId", "subagent_id", "childSessionId", "child_session_id", "task_id", "taskId");
      if (id) return id;
    }
    if (typeof bag === "string") {
      const match = SESSION_ID_RE.exec(bag);
      if (match) return match[0];
    }
  }
  return undefined;
}

export function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${Math.max(1, sec)}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

export function subagentElapsed(info: Pick<SubagentInfo, "durationMs" | "startedAt" | "completedAt">): string {
  if (info.durationMs != null) return formatDuration(info.durationMs);
  const start = info.startedAt ? Date.parse(info.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return "";
  const end = info.completedAt ? Date.parse(info.completedAt) : Date.now();
  if (Number.isNaN(end)) return formatDuration(Date.now() - start);
  return formatDuration(Math.max(0, end - start));
}

export function runningSubagentCount(items: SubagentInfo[] | undefined): number {
  return (items ?? []).filter(isLiveSubagent).length;
}
