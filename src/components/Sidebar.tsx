import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { normalizeCwd, projectName, relativeTime, sameProject, workStatus } from "../lib/format";
import { useApp } from "../lib/store";
import type { ThreadInfo } from "../lib/types";
import { IconArchive, IconFolder, IconPlus, IconSearch, IconTrash, IconUnarchive } from "./icons";

function threadLabel(thread: ThreadInfo): string {
  const title = thread.title?.trim();
  return title && title.length > 0 ? title : "New chat";
}

type ProjectGroup = { cwd: string; name: string; threads: ThreadInfo[] };

function matchesQuery(query: string, project: ProjectGroup, thread?: ThreadInfo): boolean {
  if (!query) return true;
  if (project.name.toLowerCase().includes(query)) return true;
  if (project.cwd.toLowerCase().includes(query)) return true;
  if (!thread) return false;
  return threadLabel(thread).toLowerCase().includes(query);
}

export function Sidebar() {
  const app = useApp();
  const selected = app.selectedCwd ? normalizeCwd(app.selectedCwd) : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected ? [selected] : []));
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setExpanded((prev) => {
      if (prev.has(selected)) return prev;
      const next = new Set(prev);
      next.add(selected);
      return next;
    });
  }, [selected]);

  const archivedThreadSet = useMemo(() => new Set(app.archivedThreads), [app.archivedThreads]);
  const archivedProjectSet = useMemo(
    () => new Set(app.archivedProjects.map(normalizeCwd)),
    [app.archivedProjects],
  );

  const { live, archivedFolders, archivedLoose } = useMemo(() => {
    const map = new Map<string, ProjectGroup>();
    for (const project of app.projects) {
      const key = normalizeCwd(project.cwd);
      map.set(key, { cwd: key, name: project.name, threads: [] });
    }
    if (selected && !map.has(selected)) {
      map.set(selected, { cwd: selected, name: projectName(selected), threads: [] });
    }
    for (const thread of app.threads) {
      const key = normalizeCwd(thread.cwd);
      const entry = map.get(key) ?? { cwd: key, name: projectName(key), threads: [] };
      entry.threads.push(thread);
      map.set(key, entry);
    }

    const q = query.trim().toLowerCase();
    const live: ProjectGroup[] = [];
    const archivedFolders: ProjectGroup[] = [];
    const archivedLoose: ProjectGroup[] = [];

    for (const project of map.values()) {
      const folderArchived = archivedProjectSet.has(project.cwd);
      if (folderArchived) {
        const threads = project.threads.filter((thread) => matchesQuery(q, project, thread));
        if (!q || matchesQuery(q, project) || threads.length > 0) {
          archivedFolders.push({ ...project, threads: q ? threads : project.threads });
        }
        continue;
      }
      const visible = project.threads.filter((thread) => !archivedThreadSet.has(thread.sessionId));
      const hidden = project.threads.filter((thread) => archivedThreadSet.has(thread.sessionId));
      const liveThreads = visible.filter((thread) => matchesQuery(q, project, thread));
      if (!q || matchesQuery(q, project) || liveThreads.length > 0) {
        live.push({ ...project, threads: q ? liveThreads : visible });
      }
      const looseThreads = hidden.filter((thread) => matchesQuery(q, project, thread));
      if (looseThreads.length > 0) {
        archivedLoose.push({ ...project, threads: q ? looseThreads : hidden });
      }
    }

    const byName = (a: ProjectGroup, b: ProjectGroup) => a.name.localeCompare(b.name);
    return {
      live: live.sort(byName),
      archivedFolders: archivedFolders.sort(byName),
      archivedLoose: archivedLoose.sort(byName),
    };
  }, [app.projects, app.threads, archivedProjectSet, archivedThreadSet, query, selected]);

  const archivedCount =
    archivedFolders.reduce((sum, project) => sum + Math.max(1, project.threads.length), 0) +
    archivedLoose.reduce((sum, project) => sum + project.threads.length, 0);
  const showArchived = archiveOpen || Boolean(query.trim() && archivedCount);

  async function addProject() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string" || !dir) return;
    const cwd = normalizeCwd(dir);
    if (archivedProjectSet.has(cwd)) app.unarchiveProject(cwd);
    app.selectProject(cwd);
    setExpanded((prev) => new Set(prev).add(cwd));
    await app.newThread(cwd);
  }

  function onProjectClick(cwd: string) {
    const isOpen = expanded.has(cwd);
    app.selectProject(cwd);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen && sameProject(cwd, selected)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <div className="tree-head">
        <span className="kicker">Projects</span>
        <button className="tree-action" title="Open folder" onClick={() => void addProject()}>
          <IconPlus />
        </button>
      </div>
      <label className="tree-search">
        <IconSearch />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          spellCheck={false}
        />
      </label>
      <div className="project-tree">
        {live.map((project) => (
          <ProjectSection
            key={project.cwd}
            project={project}
            selected={selected}
            expanded={expanded.has(project.cwd) || Boolean(query.trim())}
            onProjectClick={onProjectClick}
          />
        ))}
        {archivedCount > 0 ? (
          <section className="tree-group archive-root">
            <div className="tree-row project">
              <button
                className="tree-hit"
                onClick={() => setArchiveOpen((open) => !open)}
                title="Show archived projects and threads"
              >
                <span className={`caret ${showArchived ? "open" : ""}`} aria-hidden />
                <span className="tree-label">Archived</span>
                <span className="tree-count">{archivedCount}</span>
              </button>
            </div>
            {showArchived ? (
              <div className="tree-children">
                {archivedFolders.map((project) => (
                  <ArchivedFolder key={`folder-${project.cwd}`} project={project} />
                ))}
                {archivedLoose.map((project) => (
                  <ArchivedLoose key={`loose-${project.cwd}`} project={project} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function ProjectSection({
  project,
  selected,
  expanded,
  onProjectClick,
}: {
  project: ProjectGroup;
  selected: string | null;
  expanded: boolean;
  onProjectClick: (cwd: string) => void;
}) {
  const app = useApp();
  const isSelected = sameProject(project.cwd, selected);
  const sessionIds = app.threads
    .filter((thread) => sameProject(thread.cwd, project.cwd))
    .map((thread) => thread.sessionId);
  const busy = workStatus(sessionIds, app.transcripts, app.sending, app.selectedSession);
  return (
    <section className={`tree-group ${isSelected ? "is-current" : ""}`}>
      <div className={`tree-row project ${isSelected ? "active" : ""}`}>
        <button className="tree-hit" title={project.cwd} onClick={() => onProjectClick(project.cwd)}>
          <span className={`caret ${expanded ? "open" : ""}`} aria-hidden />
          <IconFolder />
          <span className="tree-label">{project.name}</span>
          {busy ? <span className={`status ${busy}`} title={busy === "running" ? "Working" : "Needs input"} /> : null}
          <span className="tree-count">{project.threads.length}</span>
        </button>
        <button
          className="tree-action on-row"
          title="Archive folder"
          onClick={() => app.archiveProject(project.cwd)}
        >
          <IconArchive />
        </button>
        <button className="tree-action on-row" title="New thread" onClick={() => void app.newThread(project.cwd)}>
          <IconPlus />
        </button>
      </div>
      {expanded ? (
        <div className="tree-children">
          {project.threads.length === 0 ? (
            <div className="tree-empty">No chats yet</div>
          ) : (
            project.threads.map((thread) => (
              <ThreadRow key={thread.sessionId} thread={thread} />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function ThreadRow({ thread }: { thread: ThreadInfo }) {
  const app = useApp();
  const live = app.transcripts[thread.sessionId]?.status;
  const sending = app.sending && app.selectedSession === thread.sessionId;
  const status = sending ? "running" : (live ?? "idle");
  const on = app.selectedSession === thread.sessionId;
  return (
    <div className={`tree-row thread ${on ? "active" : ""}`}>
      <button className="tree-hit" onClick={() => void app.openThread(thread)} title={threadLabel(thread)}>
        <span className={`status ${status}`} />
        <span className="tree-label">{threadLabel(thread)}</span>
        <span className="tree-time">{relativeTime(thread.updatedAt)}</span>
      </button>
      <button
        className="tree-action on-row"
        title="Archive thread"
        onClick={() => app.archiveThread(thread.sessionId)}
      >
        <IconArchive />
      </button>
    </div>
  );
}

function ArchivedFolder({ project }: { project: ProjectGroup }) {
  const app = useApp();
  const [open, setOpen] = useState(true);
  const busy = workStatus(
    project.threads.map((thread) => thread.sessionId),
    app.transcripts,
    app.sending,
    app.selectedSession,
  );
  return (
    <section className="tree-group">
      <div className="tree-row project">
        <button className="tree-hit" title={project.cwd} onClick={() => setOpen((value) => !value)}>
          <span className={`caret ${open ? "open" : ""}`} aria-hidden />
          <IconFolder />
          <span className="tree-label">{project.name}</span>
          {busy ? <span className={`status ${busy}`} title="Working" /> : null}
          <span className="tree-count">{project.threads.length}</span>
        </button>
        <button
          className="tree-action on-row"
          title="Unarchive folder"
          onClick={() => app.unarchiveProject(project.cwd)}
        >
          <IconUnarchive />
        </button>
      </div>
      {open ? (
        <div className="tree-children">
          {project.threads.length === 0 ? (
            <div className="tree-empty">No chats</div>
          ) : (
            project.threads.map((thread) => (
              <ArchivedThreadRow key={thread.sessionId} thread={thread} />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function ArchivedLoose({ project }: { project: ProjectGroup }) {
  return (
    <section className="tree-group">
      <div className="tree-kicker">{project.name}</div>
      {project.threads.map((thread) => (
        <ArchivedThreadRow key={thread.sessionId} thread={thread} />
      ))}
    </section>
  );
}

function ArchivedThreadRow({ thread }: { thread: ThreadInfo }) {
  const app = useApp();
  const title = threadLabel(thread);
  return (
    <div className="tree-row thread">
      <button className="tree-hit" onClick={() => void app.openThread(thread)} title={title}>
        <span className="status idle" />
        <span className="tree-label">{title}</span>
        <span className="tree-time">{relativeTime(thread.updatedAt)}</span>
      </button>
      <button
        className="tree-action on-row"
        title="Unarchive thread"
        onClick={() => app.unarchiveThread(thread.sessionId)}
      >
        <IconUnarchive />
      </button>
      <button
        className="tree-action on-row danger"
        title="Delete thread"
        onClick={() => {
          if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
          void app.deleteThread(thread.sessionId);
        }}
      >
        <IconTrash />
      </button>
    </div>
  );
}
