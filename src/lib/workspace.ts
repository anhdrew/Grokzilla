import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Attachment } from './types';
import { loadArchive } from './archive';

export type Settings = { theme: 'system' | 'light' | 'dark'; grokPath: string; defaultModel: string; defaultMode: string; concurrency: number; shell: string; notifications: boolean };
export type TaskMetadata = { title?: string; pinned?: boolean; order?: number; archived?: boolean; cwd?: string; repository?: string; branch?: string; base?: string; environment?: 'local' | 'worktree'; draft?: string; attachments?: Attachment[]; scrollTop?: number; model?: string; effort?: string; mode?: string };
export type ScheduleRun = { at: number; status: 'queued' | 'completed' | 'failed' | 'skipped'; sessionId?: string; error?: string };
export type Schedule = { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; nextAt: number; enabled: boolean; runs: ScheduleRun[] };
export type WorkspaceData = { version: 1; settings: Settings; tasks: Record<string, TaskMetadata>; projects: string[]; archivedProjects: string[]; selectedCwd: string | null; selectedSession: string | null; layout: { sidebar: number; right: number; terminal: number; rightOpen: boolean; terminalOpen: boolean }; schedules: Schedule[] };
export const defaults: WorkspaceData = { version: 1, settings: { theme: 'system', grokPath: '', defaultModel: '', defaultMode: 'ask', concurrency: 3, shell: '/bin/zsh', notifications: true }, tasks: {}, projects: [], archivedProjects: [], selectedCwd: null, selectedSession: null, layout: { sidebar: 242, right: 460, terminal: 260, rightOpen: true, terminalOpen: false }, schedules: [] };
export function normalizeWorkspace(
  raw: Partial<Omit<WorkspaceData, "settings" | "layout">> & {
    version?: number;
    settings?: Partial<Settings>;
    layout?: Partial<WorkspaceData["layout"]>;
  },
): WorkspaceData {
  if (raw.version !== 1) throw new Error('Unsupported workspace version');
  const settings = { ...defaults.settings, ...raw.settings };
  const concurrency = Math.floor(Number(settings.concurrency));
  settings.concurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(8, concurrency)) : 3;
  return { ...defaults, ...raw, settings, layout: { ...defaults.layout, ...raw.layout } };
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let writes = Promise.resolve();
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { data, loaded } = useWorkspace.getState(); if (!loaded) return;
    writes = writes.catch(() => {}).then(() => invoke('write_workspace', { value: data })).then(() => { useWorkspace.setState({ error: null }); }).catch(e => { useWorkspace.setState({ error: String(e) }); });
  }, 200);
}
export const useWorkspace = create<{
  data: WorkspaceData; loaded: boolean; error: string | null; settingsOpen: boolean; paletteOpen: boolean; newTaskOpen: boolean; newTaskCwd: string | null; rightTab: 'files' | 'changes'; file: { path: string; line?: number } | null;
  load: () => Promise<void>; update: (patch: Partial<WorkspaceData>) => void; task: (id: string, patch: Partial<TaskMetadata>) => void; settings: (patch: Partial<Settings>) => void; openFile: (path: string, line?: number) => void;
  toggleRight: (tab?: 'files' | 'changes') => void; toggleTerminal: () => void; openNewTask: (cwd?: string | null) => void; closeOverlays: () => boolean;
}>((set, get) => ({
  data: structuredClone(defaults), loaded: false, error: null, settingsOpen: false, paletteOpen: false, newTaskOpen: false, newTaskCwd: null, rightTab: 'files', file: null,
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await invoke<WorkspaceData | null>('read_workspace');
      let data: WorkspaceData;
      if (raw) data = normalizeWorkspace(raw);
      else {
        const archive = loadArchive(); const legacyTheme = localStorage.getItem('gz.theme');
        data = { ...structuredClone(defaults), selectedCwd: localStorage.getItem('gz.cwd'), archivedProjects: archive.projects, tasks: Object.fromEntries(archive.threads.map(id => [id, { archived: true }])) };
        if (legacyTheme === 'dark' || legacyTheme === 'light') data.settings.theme = legacyTheme;
      }
      set({ data, loaded: true }); persist();
    } catch(e) { set({ error: String(e) }); throw e; }
  },
  update: patch => { set({ data: { ...get().data, ...patch } }); persist(); },
  task: (id, patch) => { const data = get().data; set({ data: { ...data, tasks: { ...data.tasks, [id]: { ...data.tasks[id], ...patch } } } }); persist(); },
  settings: patch => { const data = get().data; get().update({ settings: normalizeWorkspace({ ...data, settings: { ...data.settings, ...patch } }).settings }); },
  openFile: (path, line) => { set({ file: { path, line }, rightTab: 'files' }); get().update({ layout: { ...get().data.layout, rightOpen: true } }); },
  toggleRight: (tab) => {
    const layout = get().data.layout;
    if (tab) set({ rightTab: tab });
    get().update({ layout: { ...layout, rightOpen: tab ? true : !layout.rightOpen } });
  },
  toggleTerminal: () => {
    const layout = get().data.layout;
    get().update({ layout: { ...layout, terminalOpen: !layout.terminalOpen } });
  },
  openNewTask: (cwd) => set({ newTaskOpen: true, newTaskCwd: cwd ?? get().data.selectedCwd, paletteOpen: false }),
  closeOverlays: () => {
    const state = get();
    if (state.paletteOpen) { set({ paletteOpen: false }); return true; }
    if (state.settingsOpen) { set({ settingsOpen: false }); return true; }
    if (state.newTaskOpen) { set({ newTaskOpen: false, newTaskCwd: null }); return true; }
    return false;
  },
}));

export type GitInfo = { root: string; branch: string; branches: string[]; dirty: boolean };
export type DiffFile = { path: string; oldPath?: string; status: string; patch: string; additions: number; deletions: number };
export type Review = { token: string; files: DiffFile[] };
export type FilePreview = { path: string; kind: 'image' | 'markdown' | 'code'; content: string; size: number };
export const desktop = {
  gitInfo: (cwd: string) => invoke<GitInfo>('git_info', { cwd }),
  review: (cwd: string, scope: string, base: string) => invoke<Review>('git_review', { cwd, scope, base }),
  gitAction: (args: { cwd: string; scope: string; base: string; token: string; action: string; path?: string; hunk?: number; message?: string }) => invoke<string>('git_action', args),
  readFile: (cwd: string, path: string) => invoke<FilePreview>('read_workspace_file', { cwd, path }),
  createWorktree: (cwd: string, base: string) => invoke<TaskMetadata & { cwd: string }>('create_worktree', { cwd, base }),
  removeWorktree: (repository: string, cwd: string) => invoke<void>('remove_worktree', { repository, cwd }),
  mergeWorktree: (repository: string, branch: string, target: string) => invoke<string>('merge_worktree', { repository, branch, target }),
  configure: (grokPath: string) => invoke<void>('configure_runtime', { grokPath }),
  closeTask: (sessionId: string) => invoke<void>('close_task', { sessionId }),
  terminalOpen: (taskId: string, cwd: string, shell: string, cols: number, rows: number) =>
    invoke<string>('terminal_open', { taskId, cwd, shell, cols, rows }),
  terminalWrite: (id: string, data: string) => invoke<void>('terminal_write', { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => invoke<void>('terminal_resize', { id, cols, rows }),
  terminalClose: (id: string) => invoke<void>('terminal_close', { id }),
};
export function actualTheme(theme: Settings['theme']): 'light' | 'dark' { return theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme; }
