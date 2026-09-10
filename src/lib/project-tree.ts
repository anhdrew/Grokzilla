import { normalizeCwd, sameProject } from "./format";

export function toggleExpanded(
  expanded: Iterable<string>,
  cwd: string,
): { expanded: Set<string>; userCollapsed: string | null } {
  const key = normalizeCwd(cwd);
  const next = new Set(Array.from(expanded, normalizeCwd));
  if (next.has(key)) {
    next.delete(key);
    return { expanded: next, userCollapsed: key };
  }
  next.add(key);
  return { expanded: next, userCollapsed: null };
}

export function expandSelectedIfAllowed(
  expanded: Iterable<string>,
  selected: string | null,
  userCollapsed: string | null,
): Set<string> | null {
  if (!selected) return null;
  if (userCollapsed && sameProject(userCollapsed, selected)) return null;
  const key = normalizeCwd(selected);
  const next = new Set(Array.from(expanded, normalizeCwd));
  if (next.has(key)) return null;
  next.add(key);
  return next;
}
