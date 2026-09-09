import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { buildTranscriptView, sessionNeeds, type TranscriptView } from "./control-format";
import { isReadOnlySession } from "./format";
import { applyUpdates, withStableBlockIds } from "./reducer";
import { useApp } from "./store";
import type { SessionUpdate, ThreadInfo } from "./types";

export type { ControlNeeds, TranscriptView } from "./control-format";
export { buildTranscriptView, sessionNeeds } from "./control-format";

export async function handleControlCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");
  switch (method) {
    case "status":
      return controlStatus();
    case "projects":
      await useApp.getState().refreshLists();
      return useApp.getState().projects;
    case "threads":
      await useApp.getState().refreshLists();
      return filterThreads(str("cwd"));
    case "open":
      return controlOpen(str("cwd"), str("session"));
    case "new":
      return controlNew(str("cwd") || undefined);
    case "send":
      return controlSend(str("text"), str("session"));
    case "stop":
      await useApp.getState().stop();
      return { stopped: true };
    case "permission":
      return controlPermission(str("action"), str("option"));
    case "set-mode":
      await useApp.getState().setMode(str("mode") || str("modeId"));
      return { modeId: useApp.getState().transcripts[useApp.getState().selectedSession ?? ""]?.modeId };
    case "set-model":
      await useApp.getState().setModel(str("model") || str("modelId"));
      return { modelId: useApp.getState().currentModel };
    case "set-effort":
      await useApp.getState().setEffort(str("effort") || str("effortId"));
      return { effortId: useApp.getState().currentEffort };
    case "transcript":
      return controlTranscript(str("session"));
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

export async function replyControl(requestId: number, ok: boolean, result?: unknown, error?: string) {
  await invoke("control_reply", {
    requestId,
    ok,
    result: result ?? null,
    error: error ?? null,
  });
}

function filterThreads(cwd: string): ThreadInfo[] {
  const threads = useApp.getState().threads;
  if (!cwd) return threads;
  return threads.filter((item) => item.cwd === cwd.replace(/\/+$/, "") || item.cwd === cwd);
}

function controlStatus() {
  const s = useApp.getState();
  const id = s.selectedSession;
  const thread = s.threads.find((item) => item.sessionId === id);
  const transcript = id ? s.transcripts[id] : undefined;
  const task = id ? s.tasks[id] : undefined;
  const permission = s.permission;
  return {
    connected: s.connected,
    loggedIn: Boolean(s.status?.loggedIn),
    grokPath: s.status?.grokPath ?? null,
    cwd: s.selectedCwd,
    sessionId: id,
    title: thread?.title ?? null,
    headless: Boolean(thread?.headless),
    readOnly: isReadOnlySession(id, s.threads, s.readOnlyIds),
    status: task?.status ?? transcript?.status ?? "idle",
    sending: s.sending,
    watchStatus: thread?.watchStatus ?? null,
    permission: permission
      ? { title: permission.title ?? "Permission required", options: permission.options.map((o) => o.optionId) }
      : null,
    needs: sessionNeeds(transcript, thread, permission, isReadOnlySession(id, s.threads, s.readOnlyIds)).summary,
  };
}

async function controlOpen(cwd: string, sessionId: string) {
  const s = useApp.getState();
  if (cwd) s.selectProject(cwd);
  await s.refreshLists();
  const live = useApp.getState();
  const thread =
    (sessionId ? live.threads.find((item) => item.sessionId === sessionId) : undefined) ??
    (sessionId ? await api.findThread(sessionId).catch(() => undefined) : undefined) ??
    live.threads.find((item) => cwd && item.cwd === cwd && !item.headless) ??
    live.threads.find((item) => cwd && item.cwd === cwd);
  if (!thread) {
    if (cwd) return { opened: "project", cwd };
    throw new Error("thread not found");
  }
  await live.openThread(thread, { readOnly: Boolean(thread.headless) });
  return { opened: "thread", sessionId: thread.sessionId, cwd: thread.cwd, headless: Boolean(thread.headless) };
}

async function controlNew(cwd?: string) {
  const id = await useApp.getState().newThread(cwd);
  if (!id) throw new Error("could not create thread");
  return { sessionId: id, cwd: useApp.getState().selectedCwd };
}

async function controlSend(text: string, sessionId: string) {
  const s = useApp.getState();
  if (sessionId && s.selectedSession !== sessionId) {
    const thread = s.threads.find((item) => item.sessionId === sessionId) ?? (await api.findThread(sessionId));
    await s.openThread(thread);
  }
  const live = useApp.getState();
  const id = live.selectedSession;
  if (!id) throw new Error("no session selected");
  if (isReadOnlySession(id, live.threads, live.readOnlyIds)) {
    throw new Error("This session is watch-only. Grokzilla will not attach.");
  }
  const body = text.trim();
  if (!body) throw new Error("empty prompt");
  live.setComposer(body);
  await live.send();
  return { queued: true, sessionId: id };
}

async function controlPermission(action: string, optionId: string) {
  const permission = useApp.getState().permission;
  if (!permission) throw new Error("no permission is waiting");
  const act = action.toLowerCase();
  if (act === "deny" || act === "cancel" || act === "reject") {
    await useApp.getState().answerPermission(undefined, true);
    return { answered: "deny" };
  }
  const option =
    optionId ||
    permission.options.find((item) => item.kind?.includes("allow"))?.optionId ||
    permission.options[0]?.optionId;
  if (!option) throw new Error("no permission option");
  await useApp.getState().answerPermission(option, false);
  return { answered: "allow", optionId: option };
}

async function controlTranscript(sessionId: string): Promise<TranscriptView> {
  const s = useApp.getState();
  const id = sessionId || s.selectedSession;
  if (!id) throw new Error("no session selected");
  let thread = s.threads.find((item) => item.sessionId === id);
  if (!thread) thread = await api.findThread(id);
  let transcript = s.transcripts[id];
  if (!transcript || (sessionId && sessionId !== s.selectedSession)) {
    const updates = (await api.hydrateSession(id, thread.cwd)) as SessionUpdate[];
    transcript = withStableBlockIds({
      ...applyUpdates(updates),
      status: thread.headless && thread.watchStatus === "running" ? "running" : "idle",
    });
  }
  const permission = s.selectedSession === id ? s.permission : null;
  const readOnly = isReadOnlySession(id, s.threads, s.readOnlyIds) || Boolean(thread.headless);
  return buildTranscriptView(id, thread, transcript, permission, readOnly);
}
