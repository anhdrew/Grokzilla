import { create } from "zustand";
import { loadArchive, saveArchive, withArchived, withoutArchived } from "./archive";
import { api } from "./api";
import { normalizeCwd, sameProject } from "./format";
import { EFFORT_CONFIG_ID, mergeModelState, modelsFrom } from "./models";
import { applyUpdate, applyUpdates, emptyTranscript, toggleBlock } from "./reducer";
import { rememberUsageSample, usageFrom, type UsageInfo } from "./usage";
import type {
  AcpEvent,
  Attachment,
  EffortInfo,
  GrokStatus,
  ModelInfo,
  PermissionRequest,
  ProjectInfo,
  SessionUpdate,
  SkillInfo,
  ThreadInfo,
  ThreadStats,
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
  usage: UsageInfo | null;
  threadStats: ThreadStats | null;

  bootstrap: () => Promise<void>;
  refreshLists: () => Promise<void>;
  login: () => Promise<void>;
  handleEvent: (event: AcpEvent) => void;
  selectProject: (cwd: string) => void;
  openThread: (thread: ThreadInfo) => Promise<void>;
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
};

const initialArchive = loadArchive();

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("gz.theme", theme);
}

let bootLock: Promise<void> | null = null;

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
  usage: null,
  threadStats: null,
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
          const match = threads.find((t) => t.cwd === selectedCwd);
          if (match) await get().openThread(match);
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
    const [threads, projects] = await Promise.all([api.listThreads(), api.listProjects()]);
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

  handleEvent: (event) => {
    if (event.kind === "exit") {
      if (get().starting) return;
      set({ connected: false, bootError: "Grok agent disconnected. Reconnecting…" });
      void get().bootstrap();
      return;
    }
    if (event.kind === "permission" && event.id != null) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const options = (payload.options ?? []) as PermissionRequest["options"];
      set({
        permission: {
          id: event.id,
          sessionId: event.sessionId ?? get().selectedSession ?? "",
          title: typeof payload.title === "string" ? payload.title : undefined,
          toolCall: (payload.toolCall ?? payload.tool_call) as Record<string, unknown> | undefined,
          options,
          raw: payload,
        },
      });
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
    if (event.kind !== "update" || !event.sessionId) return;
    if (get().ignoringReplay && event.sessionId === get().selectedSession) return;
    const update = event.payload as SessionUpdate;
    const current = get().transcripts[event.sessionId] ?? emptyTranscript();
    const next = applyUpdate(current, update);
    if (update.sessionUpdate === "current_mode_update" && update.currentModeId) {
      next.modeId = String(update.currentModeId);
    }
    if (update.sessionUpdate === "config_option_update") {
      const patch = applyModelRaw(event.payload, get(), event.sessionId);
      set({
        ...patch,
        transcripts: {
          ...patch.transcripts,
          [event.sessionId]: { ...next, effortId: patch.currentEffort ?? next.effortId },
        },
      });
      return;
    }
    set({
      transcripts: { ...get().transcripts, [event.sessionId]: next },
    });
  },

  selectProject: (cwd) => {
    const normalized = cwd.replace(/\/+$/, "") || cwd;
    localStorage.setItem("gz.cwd", normalized);
    set({ selectedCwd: normalized });
    void get().loadSkills(normalized);
  },

  openThread: async (thread) => {
    const cwd = thread.cwd.replace(/\/+$/, "") || thread.cwd;
    const existing = get().transcripts[thread.sessionId];
    set({
      selectedCwd: cwd,
      selectedSession: thread.sessionId,
      threadStats: null,
      ignoringReplay: true,
      permission: null,
      currentEffort: existing?.effortId ?? get().currentEffort,
    });
    localStorage.setItem("gz.cwd", cwd);
    void get().loadSkills(cwd);
    void get().loadThreadStats();
    try {
      const updates = (await api.hydrateSession(thread.sessionId, thread.cwd)) as SessionUpdate[];
      set({
        transcripts: {
          ...get().transcripts,
          [thread.sessionId]: { ...applyUpdates(updates), status: "idle" },
        },
      });
      const loaded = await api.loadSession(thread.sessionId, thread.cwd);
      await new Promise((r) => setTimeout(r, 40));
      set({
        ignoringReplay: false,
        ...applyModelRaw(loaded.raw, get(), thread.sessionId),
      });
      void get().loadThreadStats();
    } catch (err) {
      set({
        ignoringReplay: false,
        bootError: err instanceof Error ? err.message : String(err),
      });
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
    try {
      const skills = await api.listSkills(target);
      set({ skills });
    } catch {
      set({ skills: [] });
    }
  },

  send: async () => {
    const { composer, selectedSession, selectedCwd, sending, attachments } = get();
    const text = composer.trim();
    if ((!text && attachments.length === 0) || sending) return;
    const first = text.split(/\s+/)[0] ?? "";
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
    if (first === "/plan" && text === "/plan") {
      set({ composer: "", slashOpen: false });
      await get().setMode("plan");
      return;
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
      set({
        sending: false,
        transcripts: {
          ...get().transcripts,
          [sessionId]: { ...after, status: "idle" },
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
    if (!sessionId) return;
    await api.cancelPrompt(sessionId);
    if (get().permission) {
      await api.respondPermission(get().permission!.id, undefined, true);
      set({ permission: null });
    }
    set({ sending: false });
  },

  setMode: async (modeId) => {
    const sessionId = get().selectedSession;
    if (!sessionId) return;
    try {
      await api.setMode(sessionId, modeId);
    } catch {
      await api.sendPrompt(sessionId, `/${modeId === "yolo" ? "always-approve" : modeId}`);
    }
    const current = get().transcripts[sessionId] ?? emptyTranscript();
    set({
      transcripts: {
        ...get().transcripts,
        [sessionId]: { ...current, modeId },
      },
    });
  },

  setModel: async (modelId) => {
    const sessionId = get().selectedSession;
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
    set({ permission: null });
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
