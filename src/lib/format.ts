export function normalizeCwd(cwd: string): string {
  if (!cwd) return cwd;
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed || cwd;
}

export function sameProject(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeCwd(a) === normalizeCwd(b);
}

export function projectName(cwd: string): string {
  const parts = normalizeCwd(cwd).split("/");
  return parts[parts.length - 1] || cwd;
}

export function compactNumber(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "";
  const n = Math.abs(value);
  if (n >= 1_000_000) return `${(value / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(value / 1000)}k`;
  if (n >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatReset(iso?: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const min = Math.round((then - Date.now()) / 60000);
  if (min <= 0) return "soon";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const delta = Date.now() - then;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d`;
  return new Date(then).toLocaleDateString();
}

export function previewJson(value: unknown, max = 800): string {
  if (value == null) return "";
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

export function toolLabel(title: string): string {
  return title.replace(/[_-]+/g, " ");
}

export function shortPath(path: string): string {
  const clean = path.replace(/[`'"]/g, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || path;
  return parts.slice(-2).join("/");
}

const KIND_VERB: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  fetch: "Fetch",
  think: "Think",
  list: "List",
  other: "",
};

const NAME_VERB: Record<string, string> = {
  read_file: "Read",
  write: "Write",
  search_replace: "Edit",
  str_replace: "Edit",
  list_dir: "List",
  grep: "Search",
  glob: "Search",
  bash: "Run",
  run_terminal_command: "Run",
  web_search: "Search",
  web_fetch: "Fetch",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toolVerb(kind?: string, title?: string): string {
  const k = (kind ?? "").toLowerCase();
  if (k && KIND_VERB[k]) return KIND_VERB[k];
  const raw = (title ?? "").trim();
  const name = raw.split(/[\s(`/]/)[0]?.toLowerCase() ?? "";
  if (NAME_VERB[name]) return NAME_VERB[name];
  const labeled = /^(Read|Edit|Write|List|Search|Run|Fetch|Delete|Move)\b/i.exec(raw);
  if (labeled?.[1]) return labeled[1][0].toUpperCase() + labeled[1].slice(1).toLowerCase();
  if (name && name.length <= 10 && /^[a-z][a-z0-9]*$/i.test(name)) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return "Run";
}

export function toolDetail(input: unknown, locations?: Array<{ path: string }>, title?: string): string {
  const loc = locations?.[0]?.path;
  if (loc) return shortPath(loc);
  const rec = asRecord(input);
  const candidate =
    rec &&
    (rec.target_file ??
      rec.target_directory ??
      rec.path ??
      rec.command ??
      rec.pattern ??
      rec.query ??
      rec.file_path);
  if (typeof candidate === "string" && candidate) {
    return candidate.includes("/") || candidate.includes("\\") ? shortPath(candidate) : candidate;
  }
  const rest = (title ?? "").replace(/^[A-Za-z][\w]*\s+/, "").replace(/[`'"]/g, "").trim();
  return rest ? shortPath(rest) : "";
}

export function extractText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  const rec = asRecord(value);
  if (!rec) return "";
  if (typeof rec.text === "string") return rec.text;
  if (rec.content) return extractText(rec.content);
  return "";
}

export type PlanEntry = { content: string; status?: string };

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
      return {
        content,
        status: typeof rec.status === "string" ? rec.status : undefined,
      };
    })
    .filter((entry): entry is PlanEntry => Boolean(entry));
}

export function modeLabel(modeId: string): string {
  if (modeId === "yolo") return "Always";
  if (!modeId) return "Mode";
  return modeId.charAt(0).toUpperCase() + modeId.slice(1);
}

export type WorkStatus = "running" | "needs-input";

export function workStatus(
  sessionIds: string[],
  transcripts: Record<string, { status?: string } | undefined>,
  sending = false,
  selectedSession: string | null = null,
): WorkStatus | null {
  let waiting = false;
  for (const id of sessionIds) {
    const live = sending && selectedSession === id ? "running" : transcripts[id]?.status;
    if (live === "running") return "running";
    if (live === "needs-input") waiting = true;
  }
  return waiting ? "needs-input" : null;
}
