import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Composer } from "./components/Composer";
import { DesktopOverlays } from "./components/DesktopOverlays";
import { PlanChip, PlanPanel } from "./components/PlanPanel";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TranscriptView } from "./components/Transcript";
import { getExplorerDrag, hasExplorerDrag } from "./lib/explorer-drag";
import { compactNumber, isReadOnlySession, projectName, previewJson } from "./lib/format";
import { isPlanPermission } from "./lib/plan";
import { EMPTY_QUEUE } from "./lib/runtime";
import { useApp } from "./lib/store";
import { listenTerminalEvents } from "./lib/terminal";
import { estimateEmptyAt, formatLocalStamp } from "./lib/usage";
import { useWorkspace } from "./lib/workspace";
import type { AcpEvent } from "./lib/types";
import "./styles.css";

export default function App() {
  const status = useApp((s) => s.status);
  const theme = useApp((s) => s.theme);
  const bootError = useApp((s) => s.bootError);
  const bootstrap = useApp((s) => s.bootstrap);
  const login = useApp((s) => s.login);
  const layout = useWorkspace((s) => s.data.layout);

  useEffect(() => {
    document.documentElement.dataset.theme = useApp.getState().theme;
    void useApp.getState().bootstrap();
    void listenTerminalEvents();
    let unlisten: (() => void) | undefined;
    void listen<AcpEvent>("acp-event", (event) => {
      useApp.getState().handleEvent(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const pref = useWorkspace.getState().data.settings.theme;
      if (pref === "system") useApp.getState().setTheme("system");
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onNotify = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; title: string; body: string }>).detail;
      if (!detail || !useWorkspace.getState().data.settings.notifications) return;
      if (document.hasFocus() && !document.hidden) return;
      if (Notification.permission !== "granted") return;
      const note = new Notification(detail.title, { body: detail.body });
      note.onclick = () => {
        const thread = useApp.getState().threads.find((item) => item.sessionId === detail.id);
        if (thread) void useApp.getState().openThread(thread);
      };
    };
    window.addEventListener("task-notification", onNotify);
    return () => window.removeEventListener("task-notification", onNotify);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        useWorkspace.setState((state) => ({ paletteOpen: !state.paletteOpen }));
        return;
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        useWorkspace.getState().openNewTask();
        return;
      }
      if (meta && event.key.toLowerCase() === "j") {
        event.preventDefault();
        useWorkspace.getState().toggleRight();
        return;
      }
      if (meta && event.key === "`") {
        event.preventDefault();
        useWorkspace.getState().toggleTerminal();
        return;
      }
      if (event.key === "Escape") {
        if (useWorkspace.getState().closeOverlays()) {
          event.preventDefault();
          return;
        }
        const state = useApp.getState();
        if (state.planPanelOpen || state.planReviewOpen) {
          event.preventDefault();
          state.closePlanPanel();
          return;
        }
        void state.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!status) {
    return (
      <div className="onboarding" data-theme={theme}>
        <div className="window-drag" data-tauri-drag-region="deep" onMouseDown={onWindowDrag} />
        <div className="card">
          <span className="logo">G</span>
          <h2>Starting Grokzilla…</h2>
          <p>Looking for the Grok Build CLI.</p>
        </div>
      </div>
    );
  }
  if (!status.grokPath) {
    return (
      <div className="onboarding" data-theme={theme}>
        <div className="window-drag" data-tauri-drag-region="deep" onMouseDown={onWindowDrag} />
        <div className="card">
          <span className="logo">G</span>
          <h2>Install Grok Build</h2>
          <p>Grokzilla is a desktop client for the Grok Build CLI. It does not bundle the agent.</p>
          <pre className="code">curl -fsSL https://x.ai/cli/install.sh | bash</pre>
          <p>Then click retry.</p>
          <button className="primary" onClick={() => void bootstrap()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status.loggedIn) {
    return (
      <div className="onboarding" data-theme={theme}>
        <div className="window-drag" data-tauri-drag-region="deep" onMouseDown={onWindowDrag} />
        <div className="card">
          <span className="logo">G</span>
          <h2>Sign in to Grok</h2>
          <p>
            Found {status.version ?? "Grok Build"} at {status.grokPath}. Sign in with the same
            account the TUI uses.
          </p>
          <button className="primary" onClick={() => void login()}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-theme={theme}>
      <Titlebar />
      {bootError ? <div className="banner">{bootError}</div> : null}
      <div className="desktop">
        <div
          className={`workspace ${layout.rightOpen ? "" : "no-explorer"}`}
          style={{
            ["--sidebar" as string]: `${layout.sidebar}px`,
            ["--right" as string]: `${layout.right}px`,
          }}
        >
          <Sidebar />
          <Splitter
            value={layout.sidebar}
            min={200}
            max={420}
            onChange={(sidebar) =>
              useWorkspace.getState().update({ layout: { ...useWorkspace.getState().data.layout, sidebar } })
            }
          />
          <ChatPane />
          {layout.rightOpen ? (
            <>
              <Splitter
                invert
                value={layout.right}
                min={280}
                max={720}
                onChange={(right) =>
                  useWorkspace.getState().update({ layout: { ...useWorkspace.getState().data.layout, right } })
                }
              />
              <RightPanel />
            </>
          ) : null}
        </div>
        {layout.terminalOpen ? (
          <Splitter
            axis="y"
            invert
            value={layout.terminal}
            min={140}
            max={520}
            onChange={(terminal) =>
              useWorkspace.getState().update({ layout: { ...useWorkspace.getState().data.layout, terminal } })
            }
          />
        ) : null}
        <div
          className="terminal-wrap"
          hidden={!layout.terminalOpen}
          style={{ ["--terminal" as string]: `${layout.terminal}px` }}
        >
          <TerminalPanel />
        </div>
      </div>
      <DesktopOverlays />
    </div>
  );
}

function Splitter({
  value,
  onChange,
  min,
  max,
  invert = false,
  axis = "x",
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  invert?: boolean;
  axis?: "x" | "y";
}) {
  return (
    <div
      className={`splitter ${axis === "y" ? "row" : ""}`}
      role="separator"
      aria-orientation={axis === "y" ? "horizontal" : "vertical"}
      onMouseDown={(event) => {
        event.preventDefault();
        const origin = value;
        const start = axis === "x" ? event.clientX : event.clientY;
        const move = (next: globalThis.MouseEvent) => {
          const delta = (axis === "x" ? next.clientX : next.clientY) - start;
          onChange(Math.min(max, Math.max(min, origin + (invert ? -delta : delta))));
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}

function isNoDragTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-tauri-drag-region='false']"));
}

function onWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || isNoDragTarget(event.target)) return;
  const appWindow = getCurrentWindow();
  if (event.detail === 2) {
    void appWindow.toggleMaximize();
    return;
  }
  void appWindow.startDragging();
}

function UsagePill() {
  const usage = useApp((s) => s.usage);
  const loadUsage = useApp((s) => s.loadUsage);
  const connected = useApp((s) => s.connected);

  useEffect(() => {
    if (!connected) return;
    void loadUsage();
    const handle = window.setInterval(() => void loadUsage(), 120_000);
    return () => window.clearInterval(handle);
  }, [connected, loadUsage]);

  if (!usage || usage.percent == null) return null;
  const pct = Math.round(usage.percent);
  const heat = pct >= 95 ? "full" : pct >= 80 ? "hot" : "";
  const resetStamp = formatLocalStamp(usage.resetsAt);
  const emptyAt = estimateEmptyAt(usage);
  const emptyStamp = emptyAt ? formatLocalStamp(new Date(emptyAt).toISOString()) : "";
  const title = [
    usage.tier,
    `${pct}% used`,
    resetStamp ? `resets ${resetStamp}` : null,
    emptyStamp ? `at this pace, out of usage ~${emptyStamp}` : "at this pace, lasts until reset",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`pill usage-pct ${heat}`} title={title} data-tauri-drag-region="false">
      <span className={`usage-bar ${heat}`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <b>{pct}%</b>
    </span>
  );
}

function Titlebar() {
  const version = useApp((s) => s.status?.version);
  const starting = useApp((s) => s.starting);
  const working = useApp((s) => {
    if (s.sending) return true;
    const thread = s.threads.find((item) => item.sessionId === s.selectedSession);
    if (!thread) return false;
    if (!isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds)) return false;
    return thread.watchStatus === "running";
  });
  const mcpNote = useApp((s) => s.mcpNote);
  const theme = useApp((s) => s.theme);
  const layout = useWorkspace((s) => s.data.layout);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <div className="titlebar" data-tauri-drag-region="deep" onMouseDown={onWindowDrag}>
      <div className="titlebar-left" data-tauri-drag-region="deep">
        <span className="logo" data-tauri-drag-region="deep">
          G
        </span>
        <span className="brand" data-tauri-drag-region="deep">
          Grokzilla
        </span>
        <span className="pill" data-tauri-drag-region="deep">
          {version ?? "Grok Build"}
        </span>
        <UsagePill />
        {starting ? (
          <span className="pill" data-tauri-drag-region="deep">
            connecting…
          </span>
        ) : null}
        {working ? (
          <span className="pill working" data-tauri-drag-region="deep">
            <span className="act-dot running" />
            working
          </span>
        ) : null}
        {mcpNote ? (
          <span className="pill" data-tauri-drag-region="deep">
            {mcpNote}
          </span>
        ) : null}
      </div>
      <div className="titlebar-right">
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title="Command palette"
          onClick={() => useWorkspace.setState({ paletteOpen: true })}
        >
          ⌘K
        </button>
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title={theme === "light" ? "Switch to dark" : "Switch to light"}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title="Toggle files and review"
          onClick={() => useWorkspace.getState().toggleRight()}
        >
          {layout.rightOpen ? "▥" : "▤"}
        </button>
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title="Toggle terminal"
          onClick={() => useWorkspace.getState().toggleTerminal()}
        >
          ≥_
        </button>
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title="Settings"
          onClick={() => useWorkspace.setState({ settingsOpen: true })}
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

function ChatPane() {
  const selectedCwd = useApp((s) => s.selectedCwd);
  const selectedSession = useApp((s) => s.selectedSession);
  const blocks = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.transcripts[id]?.blocks : undefined;
  });
  const sending = useApp((s) => s.sending);
  const isHeadless = useApp((s) =>
    Boolean(s.threads.find((item) => item.sessionId === s.selectedSession)?.headless),
  );
  const readOnly = useApp((s) => isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds));
  const watchStatus = useApp((s) => {
    if (!isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds)) return undefined;
    return s.threads.find((item) => item.sessionId === s.selectedSession)?.watchStatus;
  });
  const refreshHeadlessWatch = useApp((s) => s.refreshHeadlessWatch);
  const permission = useApp((s) => s.permission);
  const answerPermission = useApp((s) => s.answerPermission);
  const taskError = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.tasks[id]?.error : undefined;
  });
  const title = useApp((s) => {
    const thread = s.threads.find((t) => t.sessionId === s.selectedSession);
    return thread?.title || "Thread";
  });
  const queue = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.tasks[id]?.queue ?? EMPTY_QUEUE : EMPTY_QUEUE;
  });
  const [stuck, setStuck] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restoring = useRef(false);
  const userIntent = useRef(false);

  function pinBottom() {
    const el = scroller.current;
    if (!el || !stick.current) return;
    restoring.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const node = scroller.current;
      if (node && stick.current) node.scrollTop = node.scrollHeight;
      restoring.current = false;
    });
  }

  useLayoutEffect(() => {
    stick.current = true;
    pinBottom();
  }, [selectedSession]);

  useLayoutEffect(() => {
    pinBottom();
  }, [blocks, sending, watchStatus]);

  useEffect(() => {
    if (!readOnly) return;
    void refreshHeadlessWatch();
    const ms = watchStatus === "running" ? 1500 : 10_000;
    const handle = window.setInterval(() => void refreshHeadlessWatch(), ms);
    return () => window.clearInterval(handle);
  }, [readOnly, selectedSession, watchStatus, refreshHeadlessWatch]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const markUser = () => {
      userIntent.current = true;
    };
    const onScroll = () => {
      if (restoring.current) return;
      if (!userIntent.current) return;
      userIntent.current = false;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      setStuck(stick.current);
    };
    el.addEventListener("wheel", markUser, { passive: true });
    el.addEventListener("touchmove", markUser, { passive: true });
    el.addEventListener("pointerdown", markUser);
    el.addEventListener("scroll", onScroll, { passive: true });
    const stack = el.firstElementChild;
    const ro = new ResizeObserver(() => pinBottom());
    if (stack) ro.observe(stack);
    pinBottom();
    return () => {
      el.removeEventListener("wheel", markUser);
      el.removeEventListener("touchmove", markUser);
      el.removeEventListener("pointerdown", markUser);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [selectedCwd, selectedSession]);

  function onChatDragOver(event: DragEvent) {
    if (hasExplorerDrag(event.dataTransfer) || event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
    }
  }

  function onChatDrop(event: DragEvent) {
    const entry = getExplorerDrag(event.dataTransfer);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    useApp.getState().attachEntry({
      path: entry.path,
      rel: entry.rel,
      kind: entry.kind === "folder" ? "folder" : "file",
    });
  }

  if (!selectedCwd) {
    return (
      <main className="chat">
        <div className="empty">
          <div className="empty-card">
            <h2>Open a project</h2>
            <p>
              Pick a folder on the left. Grokzilla uses the same sessions as Grok Build in the
              terminal.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat" onDragOver={onChatDragOver} onDrop={onChatDrop}>
      <div className="chat-head">
        <div className="chat-head-main">
          <h1>{blocks?.length ? title : projectName(selectedCwd)}</h1>
          <div className="chat-head-meta">
            {selectedSession ? (
              <button
                type="button"
                className="pill session-id-pill"
                title={`${selectedSession} — click to copy`}
                onClick={() => void navigator.clipboard.writeText(selectedSession)}
              >
                {selectedSession.slice(0, 8)}
              </button>
            ) : null}
            <PlanChip />
            <ThreadStatsBar />
          </div>
        </div>
      </div>
      <div className="transcript" ref={scroller}>
        <div className={`stack ${blocks?.length ? "has-turns" : ""}`}>
          {!blocks?.length ? (
            <div className="empty">
              <div className="empty-card">
                <h2>
                  {isHeadless
                    ? "Watching grok -p"
                    : readOnly
                      ? "Read-only session"
                      : "What should we work on?"}
                </h2>
                <p>
                  {isHeadless
                    ? "Status and results show up as the headless run writes them. Grokzilla will not attach to this session."
                    : readOnly
                      ? "This transcript is loaded from disk. Grokzilla will not attach, so a live TUI or grok -p run stays untouched."
                      : "Ask Grok to explore the repo, fix a bug, or plan a change. Approvals stay in Ask mode unless you switch."}
                </p>
              </div>
            </div>
          ) : (
            <TranscriptView blocks={blocks} />
          )}
          <WorkingLine />
        </div>
      </div>
      {!stuck ? (
        <button
          className="jump-bottom"
          onClick={() => {
            stick.current = true;
            setStuck(true);
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      ) : null}
      <div className="composer-wrap">
        {taskError ? <div className="banner">{taskError}</div> : null}
        {queue.length > 0 ? (
          <div className="queue-banner">
            {queue.length} prompt{queue.length === 1 ? "" : "s"} waiting
            <button className="ghost" onClick={() => selectedSession && useApp.getState().clearQueue(selectedSession)}>
              Clear queue
            </button>
          </div>
        ) : null}
        {permission && !readOnly && !isPlanPermission(permission) ? (
          <div className="permission">
            <h3>{permission.title || "Permission required"}</h3>
            <p>{previewJson(permission.toolCall ?? permission.raw, 400)}</p>
            <div className="perm-actions">
              {permission.options.map((option) => (
                <button
                  key={option.optionId}
                  className={option.kind?.includes("reject") ? "danger" : "primary"}
                  onClick={() => void answerPermission(option.optionId)}
                >
                  {option.name}
                </button>
              ))}
              <button className="ghost" onClick={() => void answerPermission(undefined, true)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <Composer />
      </div>
      <PlanPanel />
    </main>
  );
}

function WorkingLine() {
  const working = useApp((s) => {
    if (s.sending) return true;
    const thread = s.threads.find((item) => item.sessionId === s.selectedSession);
    if (!thread) return false;
    if (!isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds)) return false;
    return thread.watchStatus === "running";
  });
  if (!working) return null;
  return (
    <div className="working-line" aria-live="polite">
      <span className="act-dot running" />
      Working
    </div>
  );
}

function ThreadStatsBar() {
  const stats = useApp((s) => s.threadStats);
  const loadThreadStats = useApp((s) => s.loadThreadStats);
  const sessionId = useApp((s) => s.selectedSession);
  const sending = useApp((s) => s.sending);

  useEffect(() => {
    void loadThreadStats();
  }, [sessionId, sending, loadThreadStats]);

  useEffect(() => {
    if (!sessionId) return;
    const handle = window.setInterval(() => void loadThreadStats(), sending ? 4000 : 60_000);
    return () => window.clearInterval(handle);
  }, [sessionId, sending, loadThreadStats]);

  if (!sessionId || !stats) return null;
  const pct =
    stats.contextPercent ??
    (stats.contextTokens && stats.contextWindow
      ? Math.round((stats.contextTokens / stats.contextWindow) * 100)
      : null);
  if (pct == null && stats.turnCount == null && stats.toolCalls == null && stats.userMessages == null) {
    return null;
  }
  const heat = pct != null && pct >= 90 ? "full" : pct != null && pct >= 75 ? "hot" : "";
  const used = compactNumber(stats.contextTokens);
  const windowSize = compactNumber(stats.contextWindow);
  const title = [
    pct != null ? `Context ${pct}%` : null,
    used && windowSize ? `${used} / ${windowSize} tokens` : null,
    stats.turnCount != null ? `${stats.turnCount} turns` : null,
    stats.toolCalls != null ? `${stats.toolCalls} tools` : null,
    stats.userMessages != null ? `${stats.userMessages} user msgs` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="thread-stats" title={title}>
      {pct != null ? (
        <span className="thread-stat">
          <span className={`usage-bar ${heat}`}>
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
          <b>{pct}%</b>
          <span>ctx</span>
          {used && windowSize ? (
            <span className="thread-stat-dim">
              {used}/{windowSize}
            </span>
          ) : null}
        </span>
      ) : null}
      {stats.turnCount != null ? (
        <span className="thread-stat thread-stat-extra">{stats.turnCount} turns</span>
      ) : null}
      {stats.toolCalls != null ? (
        <span className="thread-stat thread-stat-extra">{stats.toolCalls} tools</span>
      ) : null}
      {stats.userMessages != null ? (
        <span className="thread-stat thread-stat-extra">{stats.userMessages} user msgs</span>
      ) : null}
    </div>
  );
}
