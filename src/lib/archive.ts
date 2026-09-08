const THREADS_KEY = "gz.archived.threads";
const PROJECTS_KEY = "gz.archived.projects";

export type ArchiveState = {
  threads: string[];
  projects: string[];
};

export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function readList(storage: StorageLike | null, key: string): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadArchive(storage: StorageLike | null = defaultStorage()): ArchiveState {
  return {
    threads: readList(storage, THREADS_KEY),
    projects: readList(storage, PROJECTS_KEY),
  };
}

export function saveArchive(state: ArchiveState, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  storage.setItem(THREADS_KEY, JSON.stringify([...new Set(state.threads)]));
  storage.setItem(PROJECTS_KEY, JSON.stringify([...new Set(state.projects)]));
}

export function withArchived(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

export function withoutArchived(list: string[], id: string): string[] {
  return list.filter((item) => item !== id);
}
