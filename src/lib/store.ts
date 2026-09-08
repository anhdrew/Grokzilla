import { startTransition } from "react";
import { create } from "zustand";
import { loadArchive, saveArchive, withArchived, withoutArchived } from "./archive";
import { api } from "./api";
import {
  hasInProgressTools,
  isReadOnlySession,
  isSafeSessionId,
  isTurnEndUpdate,
  isWorkUpdate,
  normalizeCwd,
  normalizeModeId,
  parseSessionId,
  sameProject,
} from "./format";
import { EFFORT_CONFIG_ID, mergeModelState, modelsFrom } from "./models";
import { isExitPlanUpdate, isPlanPermission, preferAllowOption, preferRejectOption } from "./plan";
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
  ThreadInfo,
  ThreadStats,
  ToolBlock,
  Transcript,
} from "./types";

export const MODES = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "yolo", label: "Always" },
] as const;

type AppState = {
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
  theme: "light" | "dark";
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

  bootstrap: () => Promise<void>;
  refreshLists: () => Promise<void>;
  login: () => Promise<void>;
  handleEvent: (event: AcpEvent) => void;
  selectProject: (cwd: string) => void;
  openThread: (thread: ThreadInfo, opts?: { readOnly?: boolean }) => Promise<void>;
  openBySessionId: (sessionId: string, readOnly?: boolean) => Promise<void>;
  openInTerminal: (thread: ThreadInfo) => Promise<void>;
  newThread: (cwd?: string) => Promise<void>;
  setComposer: (text: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setEffort: (effortId: string) => Promise<void>;
  answerPermission: (optionId?: string, cancelled?: boolean) => Promise<void>;
  toggle: (id: string) => void;
  setExplorerOpen: (open: boolean) => void;
  attachEntry: (item: Attachment) => void;
  setSlashOpen: (open: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
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
  openPlanPanel: (review?: boolean) => void;
  closePlanPanel: () => void;
  approvePlan: () => Promise<void>;
  revisePlan: (notes?: string) => Promise<void>;
  quitPlan: () => Promise<void>;
};

const initialArchive = loadArchive();

function applyTheme(theme: "light" | "dark") {
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
): Record<string, Transcript> {
  const ids = Object.keys(transcripts);
  if (ids.length <= TRANSCRIPT_LRU) return transcripts;
  const next = { ...transcripts };
  const drop = ids.length - TRANSCRIPT_LRU;
  let removed = 0;
  for (const id of ids) {
    if (id === keepId) continue;
    delete next[id];
    removed += 1;
    if (removed >= drop) break;
  }
  return next;
}

function flushStreamEvents(
  events: AcpEvent[],
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  let transcripts = get().transcripts;
  let changed = false;
  let modelPatch: ReturnType<typeof applyModelRaw> | undefined;
  let sawExitPlan = false;
  let sawPlanUpdate = false;
  let liveSelected = false;
  let endSelected = false;
  const ignoring = get().ignoringReplay;
  const selected = get().selectedSession;
  for (const event of events) {
    if (event.kind !== "update" || !event.sessionId) continue;
    if (ignoring && event.sessionId === selected) continue;
    const update = event.payload as SessionUpdate;
    const current = transcripts[event.sessionId] ?? emptyTranscript();
    let next = applyUpdate(current, update);
    if (update.sessionUpdate === "current_mode_update") {
      const modeId = normalizeModeId(String(update.currentModeId ?? update.modeId ?? ""));
      if (modeId) next.modeId = modeId;
    }
    if (update.sessionUpdate === "plan") sawPlanUpdate = true;
    if (isExitPlanUpdate(update)) sawExitPlan = true;
    if (event.sessionId === selected && isWorkUpdate(update.sessionUpdate) && get().sending) {
      liveSelected = true;
      if (next.status !== "needs-input" && next.status !== "error") {
        next = { ...next, status: "running" };
      }
    }
    if (event.sessionId === selected && isTurnEndUpdate(update.sessionUpdate)) {
      endSelected = !hasInProgressTools(next.blocks);
    }
    if (update.sessionUpdate === "config_option_update") {
      modelPatch = applyModelRaw(event.payload, { ...get(), transcripts }, event.sessionId);
      transcripts = {
        ...modelPatch.transcripts,
        [event.sessionId]: { ...next, effortId: modelPatch.currentEffort ?? next.effortId },
      };
      changed = true;
      continue;
    }
    if (next !== current) {
      transcripts = { ...transcripts, [event.sessionId]: next };
      changed = true;
    }
  }
  if (!changed && !modelPatch && !sawExitPlan && !liveSelected && !endSelected) return;
  const extra: Partial<AppState> = {};
  if (sawExitPlan) {
    extra.planReviewOpen = true;
    extra.planPanelOpen = true;
  }
  if (liveSelected) extra.sending = true;
  if (endSelected) extra.sending = false;
  const apply = () => {
    if (modelPatch) set({ ...modelPatch, transcripts, ...extra });
    else set({ transcripts, ...extra });
  };
  if (liveSelected || endSelected || sawExitPlan) apply();
  else startTransition(apply);
  if (sawExitPlan || sawPlanUpdate) void get().loadPlanDoc();
}

function applyModelRaw(
  raw: unknown,
  prev: Pick<AppState, "models" | "currentModel" | "efforts" | "currentEffort" | "transcripts">,
  sessionId?: string | null,
): Pick<AppState, "models" | "currentModel" | "efforts" | "currentEffort" | "transcripts"> {
  const next = mergeModelState(
    {
      models: prev.models,
      currentModel: prev.currentModel,
      efforts: prev.efforts,
      currentEffort: prev.currentEffort,
    },
    modelsFrom(raw),
  );
  const transcripts = { ...prev.transcripts };
  if (sessionId && next.currentEffort) {
    const current = transcripts[sessionId] ?? emptyTranscript();
    transcripts[sessionId] = { ...current, effortId: next.currentEffort };
  }
  return { ...next, transcripts };
}

export const useApp = create<AppState>((set, get) => ({
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
  theme:
    localStorage.getItem("gz.theme") === "dark" || localStorage.getItem("gz.theme") === "light"
      ? (localStorage.getItem("gz.theme") as "light" | "dark")
      : "light",

  bootstrap: async () => {
    if (bootLock) return bootLock;
    bootLock = (async () => {
      applyTheme(get().theme);
      const status = await api.grokStatus();
      set({ status, bootError: null });
      if (!status.grokPath || !status.loggedIn) return;
      set({ starting: true });
      try {
        const init = await api.startAgent();
        const authMethods = (init.authMethods ?? []) as Array<{ id: string }>;
        const method =
          (init._meta as { defaultAuthMethodId?: string } | undefined)?.defaultAuthMethodId ??
          authMethods[0]?.id ??
          "cached_token";
        const auth = await api.authenticate(method);
        set({
          connected: true,
          auth,
          ...applyModelRaw(init, get()),
          starting: false,
          bootError: null,
        });
        await get().refreshLists();
        await get().loadSkills();
        void get().loadUsage();
        const { selectedCwd, threads } = get();
        if (selectedCwd) {
          const match =
            threads.find((t) => t.cwd === selectedCwd && !t.headless) ??
            threads.find((t) => t.cwd === selectedCwd);
          if (match) void get().openThread(match);
        }
      } catch (err) {
        set({
          starting: false,
          connected: false,
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
    set({ threads: lists.threads, projects: lists.projects });
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

  handleEvent: (event) => {
    if (isUrgentEvent(event)) {
      cancelFrame();
      const queued = pendingEvents.splice(0);
      if (queued.length) flushStreamEvents(queued, get, set);
    }
    if (event.kind === "exit") {
      if (get().starting) return;
      set({ connected: false, bootError: "Grok agent disconnected. Reconnecting…" });
      void get().bootstrap();
      return;
    }
    if (event.kind === "permission" && event.id != null) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const options = (payload.options ?? []) as PermissionRequest["options"];
      const permission: PermissionRequest = {
        id: event.id,
        sessionId: event.sessionId ?? get().selectedSession ?? "",
        title: typeof payload.title === "string" ? payload.title : undefined,
        toolCall: (payload.toolCall ?? payload.tool_call) as Record<string, unknown> | undefined,
        options,
        raw: payload,
      };
      const planPerm = isPlanPermission(permission);
      set({
        permission,
        ...(planPerm ? { planReviewOpen: true, planPanelOpen: true } : {}),
      });
      if (planPerm) void get().loadPlanDoc();
      const sid = event.sessionId;
      if (sid) {
        const current = get().transcripts[sid] ?? emptyTranscript();
        set({
          transcripts: {
            ...get().transcripts,
            [sid]: { ...current, status: "needs-input" },
          },
        });
      }
      return;
    }
    if (event.kind === "notification") {
      if (event.method?.includes("mcp")) {
        set({ mcpNote: "MCP connected" });
      }
      if (event.method?.includes("models/update")) {
        set(applyModelRaw(event.payload, get(), event.sessionId ?? get().selectedSession));
      }
      return;
    }
    if (event.kind === "log") return;
    if (event.kind === "batch") {
      const raw = event.payload as { updates?: AcpEvent[] } | AcpEvent[] | undefined;
      const updates = Array.isArray(raw) ? raw : (raw?.updates ?? []);
      pendingEvents.push(...updates);
    } else if (event.kind === "update" && event.sessionId) {
      pendingEvents.push(event);
    } else {
      return;
    }
    if (flushHandle) return;
    scheduleFrame(() => {
      flushHandle = 0;
      const events = pendingEvents.splice(0);
      if (events.length) flushStreamEvents(events, get, set);
    });
  },

  selectProject: (cwd) => {
    const normalized = cwd.replace(/\/+$/, "") || cwd;
    localStorage.setItem("gz.cwd", normalized);
    set({ selectedCwd: normalized });
    void get().loadSkills(normalized);
  },

  openThread: async (thread, opts) => {
    const cwd = thread.cwd.replace(/\/+$/, "") || thread.cwd;
    const existing = get().transcripts[thread.sessionId];
    const readOnly = Boolean(opts?.readOnly || thread.headless);
    const gen = ++threadLoadGen;
    const readOnlyIds = readOnly
      ? withArchived(get().readOnlyIds, thread.sessionId)
      : withoutArchived(get().readOnlyIds, thread.sessionId);
    set({
      selectedCwd: cwd,
      selectedSession: thread.sessionId,
      threadStats: null,
      sending: false,
      ignoringReplay: true,
      permission: null,
      planReviewOpen: false,
      readOnlyIds,
      currentEffort: existing?.effortId ?? get().currentEffort,
      transcripts: pruneTranscripts(get().transcripts, thread.sessionId),
    });
    localStorage.setItem("gz.cwd", cwd);
    void get().loadSkills(cwd);
    void get().loadThreadStats();
    try {
      const updates = (await api.hydrateSession(thread.sessionId, thread.cwd)) as SessionUpdate[];
      if (gen !== threadLoadGen) return;
      const watch = readOnly
        ? thread.watchStatus === "running"
          ? "running"
          : thread.watchStatus === "error"
            ? "error"
            : "idle"
        : "idle";
      set({
        transcripts: {
          ...get().transcripts,
          [thread.sessionId]: reuseTranscriptBlocks(
            existing,
            withStableBlockIds({ ...applyUpdates(updates), status: watch }),
          ),
        },
      });
      void get().loadPlanDoc();
      if (readOnly) {
        set({ ignoringReplay: false });
        void get().refreshHeadlessWatch();
        return;
      }
      const loaded = await api.loadSession(thread.sessionId, thread.cwd);
      if (gen !== threadLoadGen) return;
      set({
        ignoringReplay: false,
        ...applyModelRaw(loaded.raw, get(), thread.sessionId),
      });
      void get().loadThreadStats();
      void get().loadPlanDoc();
    } catch (err) {
      if (gen !== threadLoadGen) return;
      set({
        ignoringReplay: false,
        bootError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  openBySessionId: async (raw, readOnly = true) => {
    const sessionId = parseSessionId(raw);
    if (!sessionId) throw new Error("Enter a session id");
    if (!isSafeSessionId(sessionId)) throw new Error("That is not a valid session id");
    let thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread) {
      const found = await api.findThread(sessionId);
      set({
        threads: [found, ...get().threads.filter((item) => item.sessionId !== found.sessionId)],
      });
      thread = found;
    }
    if (get().archivedThreads.includes(thread.sessionId)) get().unarchiveThread(thread.sessionId);
    await get().openThread(thread, { readOnly });
  },

  openInTerminal: async (thread) => {
    try {
      await api.openInTerminal(thread.sessionId, thread.cwd);
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  newThread: async (cwd) => {
    const target = (cwd ?? get().selectedCwd)?.replace(/\/+$/, "") || cwd || get().selectedCwd;
    if (!target) return;
    const created = await api.newSession(target);
    const transcripts = {
      ...get().transcripts,
      [created.sessionId]: emptyTranscript(),
    };
    set({
      selectedCwd: target,
      selectedSession: created.sessionId,
      composer: "",
      attachments: [],
      threadStats: null,
      planDoc: null,
      planPanelOpen: false,
      planReviewOpen: false,
      ...applyModelRaw(created.raw, { ...get(), transcripts }, created.sessionId),
    });
    localStorage.setItem("gz.cwd", target);
    void get().loadSkills(target);
    await get().refreshLists();
    void get().loadThreadStats();
  },

  setComposer: (text) => set({ composer: text, slashOpen: text.startsWith("/") }),

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
    const { composer, selectedSession, selectedCwd, sending } = get();
    let text = composer.trim();
    let attachments = get().attachments;
    const first = text.split(/\s+/)[0] ?? "";
    if (first === "/resume" || first === "/view") {
      const rest = text.slice(first.length).trim();
      set({ composer: "", slashOpen: false });
      try {
        await get().openBySessionId(rest, first === "/view");
      } catch (err) {
        set({ bootError: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (isReadOnlySession(selectedSession, get().threads, get().readOnlyIds)) return;
    if ((!text && attachments.length === 0) || sending) return;
    if (first === "/new" || first === "/clear") {
      set({ composer: "", slashOpen: false, attachments: [] });
      await get().newThread();
      return;
    }
    if (first === "/always-approve" || first === "/yolo") {
      set({ composer: "", slashOpen: false });
      await get().setMode("yolo");
      return;
    }
    if (first === "/view-plan" || first === "/show-plan" || first === "/plan-view") {
      set({ composer: "", slashOpen: false });
      get().openPlanPanel();
      return;
    }
    if (first === "/plan") {
      const rest = text.replace(/^\/plan\s*/i, "").trim();
      set({ composer: "", slashOpen: false });
      await get().setMode("plan");
      if (!rest) return;
      text = rest;
      attachments = [];
    }
    if (first === "/effort") {
      const level = text.split(/\s+/)[1];
      if (level) {
        set({ composer: "", slashOpen: false });
        await get().setEffort(level);
        return;
      }
    }
    let sessionId = selectedSession;
    if (!sessionId) {
      if (!selectedCwd) return;
      await get().newThread(selectedCwd);
      sessionId = get().selectedSession;
    }
    if (!sessionId) return;
    const display = [text, ...attachments.map((a) => `@${a.rel}`)].filter(Boolean).join(" ");
    const current = get().transcripts[sessionId] ?? emptyTranscript();
    set({
      composer: "",
      slashOpen: false,
      attachments: [],
      sending: true,
      transcripts: {
        ...get().transcripts,
        [sessionId]: {
          ...current,
          status: "running",
          blocks: current.blocks.some(
            (b) => b.type === "user" && b.text === display && current.blocks[current.blocks.length - 1] === b,
          )
            ? current.blocks
            : [...current.blocks, { type: "user", id: `local-${Date.now()}`, text: display }],
        },
      },
    });
    try {
      await api.sendPrompt(sessionId, text || display, attachments);
      const after = get().transcripts[sessionId] ?? emptyTranscript();
      const live = hasInProgressTools(after.blocks);
      set({
        sending: live,
        transcripts: {
          ...get().transcripts,
          [sessionId]: {
            ...after,
            status:
              after.status === "needs-input" ? "needs-input" : live ? "running" : "idle",
          },
        },
      });
      await get().refreshLists();
      void get().loadUsage();
      void get().loadThreadStats();
    } catch (err) {
      const after = get().transcripts[sessionId] ?? emptyTranscript();
      set({
        sending: false,
        bootError: err instanceof Error ? err.message : String(err),
        transcripts: {
          ...get().transcripts,
          [sessionId]: { ...after, status: "error" },
        },
      });
    }
  },

  stop: async () => {
    const sessionId = get().selectedSession;
    if (!sessionId) {
      set({ sending: false });
      return;
    }
    try {
      await api.cancelPrompt(sessionId);
    } catch {
      /* no in-flight prompt — still clear the working state */
    }
    if (get().permission) {
      try {
        await api.respondPermission(get().permission!.id, undefined, true);
      } catch {
        /* ignore */
      }
      set({ permission: null });
    }
    const current = get().transcripts[sessionId];
    set({
      sending: false,
      transcripts: current
        ? {
            ...get().transcripts,
            [sessionId]: {
              ...current,
              status: current.status === "needs-input" ? "idle" : current.status === "running" ? "idle" : current.status,
            },
          }
        : get().transcripts,
    });
  },

  setMode: async (modeId) => {
    const sessionId = get().selectedSession;
    if (!sessionId) return;
    if (isReadOnlySession(sessionId, get().threads, get().readOnlyIds)) return;
    const normalized = normalizeModeId(modeId) ?? modeId;
    const current = get().transcripts[sessionId] ?? emptyTranscript();
    if (current.modeId === normalized) return;
    set({
      transcripts: {
        ...get().transcripts,
        [sessionId]: { ...current, modeId: normalized },
      },
    });
    try {
      await api.setMode(sessionId, normalized);
    } catch {
      await api.sendPrompt(sessionId, `/${normalized === "yolo" ? "always-approve" : normalized}`);
    }
  },

  setModel: async (modelId) => {
    const sessionId = get().selectedSession;
    if (sessionId && isReadOnlySession(sessionId, get().threads, get().readOnlyIds)) return;
    const model = get().models.find((item) => item.modelId === modelId);
    const efforts = model?.reasoningEfforts ?? [];
    const supports = Boolean(model?.supportsReasoningEffort && efforts.length);
    let currentEffort = get().currentEffort;
    if (!supports) currentEffort = undefined;
    else if (!currentEffort || !efforts.some((effort) => effort.id === currentEffort)) {
      currentEffort = model?.reasoningEffort ?? efforts[0]?.id;
    }
    const transcripts = { ...get().transcripts };
    if (sessionId) {
      const current = transcripts[sessionId] ?? emptyTranscript();
      transcripts[sessionId] = { ...current, effortId: currentEffort };
    }
    set({
      currentModel: modelId,
      efforts: supports ? efforts : [],
      currentEffort,
      transcripts,
    });
    if (!sessionId) return;
    try {
      await api.setModel(sessionId, modelId);
    } catch {
      /* model switch is best-effort */
    }
  },

  setEffort: async (effortId) => {
    const sessionId = get().selectedSession;
    const transcripts = { ...get().transcripts };
    if (sessionId) {
      const current = transcripts[sessionId] ?? emptyTranscript();
      transcripts[sessionId] = { ...current, effortId };
    }
    set({ currentEffort: effortId, transcripts });
    if (!sessionId) return;
    try {
      await api.setConfigOption(sessionId, EFFORT_CONFIG_ID, effortId);
    } catch {
      try {
        await api.sendPrompt(sessionId, `/effort ${effortId}`);
      } catch {
        /* effort switch is best-effort */
      }
    }
  },

  answerPermission: async (optionId, cancelled = false) => {
    const permission = get().permission;
    if (!permission) return;
    await api.respondPermission(permission.id, optionId, cancelled);
    set({ permission: null, planReviewOpen: false });
  },

  toggle: (id) => {
    const sessionId = get().selectedSession;
    if (!sessionId) return;
    const current = get().transcripts[sessionId];
    if (!current) return;
    set({
      transcripts: { ...get().transcripts, [sessionId]: toggleBlock(current, id) },
    });
  },

  refreshHeadlessWatch: async () => {
    const sessionId = get().selectedSession;
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!sessionId || !thread) return;
    if (!isReadOnlySession(sessionId, get().threads, get().readOnlyIds)) return;
    try {
      const updates = (await api.hydrateSession(sessionId, thread.cwd)) as SessionUpdate[];
      if (get().selectedSession !== sessionId) return;
      await get().refreshLists();
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      const live = latest?.watchStatus === "running";
      const prev = get().transcripts[sessionId];
      const next = reuseTranscriptBlocks(
        prev,
        withStableBlockIds({
          ...applyUpdates(updates),
          status: live ? "running" : latest?.watchStatus === "error" ? "error" : "idle",
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

  closePlanPanel: () => {
    set({ planPanelOpen: false, planReviewOpen: false });
  },

  approvePlan: async () => {
    const permission = get().permission;
    if (permission && isPlanPermission(permission)) {
      const allow = preferAllowOption(permission.options);
      await get().answerPermission(allow?.optionId);
    }
    set({ planReviewOpen: false, planPanelOpen: true });
    void get().loadPlanDoc();
  },

  revisePlan: async (notes) => {
    const permission = get().permission;
    if (permission && isPlanPermission(permission)) {
      const reject = preferRejectOption(permission.options);
      if (reject) await get().answerPermission(reject.optionId);
      else await get().answerPermission(undefined, true);
    }
    const text = notes?.trim() ?? "";
    set({ planReviewOpen: false, planPanelOpen: true, composer: text });
    if (text && !get().sending) await get().send();
  },

  quitPlan: async () => {
    set({ planReviewOpen: false, planPanelOpen: false });
    if (get().sending) await get().stop();
    else if (get().permission) await get().answerPermission(undefined, true);
    await get().setMode("ask");
  },

  expandTool: async (id) => {
    const sessionId = get().selectedSession;
    const cwd = get().selectedCwd;
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
      if (!live || get().selectedSession !== sessionId) return;
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
    const key = normalizeCwd(cwd);
    const { archivedThreads, archivedProjects } = get();
    const nextProjects = withoutArchived(archivedProjects, key);
    saveArchive({ threads: archivedThreads, projects: nextProjects });
    set({ archivedProjects: nextProjects });
  },

  setExplorerOpen: (open) => set({ explorerOpen: open }),
  setSlashOpen: (open) => set({ slashOpen: open }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
