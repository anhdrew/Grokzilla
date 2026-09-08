import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { desktop } from "./workspace";

export type TerminalTab = {
  id: string;
  taskId: string;
  cwd: string;
  title: string;
  ptyId?: string;
  exited?: boolean;
};

type TerminalEvent = { id: string; taskId?: string; bytes?: number[] | string; exitCode?: number };

const writers = new Map<string, (bytes: Uint8Array) => void>();
let listening = false;

export function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return new Uint8Array();
}

export function attachTerminalWriter(id: string, write: (bytes: Uint8Array) => void) {
  writers.set(id, write);
  return () => {
    if (writers.get(id) === write) writers.delete(id);
  };
}

export async function listenTerminalEvents() {
  if (listening) return;
  listening = true;
  await listen<TerminalEvent>("terminal-data", (event) => {
    const bytes = toBytes(event.payload.bytes);
    if (!bytes.length) return;
    writers.get(event.payload.id)?.(bytes);
  });
  await listen<TerminalEvent>("terminal-exit", (event) => {
    useTerminals.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.ptyId === event.payload.id ? { ...tab, exited: true } : tab)),
    }));
  });
}

export const useTerminals = create<{
  tabs: TerminalTab[];
  active: Record<string, string>;
  ensure: (taskId: string, cwd: string) => string;
  activate: (taskId: string, id: string) => void;
  close: (id: string) => Promise<void>;
  create: (taskId: string, cwd: string) => Promise<string>;
}>((set, get) => ({
  tabs: [],
  active: {},
  ensure: (taskId, cwd) => {
    const existing = get().tabs.find((tab) => tab.taskId === taskId && !tab.exited);
    if (existing) {
      set({ active: { ...get().active, [taskId]: existing.id } });
      return existing.id;
    }
    const id = `tab-${crypto.randomUUID()}`;
    const tab: TerminalTab = { id, taskId, cwd, title: "Terminal" };
    set({ tabs: [...get().tabs, tab], active: { ...get().active, [taskId]: id } });
    return id;
  },
  activate: (taskId, id) => set({ active: { ...get().active, [taskId]: id } }),
  close: async (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (tab?.ptyId) await desktop.terminalClose(tab.ptyId).catch(() => {});
    const tabs = get().tabs.filter((item) => item.id !== id);
    const active = { ...get().active };
    if (tab && active[tab.taskId] === id) {
      const next = tabs.find((item) => item.taskId === tab.taskId);
      if (next) active[tab.taskId] = next.id;
      else delete active[tab.taskId];
    }
    set({ tabs, active });
  },
  create: async (taskId, cwd) => {
    const id = `tab-${crypto.randomUUID()}`;
    const count = get().tabs.filter((tab) => tab.taskId === taskId).length + 1;
    set({
      tabs: [...get().tabs, { id, taskId, cwd, title: count === 1 ? "Terminal" : `Terminal ${count}` }],
      active: { ...get().active, [taskId]: id },
    });
    return id;
  },
}));
