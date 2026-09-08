import { memo, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isSafeSessionId,
  isTranscriptLive,
  normalizeCwd,
  parseSessionId,
  projectName,
  relativeTime,
  sameProject,
  workStatus,
} from "../lib/format";
import { useApp } from "../lib/store";
import type { ThreadInfo } from "../lib/types";
import { IconArchive, IconFolder, IconPlus, IconSearch, IconTerminal, IconTrash, IconUnarchive } from "./icons";

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
  if (thread.sessionId.toLowerCase().includes(query)) return true;
  return threadLabel(thread).toLowerCase().includes(query);
}

export const Sidebar = memo(function Sidebar() {
  const projects = useApp((s) => s.projects);
  const threads = useApp((s) => s.threads);
  const archivedThreads = useApp((s) => s.archivedThreads);
  const archivedProjects = useApp((s) => s.archivedProjects);
  const selectedCwd = useApp((s) => s.selectedCwd);
  const selectProject = useApp((s) => s.selectProject);
  const unarchiveProject = useApp((s) => s.unarchiveProject);
  const newThread = useApp((s) => s.newThread);
  const selected = selectedCwd ? normalizeCwd(selectedCwd) : null;
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

  const archivedThreadSet = useMemo(() => new Set(archivedThreads), [archivedThreads]);
  const archivedProjectSet = useMemo(
    () => new Set(archivedProjects.map(normalizeCwd)),
    [archivedProjects],
  );

  const { live, archivedFolders, archivedLoose } = useMemo(() => {
    const map = new Map<string, ProjectGroup>();
    for (const project of projects) {
      const key = normalizeCwd(project.cwd);
      map.set(key, { cwd: key, name: project.name, threads: [] });
    }
    if (selected && !map.has(selected)) {
      map.set(selected, { cwd: selected, name: projectName(selected), threads: [] });
    }
    for (const thread of threads) {
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
        const matched = project.threads.filter((thread) => matchesQuery(q, project, thread));
        if (!q || matchesQuery(q, project) || matched.length > 0) {
          archivedFolders.push({ ...project, threads: q ? matched : project.threads });
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
  }, [projects, threads, archivedProjectSet, archivedThreadSet, query, selected]);

  const archivedCount =
    archivedFolders.reduce((sum, project) => sum + Math.max(1, project.threads.length), 0) +
    archivedLoose.reduce((sum, project) => sum + project.threads.length, 0);
  const showArchived = archiveOpen || Boolean(query.trim() && archivedCount);

  async function addProject() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string" || !dir) return;
    const cwd = normalizeCwd(dir);
    if (archivedProjectSet.has(cwd)) unarchiveProject(cwd);
    selectProject(cwd);
    setExpanded((prev) => new Set(prev).add(cwd));
    await newThread(cwd);
  }

  function onProjectClick(cwd: string) {
    const isOpen = expanded.has(cwd);
    selectProject(cwd);
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
      <SessionIdForm />
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
});

function SessionIdForm() {
  const openBySessionId = useApp((s) => s.openBySessionId);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"view" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(readOnly: boolean) {
    const id = parseSessionId(value);
    if (!id) {
      setError("Paste a session id");
      return;
    }
    if (!isSafeSessionId(id)) {
      setError("That is not a valid session id");
      return;
    }
    setBusy(readOnly ? "view" : "open");
    setError(null);
    try {
      await openBySessionId(id, readOnly);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="session-id-form"
      onSubmit={(event) => {
        event.preventDefault();
        void go(true);
      }}
    >
      <label className="tree-search session-id-field">
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder="Session ID"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Session ID"
        />
      </label>
      <div className="session-id-actions">
        <button
          type="submit"
          className="ghost session-id-btn"
          disabled={Boolean(busy)}
          title="Hydrate from disk without attaching"
        >
          {busy === "view" ? "Opening…" : "Read-only"}
        </button>
        <button
          type="button"
          className="ghost session-id-btn"
          disabled={Boolean(busy)}
          title="Resume and attach"
          onClick={() => void go(false)}
        >
          {busy === "open" ? "Opening…" : "Open"}
        </button>
      </div>
      {error ? <p className="session-id-error">{error}</p> : null}
    </form>
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
  const archiveProject = useApp((s) => s.archiveProject);
  const newThread = useApp((s) => s.newThread);
  const isSelected = sameProject(project.cwd, selected);
  const sessionIds = project.threads.map((thread) => thread.sessionId);
  const busy = useApp((s) => workStatus(sessionIds, s.transcripts, s.sending, s.selectedSession));
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
          onClick={() => archiveProject(project.cwd)}
        >
          <IconArchive />
        </button>
        <button className="tree-action on-row" title="New thread" onClick={() => void newThread(project.cwd)}>
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

const ThreadRow = memo(function ThreadRow({ thread }: { thread: ThreadInfo }) {
  const openThread = useApp((s) => s.openThread);
  const openInTerminal = useApp((s) => s.openInTerminal);
  const archiveThread = useApp((s) => s.archiveThread);
  const on = useApp((s) => s.selectedSession === thread.sessionId);
  const viewing = useApp((s) => s.readOnlyIds.includes(thread.sessionId));
  const status = useApp((s) => {
    const live = s.threads.find((item) => item.sessionId === thread.sessionId);
    if (live?.headless) {
      if (live.watchStatus === "running") return "running";
      if (live.watchStatus === "error") return "error";
      return "idle";
    }
    const transcript = s.transcripts[thread.sessionId];
    if (transcript?.status === "needs-input") return "needs-input";
    if (isTranscriptLive(transcript, s.sending, s.selectedSession === thread.sessionId)) {
      return "running";
    }
    return transcript?.status ?? "idle";
  });
  return (
    <div className={`tree-row thread ${on ? "active" : ""}`}>
      <button className="tree-hit" onClick={() => void openThread(thread)} title={threadLabel(thread)}>
        <span className={`status ${status}`} />
        <span className="tree-label">{threadLabel(thread)}</span>
        {thread.headless ? (
          <span className="tree-tag" title="grok -p headless — watch only">
            -p
          </span>
        ) : viewing ? (
          <span className="tree-tag" title="Opened read-only">
            view
          </span>
        ) : null}
        <span className="tree-time">{relativeTime(thread.updatedAt)}</span>
      </button>
      <button
        className="tree-action on-row"
        title="Open in Terminal"
        onClick={(event) => {
          event.stopPropagation();
          void openInTerminal(thread);
        }}
      >
        <IconTerminal />
      </button>
      <button
        className="tree-action on-row"
        title="Archive thread"
        onClick={() => archiveThread(thread.sessionId)}
      >
        <IconArchive />
      </button>
    </div>
  );
});

function ArchivedFolder({ project }: { project: ProjectGroup }) {
  const unarchiveProject = useApp((s) => s.unarchiveProject);
  const [open, setOpen] = useState(true);
  const sessionIds = project.threads.map((thread) => thread.sessionId);
  const busy = useApp((s) => workStatus(sessionIds, s.transcripts, s.sending, s.selectedSession));
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
          onClick={() => unarchiveProject(project.cwd)}
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
  const openThread = useApp((s) => s.openThread);
  const openInTerminal = useApp((s) => s.openInTerminal);
  const unarchiveThread = useApp((s) => s.unarchiveThread);
  const deleteThread = useApp((s) => s.deleteThread);
  const title = threadLabel(thread);
  return (
    <div className="tree-row thread">
      <button className="tree-hit" onClick={() => void openThread(thread)} title={title}>
        <span className={`status ${thread.watchStatus === "running" ? "running" : "idle"}`} />
        <span className="tree-label">{title}</span>
        {thread.headless ? <span className="tree-tag">-p</span> : null}
        <span className="tree-time">{relativeTime(thread.updatedAt)}</span>
      </button>
      <button
        className="tree-action on-row"
        title="Open in Terminal"
        onClick={(event) => {
          event.stopPropagation();
          void openInTerminal(thread);
        }}
      >
        <IconTerminal />
      </button>
      <button
        className="tree-action on-row"
        title="Unarchive thread"
        onClick={() => unarchiveThread(thread.sessionId)}
      >
        <IconUnarchive />
      </button>
      <button
        className="tree-action on-row danger"
        title="Delete thread"
        onClick={() => {
          if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
          void deleteThread(thread.sessionId);
        }}
      >
        <IconTrash />
      </button>
    </div>
  );
}
