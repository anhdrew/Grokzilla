import { invoke } from "@tauri-apps/api/core";
import type {
  Attachment,
  GrokStatus,
  PathHit,
  PlanDoc,
  ProjectInfo,
  SkillInfo,
  SubagentInfo,
  ThreadInfo,
  ThreadStats,
} from "./types";

export type SavedDrop = { path: string; rel: string };

export type ChatMedia = {
  kind: "image" | "video";
  content: string;
  path: string;
  size: number;
};

const DIR_TTL_MS = 5_000;
const dirCache = new Map<string, { at: number; rows: PathHit[] }>();

async function listDirCached(cwd: string, rel: string): Promise<PathHit[]> {
  const key = `${cwd}\0${rel}`;
  const hit = dirCache.get(key);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.rows;
  const rows = await invoke<PathHit[]>("list_dir", { cwd, rel });
  dirCache.set(key, { at: Date.now(), rows });
  return rows;
}

export const api = {
  grokStatus: () => invoke<GrokStatus>("grok_status"),
  startAgent: () => invoke<Record<string, unknown>>("start_agent"),
  authenticate: (methodId: string) =>
    invoke<Record<string, unknown>>("authenticate", { methodId }),
  startLogin: () => invoke<GrokStatus>("start_login"),
  listThreads: () => invoke<ThreadInfo[]>("list_threads"),
  listProjects: () => invoke<ProjectInfo[]>("list_projects"),
  listSidebar: () =>
    invoke<{ threads: ThreadInfo[]; projects: ProjectInfo[] }>("list_sidebar"),
  findThread: (sessionId: string) => invoke<ThreadInfo>("find_thread", { sessionId }),
  hydrateSession: (sessionId: string, cwd: string) =>
    invoke<Record<string, unknown>[]>("hydrate_session", { sessionId, cwd }),
  loadToolBody: (sessionId: string, cwd: string, toolCallId: string) =>
    invoke<{ output?: unknown; content?: unknown; input?: unknown }>("load_tool_body", {
      sessionId,
      cwd,
      toolCallId,
    }),
  readChatMedia: (sessionId: string, cwd: string, src: string) =>
    invoke<ChatMedia>("read_chat_media", { sessionId, cwd, src }),
  readPlan: (sessionId: string, cwd: string) =>
    invoke<PlanDoc>("read_plan", { sessionId, cwd }),
  writePlan: (sessionId: string, cwd: string, markdown: string) =>
    invoke<PlanDoc>("write_plan", { sessionId, cwd, markdown }),
  threadStats: (sessionId: string, cwd: string) =>
    invoke<ThreadStats>("thread_stats", { sessionId, cwd }),
  listSubagents: (sessionId: string, cwd: string) =>
    invoke<SubagentInfo[]>("list_subagents", { sessionId, cwd }),
  cancelSubagent: (parentSessionId: string, childSessionId: string) =>
    invoke<void>("cancel_subagent", { parentSessionId, childSessionId }),
  deleteThread: (sessionId: string, cwd: string) =>
    invoke<void>("delete_thread", { sessionId, cwd }),
  newSession: (cwd: string) =>
    invoke<{ sessionId: string; raw: Record<string, unknown> }>("new_session", { cwd }),
  loadSession: (sessionId: string, cwd: string) =>
    invoke<{ sessionId: string; raw: Record<string, unknown> }>("load_session", {
      sessionId,
      cwd,
    }),
  sendPrompt: (sessionId: string, text: string, attachments: Attachment[] = []) =>
    invoke<Record<string, unknown>>("send_prompt", { sessionId, text, attachments }),
  searchPaths: (cwd: string, query: string) =>
    invoke<PathHit[]>("search_paths", { cwd, query }),
  listDir: (cwd: string, rel = "") => listDirCached(cwd, rel),
  listSkills: (cwd: string) => invoke<SkillInfo[]>("list_skills", { cwd }),
  getBilling: () => invoke<Record<string, unknown>>("get_billing"),
  saveDrop: (name: string, dataBase64: string) =>
    invoke<SavedDrop>("save_drop", { name, dataBase64 }),
  cancelPrompt: (sessionId: string) => invoke<void>("cancel_prompt", { sessionId }),
  setMode: (sessionId: string, modeId: string) =>
    invoke<Record<string, unknown>>("set_mode", { sessionId, modeId }),
  setModel: (sessionId: string, modelId: string) =>
    invoke<Record<string, unknown>>("set_model", { sessionId, modelId }),
  setConfigOption: (sessionId: string, configId: string, value: string) =>
    invoke<Record<string, unknown>>("set_config_option", { sessionId, configId, value }),
  respondPermission: (sessionId: string, processId: number, id: number, optionId?: string, cancelled = false) =>
    invoke<void>("respond_permission", { sessionId, processId, id, optionId, cancelled }),
  openInTerminal: (sessionId: string, cwd: string) =>
    invoke<void>("open_in_terminal", { sessionId, cwd }),
};
