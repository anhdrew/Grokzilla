import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApp } from "../lib/store";
import { attachTerminalWriter, useTerminals } from "../lib/terminal";
import { desktop, useWorkspace } from "../lib/workspace";

export function TerminalPanel() {
  const selectedSession = useApp((s) => s.selectedSession);
  const selectedCwd = useApp((s) => s.selectedCwd);
  const allTabs = useTerminals((s) => s.tabs);
  const tabs = allTabs.filter((tab) => tab.taskId === (selectedSession ?? ""));
  const activeId = useTerminals((s) => (selectedSession ? s.active[selectedSession] : undefined));
  const taskId = selectedSession ?? "";
  const cwd = selectedCwd ?? "";
  const terminalOpen = useWorkspace((s) => s.data.layout.terminalOpen);

  useEffect(() => {
    if (!taskId || !cwd || !terminalOpen) return;
    useTerminals.getState().ensure(taskId, cwd);
  }, [taskId, cwd, terminalOpen]);

  if (!taskId || !cwd) {
    return (
      <section className="terminal-dock">
        <div className="terminal-toolbar">
          <span className="kicker">Terminal</span>
        </div>
        <p className="panel-status">Open a task to use its project folder in the terminal.</p>
      </section>
    );
  }

  return (
    <section className="terminal-dock">
      <div className="terminal-toolbar">
        <span className="kicker">Terminal</span>
        <div className="file-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={tab.id === activeId ? "active" : ""}
              onClick={() => useTerminals.getState().activate(taskId, tab.id)}
            >
              <span>{tab.title}{tab.exited ? " · exited" : ""}</span>
              <span
                role="button"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void useTerminals.getState().close(tab.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="ghost" onClick={() => void useTerminals.getState().create(taskId, cwd)}>
          New tab
        </button>
        <button
          className="ghost"
          aria-label="Close terminal"
          onClick={() => useWorkspace.getState().toggleTerminal()}
        >
          ×
        </button>
      </div>
      <div className="terminal-stack">
        {allTabs.map((tab) => (
          <XtermView
            key={tab.id}
            tabId={tab.id}
            taskId={tab.taskId}
            cwd={tab.cwd}
            visible={tab.taskId === taskId && tab.id === activeId}
          />
        ))}
      </div>
    </section>
  );
}

function XtermView({
  tabId,
  taskId,
  cwd,
  visible,
}: {
  tabId: string;
  taskId: string;
  cwd: string;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const dark = document.documentElement.dataset.theme === "dark";
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      theme: dark
        ? { background: "#161617", foreground: "#ececef" }
        : { background: "#ffffff", foreground: "#111113" },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let ptyId = useTerminals.getState().tabs.find((tab) => tab.id === tabId)?.ptyId;
    const shell = useWorkspace.getState().data.settings.shell;
    const started = ptyId
      ? Promise.resolve(ptyId)
      : desktop.terminalOpen(taskId, cwd, shell, term.cols, term.rows).then((id) => {
          ptyId = id;
          useTerminals.setState((state) => ({
            tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ptyId: id } : tab)),
          }));
          return id;
        });

    const unwrite = started.then((id) =>
      attachTerminalWriter(id, (bytes) => {
        term.write(bytes);
      }),
    );
    const data = term.onData((chunk) => {
      const id = useTerminals.getState().tabs.find((tab) => tab.id === tabId)?.ptyId;
      if (id) void desktop.terminalWrite(id, chunk);
    });
    const observer = new ResizeObserver(() => {
      if (!visible) return;
      fit.fit();
      const id = useTerminals.getState().tabs.find((tab) => tab.id === tabId)?.ptyId;
      if (id) void desktop.terminalResize(id, term.cols, term.rows);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      data.dispose();
      void unwrite.then((fn) => fn());
      term.dispose();
    };
  }, [tabId, taskId, cwd]);

  useEffect(() => {
    if (!visible) return;
    fitRef.current?.fit();
  }, [visible]);

  return <div className="xterm-host" hidden={!visible} ref={host} />;
}
