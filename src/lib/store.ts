import { useWorkspace, desktop, actualTheme, type TaskMetadata } from "./workspace";
import { normalizeThemeId, type ThemeId, type ThemePreference } from "./themes";
import { emptyRuntime, isRunning, nextQueued, acceptsEvent, addPermission, type TaskRuntime } from "./runtime";
import { create } from "zustand";
import { loadArchive, saveArchive, withArchived, withoutArchived } from "./archive";
import { api } from "./api";
import {
  isReadOnlySession,
  normalizeCwd,
  normalizeModeId,
  sameProject,
} from "./format";
import { EFFORT_CONFIG_ID, mergeModelState, modelsFrom } from "./models";
import {
  formatPlanFeedback,
  isExitPlanUpdate,
  isPlanPermission,
  preferAllowOption,
  preferRejectOption,
  type PlanComment,
} from "./plan";
import {
  applyUpdate,
  applyUpdates,
  emptyTranscript,
  reuseTranscriptBlocks,
  toggleBlock,
  transcriptViewKey,
  withStableBlockIds,
} from "./reducer";
import { rememberUsageSample, usageFrom, type UsageInfo } from "./usage";
import type {
  AcpEvent,
  Attachment,
  EffortInfo,
  GrokStatus,
  ModelInfo,
  PermissionRequest,
  PlanDoc,
  ProjectInfo,
  SessionUpdate,
  SkillInfo,
  SubagentInfo,
  ThreadInfo,
  ThreadStats,
  ToolBlock,
  Transcript,
} from "./types";
import {
  isLiveSubagent,
  mergeSubagentLists,
  runningSubagentCount,
  subagentFromUpdate,
  subagentsFromUpdates,
} from "./subagents";

export const MODES = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "yolo", label: "Always" },
] as const;

type AppState = {
  tasks: Record<string, TaskRuntime>;
  updateTask: (id: string, patch: Partial<TaskRuntime>) => void;
  drainQueue: () => void;
  runTask: (id: string) => Promise<void>;
  retryTask: (id: string) => void;
  clearQueue: (id: string) => void;
  status: GrokStatus | null;
  bootError: string | null;
  connected: boolean;
  starting: boolean;
  auth?: Record<string, unknown>;
  models: ModelInfo[];
  currentModel?: string;
  efforts: EffortInfo[];
  currentEffort?: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  selectedCwd: string | null;
  selectedSession: string | null;
  transcripts: Record<string, Transcript>;
  composer: string;
  sending: boolean;
  ignoringReplay: boolean;
  permission: PermissionRequest | null;
  explorerOpen: boolean;
  mcpNote?: string;
  slashOpen: boolean;
  theme: ThemeId;
  attachments: Attachment[];
  skills: SkillInfo[];
  archivedThreads: string[];
  archivedProjects: string[];
  readOnlyIds: string[];
  usage: UsageInfo | null;
  threadStats: ThreadStats | null;
  planDoc: PlanDoc | null;
  planPanelOpen: boolean;
  planReviewOpen: boolean;
  planDirty: boolean;
  subagents: Record<string, SubagentInfo[]>;
  inspectingSubagent: string | null;
  subagentRosterOpen: boolean | null;
  subagentError: string | null;

  bootstrap: () => Promise<void>;
  refreshLists: () => Promise<void>;
  login: () => Promise<void>;
  handleEvent: (event: AcpEvent) => void;
  selectProject: (cwd: string) => void;
  openThread: (thread: ThreadInfo, opts?: { readOnly?: boolean }) => Promise<void>;

  openInTerminal: (thread: ThreadInfo) => Promise<void>;
  newThread: (cwd?: string, options?: { environment?: "local" | "worktree"; base?: string; background?: boolean }) => Promise<string | undefined>;
  setComposer: (text: string) => void;
  send: () => Promise<void>;
  compactHistory: (keep?: string) => Promise<void>;
  stop: () => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setEffort: (effortId: string) => Promise<void>;
  answerPermission: (optionId?: string, cancelled?: boolean) => Promise<void>;
  toggle: (id: string) => void;
  setExplorerOpen: (open: boolean) => void;
  attachEntry: (item: Attachment) => void;
  setSlashOpen: (open: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  addAttachment: (item: Attachment) => void;
  removeAttachment: (path: string) => void;
  loadSkills: (cwd?: string) => Promise<void>;
  archiveThread: (sessionId: string) => void;
  unarchiveThread: (sessionId: string) => void;
  deleteThread: (sessionId: string) => Promise<void>;
  archiveProject: (cwd: string) => void;
  unarchiveProject: (cwd: string) => void;
  loadUsage: () => Promise<void>;
  loadThreadStats: () => Promise<void>;
  expandTool: (id: string) => Promise<void>;
  loadPlanDoc: () => Promise<void>;
  refreshHeadlessWatch: () => Promise<void>;
  loadSubagents: (sessionId?: string) => Promise<void>;
  inspectSubagent: (childSessionId: string) => Promise<void>;
  closeSubagentInspector: () => void;
  toggleSubagentRoster: () => void;
  stopSubagent: (childSessionId: string) => Promise<void>;
  refreshInspectedSubagent: () => Promise<void>;
  openPlanPanel: (review?: boolean) => void;
  closePlanPanel: () => boolean;
  setPlanDirty: (dirty: boolean) => void;
  savePlan: (markdown: string) => Promise<void>;
  approvePlan: (comments?: PlanComment[], notes?: string) => Promise<void>;
  revisePlan: (notes?: string, comments?: PlanComment[]) => Promise<void>;
  quitPlan: () => Promise<void>;
};

const initialArchive = loadArchive();

function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("gz.theme", theme);
}

let bootLock: Promise<void> | null = null;
let threadLoadGen = 0;
const TRANSCRIPT_LRU = 8;
const skillsCache = new Map<string, { at: number; skills: SkillInfo[] }>();

const pendingEvents: AcpEvent[] = [];
let flushHandle = 0;

function scheduleFrame(fn: () => void) {
  if (typeof requestAnimationFrame === "function") {
    flushHandle = requestAnimationFrame(fn);
  } else {
    flushHandle = setTimeout(fn, 16) as unknown as number;
  }
}

function cancelFrame() {
  if (!flushHandle) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushHandle);
  else clearTimeout(flushHandle);
  flushHandle = 0;
}

function isUrgentEvent(event: AcpEvent) {
  return event.kind === "exit" || event.kind === "permission";
}

function pruneTranscripts(
  transcripts: Record<string, Transcript>,
  keepId: string | null,
  extraKeep?: string | null,
): Record<string, Transcript> {
  const ids = Object.keys(transcripts);
  if (ids.length <= TRANSCRIPT_LRU) return transcripts;
  const next = { ...transcripts };
  const drop = ids.length - TRANSCRIPT_LRU;
  let removed = 0;
  for (const id of ids) {
    if (id === keepId || id === extraKeep || isRunning(useApp.getState().tasks[id])) continue;
    delete next[id];
    removed += 1;
    if (removed >= drop) break;
  }
  return next;
}

function rememberSubagents(
  parentId: string,
  items: SubagentInfo[],
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const merged = mergeSubagentLists(get().subagents[parentId], items);
  const running = runningSubagentCount(merged);
  set({
    subagents: { ...get().subagents, [parentId]: merged },
    threads: get().threads.map((thread) =>
      thread.sessionId === parentId
        ? { ...thread, runningSubagents: running, subagentCount: merged.length }
        : thread,
    ),
  });
}

function flushStreamEvents(events: AcpEvent[], get: () => AppState, set: (partial: Partial<AppState>) => void) {
  let transcripts = get().transcripts;
  for (const event of events) {
    const id = event.sessionId;
    if (!id || !acceptsEvent(get().tasks[id], event.processId) || get().tasks[id].loading) continue;
    const update = event.payload as SessionUpdate;
    const previous = transcripts[id] ?? emptyTranscript();
    let next = applyUpdate(previous, update);
    if (update.sessionUpdate === "current_mode_update") next = { ...next, modeId: normalizeModeId(update.currentModeId ?? update.modeId) };
    transcripts = { ...transcripts, [id]: next };
    if (update.sessionUpdate === "config_option_update") {
      const model = mergeModelState(get().tasks[id], modelsFrom(event.payload));
      get().updateTask(id, model);
    }
    if (isExitPlanUpdate(update)) get().updateTask(id, { planReviewOpen: true, planPanelOpen: true });
    if (id === get().selectedSession && (isExitPlanUpdate(update) || update.sessionUpdate === "plan")) void get().loadPlanDoc();
    const spawned = subagentFromUpdate(update as Record<string, unknown>);
    if (spawned) {
      rememberSubagents(id, [{ ...spawned, parentSessionId: spawned.parentSessionId || id }], get, set);
    }
  }
  set({ transcripts });
}
function projection(t: TaskRuntime) {
  return { composer: t.draft, attachments: t.attachments, sending: isRunning(t), permission: t.permissions[0] ?? null,
    models: t.models, currentModel: t.currentModel, efforts: t.efforts, currentEffort: t.currentEffort,
    planDoc: t.planDoc, planPanelOpen: t.planPanelOpen, planReviewOpen: t.planReviewOpen };
}
const taskFields = { composer: 'draft', attachments: 'attachments', models: 'models', currentModel: 'currentModel', efforts: 'efforts', currentEffort: 'currentEffort', planDoc: 'planDoc', planPanelOpen: 'planPanelOpen', planReviewOpen: 'planReviewOpen' } as const;

async function queuePrompt(
  get: () => AppState,
  text: string,
  attachments: Attachment[],
  clearDraft = true,
) {
  if (isReadOnlySession(get().selectedSession, get().threads, get().readOnlyIds)) return;
  let sessionId = get().selectedSession;
  if (!sessionId) {
    const cwd = get().selectedCwd;
    if (!cwd) return;
    await get().newThread(cwd);
    sessionId = get().selectedSession;
  }
  if (!sessionId) return;
  const task = get().tasks[sessionId] ?? emptyRuntime();
  get().updateTask(sessionId, {
    queue: [...task.queue, { id: `prompt-${crypto.randomUUID()}`, text, attachments }],
    status: isRunning(task) ? task.status : "queued",
    ...(isRunning(task) ? {} : { loading: false, error: undefined }),
    ...(clearDraft ? { draft: "", attachments: [] } : {}),
  });
  get().drainQueue();
}

export const useApp = create<AppState>((baseSet, get) => {
  const set = (patch: Partial<AppState>) => {
    const current = get();
    const id = patch.selectedSession === undefined ? current.selectedSession : patch.selectedSession;
    if (id) {
      let task = { ...(patch.tasks ?? current.tasks)[id] ?? emptyRuntime() };
      if (id !== current.selectedSession) {
        const meta = useWorkspace.getState().data.tasks[id];
        if (!current.tasks[id]) task = { ...task, draft: meta?.draft ?? '', attachments: meta?.attachments ?? [], currentModel: meta?.model, currentEffort: meta?.effort };
        patch = { ...projection(task), ...patch };
      }
      for (const [alias, field] of Object.entries(taskFields)) {
        if (Object.prototype.hasOwnProperty.call(patch, alias)) (task as unknown as Record<string, unknown>)[field] = (patch as Record<string, unknown>)[alias];
      }
      patch.tasks = { ...(patch.tasks ?? current.tasks), [id]: task };
      if ('composer' in patch || 'attachments' in patch || 'currentModel' in patch || 'currentEffort' in patch) {
        useWorkspace.getState().task(id, { draft: task.draft, attachments: task.attachments.map(({ preview: _preview, ...a }) => a), model: task.currentModel, effort: task.currentEffort });
      }
    }
    baseSet(patch);
    if ('selectedSession' in patch || 'selectedCwd' in patch) useWorkspace.getState().update({ selectedSession: get().selectedSession, selectedCwd: get().selectedCwd });
  };
  return ({
  tasks: {},
  updateTask: (id, patch) => {
    const task = { ...(get().tasks[id] ?? emptyRuntime()), ...patch };
    set({ tasks: { ...get().tasks, [id]: task }, ...(id === get().selectedSession ? projection(task) : {}) });
  },
  retryTask: id => { get().updateTask(id, { status: 'queued', error: undefined }); get().drainQueue(); },
  clearQueue: id => { get().updateTask(id, { queue: [], ...(isRunning(get().tasks[id]) ? {} : { status: 'idle' }) }); },
  drainQueue: () => { for (const id of nextQueued(get().tasks, useWorkspace.getState().data.settings.concurrency)) void get().runTask(id); },
  runTask: async id => {
    const runtime = get().tasks[id]; const prompt = runtime?.queue[0];
    const cwd = get().selectedCwd;
    const thread =
      get().threads.find((item) => item.sessionId === id) ??
      (cwd ? { sessionId: id, cwd, title: "New task" } : undefined);
    if (!prompt || !thread || isRunning(runtime)) return;
    if (thread.headless || isReadOnlySession(id, get().threads, get().readOnlyIds)) {
      get().updateTask(id, { status: "failed", queue: [], loading: false, error: "This session is watch-only. Grokzilla will not attach." });
      return;
    }
    get().updateTask(id, { status: 'running', loading: true, queue: runtime.queue.slice(1), error: undefined });
    try {
      const loaded = await api.loadSession(id, thread.cwd);
      if (get().tasks[id]?.status === 'interrupted') { await desktop.closeTask(id); return; }
      const model = mergeModelState(runtime, modelsFrom(loaded.raw));
      get().updateTask(id, { ...model, processId: Number(loaded.raw.processId), loading: false });
      const settings = useWorkspace.getState().data.settings;
      const mode = get().transcripts[id]?.modeId ?? useWorkspace.getState().data.tasks[id]?.mode ?? settings.defaultMode;
      if (mode) await api.setMode(id, mode).catch(() => {});
      const chosenModel = runtime.currentModel || settings.defaultModel;
      if (chosenModel) {
        await api.setModel(id, chosenModel).catch(() => {});
        get().updateTask(id, { currentModel: chosenModel });
      }
      if (runtime.currentEffort) {
        await api.setConfigOption(id, EFFORT_CONFIG_ID, runtime.currentEffort).catch(() => {});
      }
      const current = get().transcripts[id] ?? emptyTranscript();
      const display = [prompt.text, ...prompt.attachments.map(a => `@${a.rel}`)].filter(Boolean).join(' ');
      set({ transcripts: { ...get().transcripts, [id]: { ...current, status: 'running', blocks: [...current.blocks, { type: 'user', id: prompt.id, text: display }] } } });
      await api.sendPrompt(id, prompt.text || display, prompt.attachments);
      cancelFrame(); flushStreamEvents(pendingEvents.splice(0), get, set);
      if (get().tasks[id]?.status !== 'interrupted') {
        get().updateTask(id, { status: 'completed', permissions: [] });
        const transcript = get().transcripts[id];
        if (transcript) set({ transcripts: { ...get().transcripts, [id]: { ...transcript, status: 'idle' } } });
        window.dispatchEvent(new CustomEvent('task-notification', { detail: { id, title: 'Task completed', body: thread.title || 'Grok finished its work.' } }));
      }
    } catch (e) {
      if (get().tasks[id]?.status !== 'interrupted') {
        get().updateTask(id, { status: 'failed', error: String(e), permissions: [] });
        window.dispatchEvent(new CustomEvent('task-notification', { detail: { id, title: 'Task failed', body: String(e) } }));
      }
    } finally {
      get().updateTask(id, { loading: false, processId: undefined, permissions: [] });
      await desktop.closeTask(id).catch(() => {});
      void get().refreshLists().catch(() => {});
      if (get().selectedSession === id) { void get().loadThreadStats(); void get().loadPlanDoc(); }
      get().drainQueue();
    }
  },
  status: null,
  bootError: null,
  connected: false,
  starting: false,
  models: [],
  efforts: [],
  projects: [],
  threads: [],
  selectedCwd: localStorage.getItem("gz.cwd"),
  selectedSession: null,
  transcripts: {},
  composer: "",
  sending: false,
  ignoringReplay: false,
  permission: null,
  explorerOpen: true,
  slashOpen: false,
  attachments: [],
  skills: [],
  archivedThreads: initialArchive.threads,
  archivedProjects: initialArchive.projects,
  readOnlyIds: [],
  usage: null,
  threadStats: null,
  planDoc: null,
  planPanelOpen: false,
  planReviewOpen: false,
  planDirty: false,
  subagents: {},
  inspectingSubagent: null,
  subagentRosterOpen: null,
  subagentError: null,
  theme: actualTheme(normalizeThemeId(localStorage.getItem("gz.theme"))),

  bootstrap: async () => {
    if (bootLock) return bootLock;
    bootLock = (async () => {
      await useWorkspace.getState().load();
      const workspace = useWorkspace.getState().data;
      set({ theme: actualTheme(workspace.settings.theme), selectedCwd: workspace.selectedCwd,
        archivedThreads: Object.entries(workspace.tasks).filter(([,t])=>t.archived).map(([id])=>id), archivedProjects: workspace.archivedProjects });
      await desktop.configure(workspace.settings.grokPath);
      applyTheme(get().theme);
      const status = await api.grokStatus();
      set({ status, bootError: null });
      if (!status.grokPath || !status.loggedIn) return;
      set({ connected: true, starting: false, bootError: null });
      try {
        await get().refreshLists();
        await get().loadSkills();
        void get().loadUsage();
        const { selectedCwd, threads } = get();
        if (selectedCwd) {
          const match =
            threads.find((t) => t.sessionId === workspace.selectedSession && !t.headless) ??
            threads.find((t) => t.cwd === selectedCwd && !t.headless);
          if (match) void get().openThread(match);
        }
      } catch (err) {
        set({
          bootError: err instanceof Error ? err.message : String(err),
        });
      }
    })().finally(() => {
      bootLock = null;
    });
    return bootLock;
  },

  refreshLists: async () => {
    const lists = await api.listSidebar();
    const ws = useWorkspace.getState().data;
    const threads: ThreadInfo[] = lists.threads.map(t => ({ ...t, title: ws.tasks[t.sessionId]?.title || t.title }));
    for (const t of get().threads) {
      if (threads.some(row => row.sessionId === t.sessionId) || t.headless) continue;
      if (get().tasks[t.sessionId] || ws.tasks[t.sessionId]) threads.push(t);
    }
    const projects = [...lists.projects];
    for (const cwd of ws.projects) if (!projects.some(p => p.cwd === cwd)) projects.push({ cwd, name: cwd.split('/').pop() || cwd, threadCount: threads.filter(t => t.cwd === cwd).length });
    set({ threads, projects });
  },

  login: async () => {
    await api.startLogin();
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await api.grokStatus();
      set({ status });
      if (status.loggedIn) {
        await get().bootstrap();
        return;
      }
    }
  },

  handleEvent: event => {
    const id = event.sessionId;
    if (!id) {
      if (event.kind === 'exit' && !get().starting) set({ bootError: 'Grok connection closed. History is preserved.' });
      return;
    }
    const task = get().tasks[id];
    if (!acceptsEvent(task, event.processId)) return;
    if (isUrgentEvent(event)) { cancelFrame(); flushStreamEvents(pendingEvents.splice(0), get, set); }
    if (event.kind === 'exit') {
      get().updateTask(id, { status: 'interrupted', processId: undefined, loading: false, permissions: [], error: 'Agent disconnected. History is preserved; the last prompt was not resent.' });
      return;
    }
    if (event.kind === 'permission' && event.id != null) {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      const permission: PermissionRequest = { id: event.id, processId: event.processId, sessionId: id, title: typeof raw.title === 'string' ? raw.title : undefined, toolCall: (raw.toolCall ?? raw.tool_call) as Record<string, unknown>, options: (raw.options ?? []) as PermissionRequest['options'], raw };
      const next = addPermission(task, permission);
      get().updateTask(id, { ...next, ...(isPlanPermission(permission) ? { planPanelOpen: true, planReviewOpen: true } : {}) });
      if (id === get().selectedSession && isPlanPermission(permission)) void get().loadPlanDoc();
      window.dispatchEvent(new CustomEvent('task-notification', { detail: { id, title: 'Approval required', body: permission.title || 'Grok needs your input.' } }));
      return;
    }
    if (event.kind === 'notification') {
      if (event.method?.includes('mcp')) set({ mcpNote: `MCP: ${event.method}` });
      if (event.method?.includes('models/update')) get().updateTask(id, mergeModelState(task, modelsFrom(event.payload)));
      return;
    }
    if (event.kind === 'update') pendingEvents.push(event);
    if (!flushHandle) scheduleFrame(() => { flushHandle = 0; flushStreamEvents(pendingEvents.splice(0), get, set); });
  },

  selectProject: (cwd) => {
    const normalized = cwd.replace(/\/+$/, "") || cwd;
    localStorage.setItem("gz.cwd", normalized);
    const workspace = useWorkspace.getState();
    const projects = workspace.data.projects.includes(normalized)
      ? workspace.data.projects
      : [...workspace.data.projects, normalized];
    workspace.update({ selectedCwd: normalized, projects });
    set({ selectedCwd: normalized });
    void get().loadSkills(normalized);
  },

  openThread: async (thread, opts) => {
    const id = thread.sessionId;
    const readOnly = Boolean(opts?.readOnly || thread.headless);
    const gen = ++threadLoadGen;
    const existing = get().transcripts[id];
    set({
      selectedCwd: thread.cwd,
      selectedSession: id,
      threadStats: null,
      inspectingSubagent: null,
      subagentRosterOpen: null,
      subagentError: null,
      readOnlyIds: readOnly ? withArchived(get().readOnlyIds, id) : withoutArchived(get().readOnlyIds, id),
      transcripts: pruneTranscripts(get().transcripts, id),
    });
    void get().loadSkills(thread.cwd); void get().loadThreadStats(); void get().loadSubagents(id);
    if (existing && !readOnly) { void get().loadPlanDoc(); return; }
    try {
      const updates = await api.hydrateSession(id, thread.cwd) as SessionUpdate[];
      if (isRunning(get().tasks[id])) return;
      const watch = readOnly && thread.watchStatus === 'running' ? 'running' : readOnly && thread.watchStatus === 'error' ? 'error' : 'idle';
      set({ transcripts: { ...get().transcripts, [id]: reuseTranscriptBlocks(existing, withStableBlockIds({ ...applyUpdates(updates), status: watch })) } });
      rememberSubagents(id, subagentsFromUpdates(updates as Array<Record<string, unknown>>), get, set);
      if (gen === threadLoadGen) void get().loadPlanDoc();
    } catch(e) { if (gen === threadLoadGen) set({ bootError: String(e) }); }
  },

  openInTerminal: async (thread) => {
    try {
      await api.openInTerminal(thread.sessionId, thread.cwd);
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  newThread: async (cwd, options) => {
    const target = cwd || get().selectedCwd;
    if (!target) { useWorkspace.getState().openNewTask(); return; }
    try {
      let meta: TaskMetadata = { cwd: target, repository: target, environment: 'local' };
      if (options?.environment !== 'local') {
        const info = await desktop.gitInfo(target).catch(() => null);
        if (info) meta = await desktop.createWorktree(info.root, options?.base || 'HEAD');
      }
      const actualCwd = meta.cwd || target;
      const created = await api.newSession(actualCwd);
      const id = created.sessionId;
      const settings = useWorkspace.getState().data.settings;
      const workspace = useWorkspace.getState();
      const projects = workspace.data.projects.includes(target)
        ? workspace.data.projects
        : [...workspace.data.projects, target];
      workspace.update({ projects });
      workspace.task(id, { ...meta, mode: settings.defaultMode });
      const model = mergeModelState(emptyRuntime(), modelsFrom(created.raw));
      const task = { ...emptyRuntime(), ...model, currentModel: settings.defaultModel || model.currentModel };
      set({ tasks: { ...get().tasks, [id]: task }, transcripts: { ...get().transcripts, [id]: { ...emptyTranscript(), modeId: settings.defaultMode } },
        threads: [{ sessionId: id, cwd: actualCwd, title: 'New task', createdAt: new Date().toISOString() }, ...get().threads],
        ...(options?.background ? {} : { selectedCwd: actualCwd, selectedSession: id, ...projection(task), threadStats: null }) });
      if (!options?.background) void get().loadSkills(actualCwd);
      await get().refreshLists();
      return id;
    } catch(e) { set({ bootError: String(e) }); throw e; }
  },

  setComposer: (text) => set({ composer: text }),

  addAttachment: (item) => {
    const exists = get().attachments.some((a) => a.path === item.path);
    if (exists) return;
    set({ attachments: [...get().attachments, item] });
  },

  attachEntry: (item) => {
    const folder = item.kind === "folder";
    const rel = folder && !item.rel.endsWith("/") ? `${item.rel}/` : item.rel;
    const entry: Attachment = {
      path: item.path,
      rel,
      kind: folder ? "folder" : item.kind === "image" ? "image" : "file",
      mimeType: item.mimeType,
      preview: item.preview,
    };
    get().addAttachment(entry);
    const mention = `@${rel}`;
    const text = get().composer;
    if (text.includes(mention)) return;
    const prefix = text && !/\s$/.test(text) ? " " : "";
    set({ composer: `${text}${prefix}${mention} ` });
  },

  removeAttachment: (path) => {
    set({ attachments: get().attachments.filter((a) => a.path !== path) });
  },

  loadThreadStats: async () => {
    const sessionId = get().selectedSession;
    const cwd = get().selectedCwd;
    if (!sessionId || !cwd) {
      set({ threadStats: null });
      return;
    }
    try {
      const stats = await api.threadStats(sessionId, cwd);
      if (get().selectedSession !== sessionId) return;
      set({ threadStats: stats });
    } catch {
      set({ threadStats: null });
    }
  },

  loadUsage: async () => {
    try {
      const raw = await api.getBilling();
      const usage = usageFrom(raw);
      rememberUsageSample(usage);
      set({ usage });
    } catch {
      /* usage is best-effort */
    }
  },

  loadSkills: async (cwd) => {
    const target = cwd ?? get().selectedCwd;
    if (!target) return;
    const cached = skillsCache.get(target);
    if (cached && Date.now() - cached.at < 30_000) {
      set({ skills: cached.skills });
      return;
    }
    try {
      const skills = await api.listSkills(target);
      skillsCache.set(target, { at: Date.now(), skills });
      set({ skills });
    } catch {
      set({ skills: [] });
    }
  },

  send: async () => {
    const { composer, selectedSession } = get();
    const text = composer.trim();
    const attachments = get().attachments;
    if (isReadOnlySession(selectedSession, get().threads, get().readOnlyIds)) return;
    if (!text && attachments.length === 0) return;
    try {
      await queuePrompt(get, text, attachments);
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  compactHistory: async (keep) => {
    const notes = keep?.trim();
    await queuePrompt(get, notes ? `/compact ${notes}` : "/compact", [], false);
  },

  stop: async () => {
    const id = get().selectedSession; if (!id) return;
    get().updateTask(id, { status: 'interrupted', queue: [], permissions: [], error: 'Stopped by you.' });
    await api.cancelPrompt(id).catch(() => {});
    await desktop.closeTask(id).catch(() => {});
    get().updateTask(id, { processId: undefined, loading: false });
    const transcript = get().transcripts[id];
    if (transcript) set({ transcripts: { ...get().transcripts, [id]: { ...transcript, status: 'idle', blocks: transcript.blocks.map(b => b.type === 'tool' && /running|in_progress|pending/.test(b.status) ? { ...b, status: 'cancelled' } : b) } } });
    get().drainQueue();
  },

  setMode: async mode => {
    const id = get().selectedSession; if (!id || isReadOnlySession(id, get().threads, get().readOnlyIds)) return;
    const modeId = normalizeModeId(mode) ?? mode;
    if (isRunning(get().tasks[id])) await api.setMode(id, modeId).catch(() => {});
    const current = get().transcripts[id] ?? emptyTranscript();
    set({ transcripts: { ...get().transcripts, [id]: { ...current, modeId } } });
    useWorkspace.getState().task(id, { mode: modeId });
  },
  setModel: async modelId => {
    const id = get().selectedSession; if (!id || isReadOnlySession(id, get().threads, get().readOnlyIds)) return;
    if (isRunning(get().tasks[id])) await api.setModel(id, modelId).catch(() => {});
    const model = get().models.find(m => m.modelId === modelId);
    const efforts = model?.reasoningEfforts ?? [];
    get().updateTask(id, { currentModel: modelId, efforts, currentEffort: model?.reasoningEffort ?? efforts[0]?.id });
  },
  setEffort: async effortId => {
    const id = get().selectedSession; if (!id || isReadOnlySession(id, get().threads, get().readOnlyIds)) return;
    if (isRunning(get().tasks[id])) await api.setConfigOption(id, EFFORT_CONFIG_ID, effortId).catch(() => {});
    get().updateTask(id, { currentEffort: effortId });
  },
  answerPermission: async (optionId, cancelled = false) => {
    const permission = get().permission; if (!permission || permission.processId == null) return;
    const id = permission.sessionId;
    await api.respondPermission(id, permission.processId, permission.id, optionId, cancelled);
    const task = get().tasks[id];
    if (!task || task.processId !== permission.processId) return;
    const permissions = task.permissions.filter(p => p.id !== permission.id || p.processId !== permission.processId);
    get().updateTask(id, { permissions, status: permissions.length ? 'needs-input' : 'running', planReviewOpen: false });
  },

  toggle: (id) => {
    const sessionId = get().inspectingSubagent ?? get().selectedSession;
    if (!sessionId) return;
    const current = get().transcripts[sessionId];
    if (!current) return;
    set({
      transcripts: { ...get().transcripts, [sessionId]: toggleBlock(current, id) },
    });
  },

  loadSubagents: async (sessionId) => {
    const id = sessionId ?? get().selectedSession;
    const thread = get().threads.find((item) => item.sessionId === id);
    const cwd = thread?.cwd ?? get().selectedCwd;
    if (!id || !cwd) return;
    try {
      const disk = await api.listSubagents(id, cwd);
      if (sessionId && get().selectedSession !== id && get().inspectingSubagent == null) {
        /* still cache the parent roster */
      }
      rememberSubagents(id, disk, get, set);
    } catch {
      /* subagent folders are optional */
    }
  },

  inspectSubagent: async (childSessionId) => {
    const parentId = get().selectedSession;
    const info = (parentId ? get().subagents[parentId] : undefined)?.find(
      (item) => item.childSessionId === childSessionId || item.subagentId === childSessionId,
    );
    const cwd = info?.childCwd || get().selectedCwd;
    if (!cwd) return;
    set({ inspectingSubagent: childSessionId, subagentError: null, subagentRosterOpen: true });
    try {
      const updates = (await api.hydrateSession(childSessionId, cwd)) as SessionUpdate[];
      if (get().inspectingSubagent !== childSessionId) return;
      const live = info ? isLiveSubagent(info) : false;
      const existing = get().transcripts[childSessionId];
      set({
        transcripts: {
          ...pruneTranscripts(get().transcripts, get().selectedSession, childSessionId),
          [childSessionId]: reuseTranscriptBlocks(
            existing,
            withStableBlockIds({
              ...applyUpdates(updates),
              status: live ? "running" : "idle",
            }),
          ),
        },
      });
    } catch (err) {
      if (get().inspectingSubagent === childSessionId) {
        set({ subagentError: err instanceof Error ? err.message : String(err) });
      }
    }
  },

  closeSubagentInspector: () => {
    if (!get().inspectingSubagent) return;
    set({ inspectingSubagent: null, subagentError: null });
  },

  toggleSubagentRoster: () => {
    const id = get().selectedSession;
    const items = id ? get().subagents[id] ?? [] : [];
    const showing = get().subagentRosterOpen ?? runningSubagentCount(items) > 0;
    set({ subagentRosterOpen: !showing });
  },

  stopSubagent: async (childSessionId) => {
    const parentId = get().selectedSession;
    if (!parentId) return;
    set({ subagentError: null });
    try {
      await api.cancelSubagent(parentId, childSessionId);
      rememberSubagents(
        parentId,
        (get().subagents[parentId] ?? []).map((item) =>
          item.childSessionId === childSessionId || item.subagentId === childSessionId
            ? { ...item, status: "cancelled", watchStatus: "done" }
            : item,
        ),
        get,
        set,
      );
      void get().loadSubagents(parentId);
    } catch (err) {
      set({ subagentError: err instanceof Error ? err.message : String(err) });
    }
  },

  refreshInspectedSubagent: async () => {
    const childId = get().inspectingSubagent;
    const parentId = get().selectedSession;
    if (!childId || !parentId) return;
    const info = (get().subagents[parentId] ?? []).find(
      (item) => item.childSessionId === childId || item.subagentId === childId,
    );
    const cwd = info?.childCwd || get().selectedCwd;
    if (!cwd) return;
    try {
      const updates = (await api.hydrateSession(childId, cwd)) as SessionUpdate[];
      if (get().inspectingSubagent !== childId) return;
      const existing = get().transcripts[childId];
      const live = info ? isLiveSubagent(info) : false;
      const next = reuseTranscriptBlocks(
        existing,
        withStableBlockIds({
          ...applyUpdates(updates),
          status: live ? "running" : "idle",
        }),
      );
      if (existing && transcriptViewKey(existing) === transcriptViewKey(next)) return;
      set({
        transcripts: {
          ...get().transcripts,
          [childId]: next,
        },
      });
    } catch {
      /* keep the last snapshot */
    }
  },

  refreshHeadlessWatch: async () => {
    const sessionId = get().selectedSession;
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!sessionId || !thread) return;
    if (!isReadOnlySession(sessionId, get().threads, get().readOnlyIds)) return;
    try {
      const latest = await api.findThread(sessionId).catch(() => thread);
      const threads = get().threads.map((item) => (item.sessionId === sessionId ? { ...item, ...latest } : item));
      if (!get().threads.some((item) => item.sessionId === sessionId)) return;
      const prevWatch = thread.watchStatus;
      set({ threads });
      const unchanged = latest.watchStatus === prevWatch && latest.watchStatus !== "running";
      if (unchanged && get().transcripts[sessionId]?.blocks.length) return;
      const updates = (await api.hydrateSession(sessionId, thread.cwd)) as SessionUpdate[];
      if (get().selectedSession !== sessionId) return;
      const live = latest.watchStatus === "running";
      const prev = get().transcripts[sessionId];
      const next = reuseTranscriptBlocks(
        prev,
        withStableBlockIds({
          ...applyUpdates(updates),
          status: live ? "running" : latest.watchStatus === "error" ? "error" : "idle",
        }),
      );
      if (prev === next || (prev && transcriptViewKey(prev) === transcriptViewKey(next))) return;
      set({
        transcripts: {
          ...get().transcripts,
          [sessionId]: next,
        },
      });
    } catch {
      /* keep the last snapshot */
    }
  },

  loadPlanDoc: async () => {
    const sessionId = get().selectedSession;
    const cwd = get().selectedCwd;
    if (!sessionId || !cwd) {
      set({ planDoc: null });
      return;
    }
    try {
      const doc = await api.readPlan(sessionId, cwd);
      if (get().selectedSession !== sessionId) return;
      const prev = get().planDoc;
      if (prev && prev.markdown === doc.markdown && prev.exists === doc.exists && prev.path === doc.path) {
        return;
      }
      set({ planDoc: doc });
    } catch {
      /* plan file is optional */
    }
  },

  openPlanPanel: (review = false) => {
    set({ planPanelOpen: true, planReviewOpen: review || get().planReviewOpen });
    void get().loadPlanDoc();
  },

  setPlanDirty: (dirty) => {
    if (get().planDirty === dirty) return;
    set({ planDirty: dirty });
  },

  closePlanPanel: () => {
    if (get().planDirty && !window.confirm("Discard unsaved plan edits?")) return false;
    set({ planPanelOpen: false, planReviewOpen: false, planDirty: false });
    return true;
  },

  savePlan: async (markdown) => {
    const sessionId = get().selectedSession;
    const cwd = get().selectedCwd;
    if (!sessionId || !cwd) return;
    if (isReadOnlySession(sessionId, get().threads, get().readOnlyIds)) return;
    const doc = await api.writePlan(sessionId, cwd, markdown);
    if (get().selectedSession !== sessionId) return;
    set({ planDoc: doc, planDirty: false });
  },

  approvePlan: async (comments = [], notes) => {
    const permission = get().permission;
    if (permission && isPlanPermission(permission)) {
      const allow = preferAllowOption(permission.options);
      await get().answerPermission(allow?.optionId);
    }
    const text = formatPlanFeedback(comments, notes);
    set({ planReviewOpen: false, planPanelOpen: true, planDirty: false });
    void get().loadPlanDoc();
    if (text) {
      set({ composer: text });
      await get().send();
    }
  },

  revisePlan: async (notes, comments = []) => {
    const permission = get().permission;
    if (permission && isPlanPermission(permission)) {
      const reject = preferRejectOption(permission.options);
      if (reject) await get().answerPermission(reject.optionId);
      else await get().answerPermission(undefined, true);
    }
    const text = formatPlanFeedback(comments, notes);
    set({ planReviewOpen: false, planPanelOpen: true, composer: text, planDirty: false });
    if (text) await get().send();
  },

  quitPlan: async () => {
    set({ planReviewOpen: false, planPanelOpen: false, planDirty: false });
    if (get().sending) await get().stop();
    else if (get().permission) await get().answerPermission(undefined, true);
    await get().setMode("ask");
  },

  expandTool: async (id) => {
    const sessionId = get().inspectingSubagent ?? get().selectedSession;
    const parentId = get().selectedSession;
    const child = parentId
      ? (get().subagents[parentId] ?? []).find(
          (item) => item.childSessionId === sessionId || item.subagentId === sessionId,
        )
      : undefined;
    const cwd = child?.childCwd || get().selectedCwd;
    if (!sessionId || !cwd) return;
    const current = get().transcripts[sessionId];
    if (!current) return;
    const block = current.blocks.find((item) => item.id === id);
    if (!block || block.type !== "tool") return;
    if (block.collapsed) {
      set({
        transcripts: { ...get().transcripts, [sessionId]: toggleBlock(current, id) },
      });
    }
    if (!block.truncated) return;
    try {
      const full = await api.loadToolBody(sessionId, cwd, block.toolCallId);
      const live = get().transcripts[sessionId];
      if (!live || (get().inspectingSubagent ?? get().selectedSession) !== sessionId) return;
      set({
        transcripts: {
          ...get().transcripts,
          [sessionId]: {
            ...live,
            blocks: live.blocks.map((item) => {
              if (item.id !== id || item.type !== "tool") return item;
              const next: ToolBlock = {
                ...item,
                input: full.input ?? item.input,
                output: full.output ?? item.output,
                content: full.content ?? item.content,
                truncated: false,
              };
              return next;
            }),
          },
        },
      });
    } catch {
      /* keep the truncated preview */
    }
  },

  archiveThread: (sessionId) => {
    useWorkspace.getState().task(sessionId, { archived: true });
    const { archivedThreads, archivedProjects, threads, selectedSession } = get();
    if (archivedThreads.includes(sessionId)) return;
    const nextThreads = withArchived(archivedThreads, sessionId);
    saveArchive({ threads: nextThreads, projects: archivedProjects });
    const current = threads.find((thread) => thread.sessionId === sessionId);
    const sibling =
      selectedSession === sessionId && current
        ? threads.find(
            (thread) =>
              thread.sessionId !== sessionId &&
              sameProject(thread.cwd, current.cwd) &&
              !nextThreads.includes(thread.sessionId) &&
              !archivedProjects.includes(normalizeCwd(thread.cwd)),
          )
        : undefined;
    set({
      archivedThreads: nextThreads,
      selectedSession: selectedSession === sessionId && !sibling ? null : selectedSession,
    });
    if (sibling) void get().openThread(sibling);
  },

  unarchiveThread: (sessionId) => {
    useWorkspace.getState().task(sessionId, { archived: false });
    const { archivedThreads, archivedProjects, threads } = get();
    const thread = threads.find((item) => item.sessionId === sessionId);
    const nextThreads = withoutArchived(archivedThreads, sessionId);
    const nextProjects = thread
      ? withoutArchived(archivedProjects, normalizeCwd(thread.cwd))
      : archivedProjects;
    saveArchive({ threads: nextThreads, projects: nextProjects });
    set({ archivedThreads: nextThreads, archivedProjects: nextProjects });
  },

  deleteThread: async (sessionId) => {
    if (isRunning(get().tasks[sessionId])) throw new Error("Stop this task before deleting it");
    await desktop.closeTask(sessionId);
    const { threads, archivedThreads, archivedProjects, selectedSession, transcripts } = get();
    const thread = threads.find((item) => item.sessionId === sessionId);
    if (!thread) return;
    try {
      await api.deleteThread(sessionId, thread.cwd);
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const nextArchivedThreads = withoutArchived(archivedThreads, sessionId);
    const leftover = threads.some(
      (item) => item.sessionId !== sessionId && sameProject(item.cwd, thread.cwd),
    );
    const nextProjects = leftover
      ? archivedProjects
      : withoutArchived(archivedProjects, normalizeCwd(thread.cwd));
    saveArchive({ threads: nextArchivedThreads, projects: nextProjects });
    const nextTranscripts = { ...transcripts };
    delete nextTranscripts[sessionId];
    set({
      archivedThreads: nextArchivedThreads,
      archivedProjects: nextProjects,
      threads: threads.filter((item) => item.sessionId !== sessionId),
      transcripts: nextTranscripts,
      selectedSession: selectedSession === sessionId ? null : selectedSession,
      readOnlyIds: withoutArchived(get().readOnlyIds, sessionId),
    });
    await get().refreshLists();
  },

  archiveProject: (cwd) => {
    useWorkspace.getState().update({ archivedProjects: withArchived(useWorkspace.getState().data.archivedProjects, cwd) });
    const key = normalizeCwd(cwd);
    const { archivedThreads, archivedProjects, selectedCwd, selectedSession, threads } = get();
    if (archivedProjects.includes(key)) return;
    const nextProjects = withArchived(archivedProjects, key);
    saveArchive({ threads: archivedThreads, projects: nextProjects });
    const selectedGone = selectedCwd ? sameProject(selectedCwd, key) : false;
    const sessionGone =
      selectedGone ||
      (selectedSession
        ? threads.some((thread) => thread.sessionId === selectedSession && sameProject(thread.cwd, key))
        : false);
    set({
      archivedProjects: nextProjects,
      selectedCwd: selectedGone ? null : selectedCwd,
      selectedSession: sessionGone ? null : selectedSession,
    });
    if (selectedGone) localStorage.removeItem("gz.cwd");
  },

  unarchiveProject: (cwd) => {
    useWorkspace.getState().update({ archivedProjects: withoutArchived(useWorkspace.getState().data.archivedProjects, cwd) });
    const key = normalizeCwd(cwd);
    const { archivedThreads, archivedProjects } = get();
    const nextProjects = withoutArchived(archivedProjects, key);
    saveArchive({ threads: archivedThreads, projects: nextProjects });
    set({ archivedProjects: nextProjects });
  },

  setExplorerOpen: (open) => set({ explorerOpen: open }),
  setSlashOpen: (open) => set({ slashOpen: open }),
  setTheme: (theme) => {
    const preference = normalizeThemeId(theme);
    useWorkspace.getState().settings({ theme: preference });
    const resolved = actualTheme(preference);
    applyTheme(resolved);
    set({ theme: resolved });
  },
});
});
