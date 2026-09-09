import type { PermissionOption, PermissionRequest } from "./types";

export type PlanPriority = "high" | "medium" | "low";

export type PlanEntry = {
  content: string;
  status?: string;
  priority?: PlanPriority;
};

export type PlanDoc = {
  path: string;
  markdown: string;
  exists: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolMeta(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const nested = asRecord(rec._meta) ?? rec;
  return asRecord(nested["x.ai/tool"]) ?? asRecord(nested["xaiTool"]) ?? nested;
}

export function planEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return { content: item };
      const rec = asRecord(item);
      if (!rec) return null;
      const content =
        (typeof rec.content === "string" && rec.content) ||
        (typeof rec.text === "string" && rec.text) ||
        (typeof rec.title === "string" && rec.title) ||
        "";
      if (!content) return null;
      const priorityRaw = typeof rec.priority === "string" ? rec.priority.toLowerCase() : "";
      const priority: PlanPriority | undefined =
        priorityRaw === "high" || priorityRaw === "medium" || priorityRaw === "low"
          ? priorityRaw
          : undefined;
      return {
        content,
        status: typeof rec.status === "string" ? rec.status : undefined,
        ...(priority ? { priority } : {}),
      };
    })
    .filter((entry): entry is PlanEntry => Boolean(entry));
}

export function isDoneStatus(status?: string) {
  return /complet|done|success/i.test(status ?? "");
}

export function isLiveStatus(status?: string) {
  return /progress|running|doing|active/i.test(status ?? "");
}

export function planProgress(entries: PlanEntry[]) {
  const total = entries.length;
  const done = entries.filter((entry) => isDoneStatus(entry.status)).length;
  const current = entries.find((entry) => isLiveStatus(entry.status))?.content;
  return { done, total, current };
}

export function planTitle(markdown: string) {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading?.[1]?.trim() || "Plan";
}

export function isExitPlanLabel(title?: string | null, meta?: unknown) {
  const text = (title ?? "").toLowerCase();
  if (text.includes("exit_plan") || text.includes("exit plan") || text === "plan: exit") {
    return true;
  }
  const tool = toolMeta(meta);
  const name = String(tool?.name ?? "").toLowerCase();
  const kind = String(tool?.kind ?? "").toLowerCase();
  return name === "exit_plan_mode" || kind === "exit_plan";
}

export function isEnterPlanLabel(title?: string | null, meta?: unknown) {
  const text = (title ?? "").toLowerCase();
  if (text.includes("enter_plan") || text.includes("enter plan")) return true;
  const tool = toolMeta(meta);
  const name = String(tool?.name ?? "").toLowerCase();
  const kind = String(tool?.kind ?? "").toLowerCase();
  return name === "enter_plan_mode" || kind === "enter_plan";
}

export function isExitPlanUpdate(update: { sessionUpdate?: string; title?: string }) {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return false;
  }
  return isExitPlanLabel(update.title);
}

export function isPlanPermission(permission: PermissionRequest) {
  const tool = permission.toolCall ?? permission.raw;
  const rec = asRecord(tool);
  const title = permission.title ?? (typeof rec?.title === "string" ? rec.title : "");
  return isExitPlanLabel(title, rec) || isEnterPlanLabel(title, rec);
}

export function preferAllowOption(options: PermissionOption[]) {
  return (
    options.find((option) => /allow|accept|approve|yes|code|auto/i.test(`${option.kind} ${option.name}`)) ??
    options.find((option) => !/reject|cancel|no|stay/i.test(`${option.kind} ${option.name}`))
  );
}

export function preferRejectOption(options: PermissionOption[]) {
  return options.find((option) => /reject|cancel|no|stay/i.test(`${option.kind} ${option.name}`));
}

export function statusLabel(status?: string) {
  if (isDoneStatus(status)) return "Done";
  if (isLiveStatus(status)) return "Doing";
  if (/pend|todo|wait/i.test(status ?? "")) return "Next";
  return status ? status.replace(/_/g, " ") : "Queued";
}

export type PlanComment = {
  id: string;
  start: number;
  end: number;
  quote: string;
  body: string;
};

export function planLines(markdown: string): string[] {
  return markdown === "" ? [] : markdown.split("\n");
}

export function quotePlanLines(lines: string[], start: number, end: number): string {
  const from = Math.max(1, Math.min(start, end));
  const to = Math.max(start, end);
  return lines.slice(from - 1, to).join("\n").trim();
}

export function formatPlanFeedback(comments: PlanComment[] = [], notes?: string): string {
  const parts: string[] = [];
  const usable = comments.filter((comment) => comment.body.trim());
  if (usable.length) {
    parts.push("Plan comments:");
    for (const comment of usable) {
      const loc = comment.start === comment.end ? `L${comment.start}` : `L${Math.min(comment.start, comment.end)}–${Math.max(comment.start, comment.end)}`;
      const quote = comment.quote.replace(/\s+/g, " ").trim();
      const snippet = quote.length > 80 ? `${quote.slice(0, 77)}…` : quote;
      const label = snippet ? `${loc} (${snippet})` : loc;
      parts.push(`${label}: ${comment.body.trim()}`);
    }
  }
  const extra = notes?.trim() ?? "";
  if (extra) {
    if (parts.length) parts.push("", "Notes:", extra);
    else parts.push(extra);
  }
  return parts.join("\n");
}
