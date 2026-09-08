export const EXPLORER_DRAG = "application/x-grokzilla-entry";

export type ExplorerEntry = {
  path: string;
  rel: string;
  kind: "file" | "folder" | "image" | string;
};

export function setExplorerDrag(data: DataTransfer, entry: ExplorerEntry): void {
  const payload = JSON.stringify({
    path: entry.path,
    rel: entry.rel,
    kind: entry.kind === "folder" ? "folder" : "file",
  });
  data.setData(EXPLORER_DRAG, payload);
  data.setData("text/plain", `@${entry.rel}`);
  data.effectAllowed = "copy";
}

export function getExplorerDrag(data: DataTransfer): ExplorerEntry | null {
  const raw = data.getData(EXPLORER_DRAG);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ExplorerEntry;
    if (!parsed.path || !parsed.rel) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasExplorerDrag(data: DataTransfer): boolean {
  return [...data.types].includes(EXPLORER_DRAG);
}
