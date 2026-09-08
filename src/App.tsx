import { useEffect, useRef, type DragEvent, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Composer } from "./components/Composer";
import { Explorer } from "./components/Explorer";
import { Sidebar } from "./components/Sidebar";
import { TranscriptView } from "./components/Transcript";
import { getExplorerDrag, hasExplorerDrag } from "./lib/explorer-drag";
import { compactNumber, projectName, previewJson } from "./lib/format";
import { useApp } from "./lib/store";
import { estimateEmptyAt, formatLocalStamp } from "./lib/usage";
import type { AcpEvent } from "./lib/types";
import "./styles.css";

export default function App() {
  const app = useApp();

  useEffect(() => {
    document.documentElement.dataset.theme = useApp.getState().theme;
    void app.bootstrap();
    let unlisten: (() => void) | undefined;
    void listen<AcpEvent>("acp-event", (event) => {
      useApp.getState().handleEvent(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
    // bootstrap once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void useApp.getState().newThread();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        const state = useApp.getState();
        state.setExplorerOpen(!state.explorerOpen);
      }
      if (event.key === "Escape") {
        void useApp.getState().stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const status = app.status;
  if (!status) {
    return (
      <div className="onboarding" data-theme={app.theme}>
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
      <div className="onboarding" data-theme={app.theme}>
        <div className="window-drag" data-tauri-drag-region="deep" onMouseDown={onWindowDrag} />
        <div className="card">
          <span className="logo">G</span>
          <h2>Install Grok Build</h2>
          <p>Grokzilla is a desktop client for the Grok Build CLI. It does not bundle the agent.</p>
          <pre className="code">curl -fsSL https://x.ai/cli/install.sh | bash</pre>
          <p>Then click retry.</p>
          <button className="primary" onClick={() => void app.bootstrap()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status.loggedIn) {
    return (
      <div className="onboarding" data-theme={app.theme}>
        <div className="window-drag" data-tauri-drag-region="deep" onMouseDown={onWindowDrag} />
        <div className="card">
          <span className="logo">G</span>
          <h2>Sign in to Grok</h2>
          <p>
            Found {status.version ?? "Grok Build"} at {status.grokPath}. Sign in with the same
            account the TUI uses.
          </p>
          <button className="primary" onClick={() => void app.login()}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-theme={app.theme}>
      <Titlebar />
      {app.bootError ? <div className="banner">{app.bootError}</div> : null}
      <div className={`workspace ${app.explorerOpen ? "" : "no-explorer"}`}>
        <Sidebar />
        <ChatPane />
        {app.explorerOpen ? <Explorer /> : null}
      </div>
    </div>
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
    <>
      <span className={`pill usage-pct ${heat}`} title={title} data-tauri-drag-region="false">
        <span className={`usage-bar ${heat}`}>
          <span style={{ width: `${pct}%` }} />
        </span>
        <b>{pct}%</b>
      </span>
      {resetStamp ? (
        <span
          className="pill"
          title={
            usage.tier
              ? `${usage.tier} · Build quota resets ${resetStamp}`
              : `Build quota resets ${resetStamp}`
          }
          data-tauri-drag-region="false"
        >
          next reset {resetStamp}
        </span>
      ) : null}
      {emptyStamp ? (
        <span className="pill usage-predict" title={`at this pace, out of usage ~${emptyStamp}`} data-tauri-drag-region="false">
          out of usage ~{emptyStamp}
        </span>
      ) : null}
    </>
  );
}

function Titlebar() {
  const app = useApp();
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
          {app.status?.version ?? "Grok Build"}
        </span>
        <UsagePill />
        {app.starting ? (
          <span className="pill" data-tauri-drag-region="deep">
            connecting…
          </span>
        ) : null}
        {app.mcpNote ? (
          <span className="pill" data-tauri-drag-region="deep">
            {app.mcpNote}
          </span>
        ) : null}
      </div>
      <div className="titlebar-right">
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title={app.theme === "light" ? "Cursor-style dark" : "Codex-style light"}
          onClick={() => app.setTheme(app.theme === "light" ? "dark" : "light")}
        >
          {app.theme === "light" ? "☾" : "☀"}
        </button>
        <button
          className="icon-btn"
          data-tauri-drag-region="false"
          title="Toggle project explorer"
          onClick={() => app.setExplorerOpen(!app.explorerOpen)}
        >
          ▥
        </button>
      </div>
    </div>
  );
}

function ChatPane() {
  const app = useApp();
  const sessionId = app.selectedSession;
  const transcript = sessionId ? app.transcripts[sessionId] : undefined;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript?.blocks.length, app.sending]);

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

  if (!app.selectedCwd) {
    return (
      <main className="chat">
        <div className="empty">
          <div className="empty-card">
            <h2>Open a project</h2>
            <p>Pick a folder on the left. Grokzilla uses the same sessions as Grok Build in the terminal.</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat" onDragOver={onChatDragOver} onDrop={onChatDrop}>
      <div className="chat-head">
        <h1>{transcript?.blocks.length ? threadTitle(app) : projectName(app.selectedCwd)}</h1>
        <ThreadStatsBar />
      </div>
      <div className="transcript" ref={scroller}>
        <div className="stack">
          {!transcript?.blocks.length ? (
            <div className="empty">
              <div className="empty-card">
                <h2>What should we work on?</h2>
                <p>Ask Grok to explore the repo, fix a bug, or plan a change. Approvals stay in Ask mode unless you switch.</p>
              </div>
            </div>
          ) : (
            <TranscriptView blocks={transcript.blocks} />
          )}
        </div>
      </div>
      <div className="composer-wrap">
        {app.permission ? (
          <div className="permission">
            <h3>{app.permission.title || "Permission required"}</h3>
            <p>{previewJson(app.permission.toolCall ?? app.permission.raw, 400)}</p>
            <div className="perm-actions">
              {app.permission.options.map((option) => (
                <button
                  key={option.optionId}
                  className={option.kind?.includes("reject") ? "danger" : "primary"}
                  onClick={() => void app.answerPermission(option.optionId)}
                >
                  {option.name}
                </button>
              ))}
              <button className="ghost" onClick={() => void app.answerPermission(undefined, true)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <Composer />
      </div>
    </main>
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
    const handle = window.setInterval(() => void loadThreadStats(), sending ? 4000 : 20000);
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
        <span className="thread-stat thread-stat-extra">{stats.userMessages} msgs</span>
      ) : null}
    </div>
  );
}

function threadTitle(app: ReturnType<typeof useApp.getState>): string {
  const thread = app.threads.find((t) => t.sessionId === app.selectedSession);
  return thread?.title || "Thread";
}