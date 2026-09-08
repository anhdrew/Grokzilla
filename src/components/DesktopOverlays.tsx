import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { MODES, useApp } from "../lib/store";
import { normalizeCwd, projectName } from "../lib/format";
import { desktop, useWorkspace, type GitInfo, type Settings } from "../lib/workspace";

export function DesktopOverlays() {
  const paletteOpen = useWorkspace((s) => s.paletteOpen);
  const settingsOpen = useWorkspace((s) => s.settingsOpen);
  const newTaskOpen = useWorkspace((s) => s.newTaskOpen);
  return (
    <>
      {paletteOpen ? <CommandPalette /> : null}
      {settingsOpen ? <SettingsDialog /> : null}
      {newTaskOpen ? <NewTaskDialog /> : null}
    </>
  );
}

function CommandPalette() {
  const [query, setQuery] = useState("");
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const actions = [
      { id: "new-task", label: "New task", run: () => useWorkspace.getState().openNewTask() },
      { id: "open-project", label: "Open project…", run: () => void pickProject() },
      { id: "files", label: "Show files", run: () => useWorkspace.getState().toggleRight("files") },
      { id: "changes", label: "Show changes", run: () => useWorkspace.getState().toggleRight("changes") },
      { id: "terminal", label: "Toggle terminal", run: () => useWorkspace.getState().toggleTerminal() },
      { id: "settings", label: "Settings", run: () => useWorkspace.setState({ settingsOpen: true, paletteOpen: false }) },
    ];
    const projectItems = projects.map((project) => ({
      id: `project-${project.cwd}`,
      label: `Project · ${project.name}`,
      run: () => useApp.getState().selectProject(project.cwd),
    }));
    const threadItems = threads.map((thread) => ({
      id: `thread-${thread.sessionId}`,
      label: `Task · ${thread.title || "Untitled"}`,
      run: () => void useApp.getState().openThread(thread),
    }));
    return [...actions, ...projectItems, ...threadItems].filter((item) => !q || item.label.toLowerCase().includes(q));
  }, [projects, query, threads]);
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [query]);

  function run(index = active) {
    const item = items[index];
    if (!item) return;
    useWorkspace.setState({ paletteOpen: false });
    item.run();
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => useWorkspace.setState({ paletteOpen: false })}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder="Search commands, projects, and tasks"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(items.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run();
            }
          }}
        />
        <div className="palette-list">
          {items.length === 0 ? <p className="panel-status">No matches</p> : null}
          {items.map((item, index) => (
            <button
              key={item.id}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

async function pickProject() {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string" || !dir) return;
  useApp.getState().selectProject(normalizeCwd(dir));
  useWorkspace.getState().openNewTask(normalizeCwd(dir));
}

function SettingsDialog() {
  const settings = useWorkspace((s) => s.data.settings);
  const error = useWorkspace((s) => s.error);
  const models = useApp((s) => s.models);

  function patch(next: Partial<Settings>) {
    useWorkspace.getState().settings(next);
    if (next.theme) useApp.getState().setTheme(next.theme);
    if (next.grokPath != null) void desktop.configure(next.grokPath);
    if (next.notifications) void Notification.requestPermission();
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => useWorkspace.setState({ settingsOpen: false })}>
      <div className="dialog settings-dialog" role="dialog" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          Appearance
          <select value={settings.theme} onChange={(event) => patch({ theme: event.target.value as Settings["theme"] })}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          Grok CLI path
          <input
            value={settings.grokPath}
            placeholder="Leave empty to auto-detect"
            onChange={(event) => patch({ grokPath: event.target.value })}
          />
        </label>
        <label>
          Default model
          <select value={settings.defaultModel} onChange={(event) => patch({ defaultModel: event.target.value })}>
            <option value="">Last used / Grok default</option>
            {models.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.name || model.modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default mode
          <select value={settings.defaultMode} onChange={(event) => patch({ defaultMode: event.target.value })}>
            {MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Concurrent tasks
          <input
            type="number"
            min={1}
            max={8}
            value={settings.concurrency}
            onChange={(event) => patch({ concurrency: Number(event.target.value) })}
          />
        </label>
        <label>
          Shell
          <input value={settings.shell} onChange={(event) => patch({ shell: event.target.value })} />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(event) => patch({ notifications: event.target.checked })}
          />
          Desktop notifications
        </label>
        {error ? <p className="inline-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="primary" onClick={() => useWorkspace.setState({ settingsOpen: false })}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function NewTaskDialog() {
  const selected = useWorkspace((s) => s.newTaskCwd || s.data.selectedCwd);
  const projects = useApp((s) => s.projects);
  const [cwd, setCwd] = useState(selected ?? "");
  const [environment, setEnvironment] = useState<"worktree" | "local">("worktree");
  const [base, setBase] = useState("HEAD");
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setInfo(null);
      return;
    }
    let alive = true;
    desktop
      .gitInfo(cwd)
      .then((value) => {
        if (alive) setInfo(value);
      })
      .catch(() => {
        if (alive) {
          setInfo(null);
          setEnvironment("local");
        }
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  async function create() {
    if (!cwd) {
      setError("Choose a project folder");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await useApp.getState().newThread(cwd, { environment, base });
      useWorkspace.setState({ newTaskOpen: false, newTaskCwd: null });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => useWorkspace.setState({ newTaskOpen: false, newTaskCwd: null })}>
      <div className="dialog" role="dialog" aria-label="New task" onMouseDown={(event) => event.stopPropagation()}>
        <h2>New task</h2>
        <label>
          Project
          <select value={cwd} onChange={(event) => setCwd(event.target.value)}>
            <option value="">Select a folder</option>
            {projects.map((project) => (
              <option key={project.cwd} value={project.cwd}>
                {project.name}
              </option>
            ))}
            {cwd && !projects.some((project) => project.cwd === cwd) ? (
              <option value={cwd}>{projectName(cwd)}</option>
            ) : null}
          </select>
        </label>
        <div className="dialog-actions">
          <button onClick={() => void pickProject()}>Open folder…</button>
        </div>
        <label>
          Environment
          <select
            value={info ? environment : "local"}
            disabled={!info}
            onChange={(event) => setEnvironment(event.target.value as "worktree" | "local")}
          >
            <option value="worktree">Worktree from a committed revision</option>
            <option value="local">Local working tree</option>
          </select>
        </label>
        {environment === "worktree" && info ? (
          <label>
            Base
            <select value={base} onChange={(event) => setBase(event.target.value)}>
              <option value="HEAD">HEAD</option>
              {info.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {info?.dirty && environment === "worktree" ? (
          <p className="inline-notice">Uncommitted local changes are not copied into a new worktree.</p>
        ) : null}
        {!info && cwd ? <p className="muted">This folder is not a Git repository, so the task will use the local files.</p> : null}
        {error ? <p className="inline-error">{error}</p> : null}
        <div className="dialog-actions">
          <button onClick={() => useWorkspace.setState({ newTaskOpen: false, newTaskCwd: null })}>Cancel</button>
          <button className="primary" disabled={busy || !cwd} onClick={() => void create()}>
            {busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

