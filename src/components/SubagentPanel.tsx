import { useEffect, useMemo, useState } from "react";
import { isReadOnlySession } from "../lib/format";
import {
  isLiveSubagent,
  runningSubagentCount,
  subagentDot,
  subagentElapsed,
  subagentStatusLabel,
} from "../lib/subagents";
import { isRunning } from "../lib/runtime";
import { useApp } from "../lib/store";
import type { SubagentInfo } from "../lib/types";
import { TranscriptView } from "./Transcript";

const EMPTY: SubagentInfo[] = [];

export function SubagentChip() {
  const items = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.subagents[id] ?? EMPTY : EMPTY;
  });
  const open = useApp((s) => s.subagentRosterOpen);
  const toggle = useApp((s) => s.toggleSubagentRoster);
  const running = runningSubagentCount(items);
  const showing = open ?? running > 0;
  if (!items.length) return null;
  const label = running > 0 ? `${running} subagent${running === 1 ? "" : "s"}` : `Subagents · ${items.length}`;
  return (
    <button
      className={`plan-chip ${running ? "on" : ""} ${showing ? "is-open" : ""}`}
      title={running > 0 ? `${running} running` : `${items.length} subagents`}
      onClick={() => toggle()}
    >
      {running > 0 ? <span className="act-dot running" /> : null}
      <span className="plan-chip-label">{label}</span>
    </button>
  );
}

export function SubagentRoster() {
  const sessionId = useApp((s) => s.selectedSession);
  const items = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.subagents[id] ?? EMPTY : EMPTY;
  });
  const open = useApp((s) => s.subagentRosterOpen);
  const inspecting = useApp((s) => s.inspectingSubagent);
  const error = useApp((s) => s.subagentError);
  const loadSubagents = useApp((s) => s.loadSubagents);
  const inspectSubagent = useApp((s) => s.inspectSubagent);
  const stopSubagent = useApp((s) => s.stopSubagent);
  const attached = useApp((s) => {
    const id = s.selectedSession;
    return Boolean(id && isRunning(s.tasks[id]));
  });
  const readOnly = useApp((s) => isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds));
  const sending = useApp((s) => s.sending);
  const running = runningSubagentCount(items);
  const showing = items.length > 0 && (open ?? running > 0);

  useEffect(() => {
    if (!sessionId) return;
    void loadSubagents(sessionId);
    const live = running > 0 || sending;
    const handle = window.setInterval(() => void loadSubagents(sessionId), live ? 1500 : 12_000);
    return () => window.clearInterval(handle);
  }, [sessionId, running, sending, loadSubagents]);

  if (!showing) return null;

  return (
    <div className="subagent-roster" role="region" aria-label="Subagents">
      <div className="subagent-roster-head">
        <span className="plan-kicker">Subagents</span>
        <span className="subagent-roster-meta">
          {running > 0 ? `${running} running` : `${items.length} finished`}
        </span>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="subagent-list">
        {items.map((item) => (
          <SubagentRow
            key={item.subagentId}
            item={item}
            active={inspecting === item.childSessionId || inspecting === item.subagentId}
            canStop={attached && !readOnly && isLiveSubagent(item)}
            onInspect={() => void inspectSubagent(item.childSessionId || item.subagentId)}
            onStop={() => void stopSubagent(item.childSessionId || item.subagentId)}
          />
        ))}
      </div>
    </div>
  );
}

function SubagentRow({
  item,
  active,
  canStop,
  onInspect,
  onStop,
}: {
  item: SubagentInfo;
  active: boolean;
  canStop: boolean;
  onInspect: () => void;
  onStop: () => void;
}) {
  const live = isLiveSubagent(item);
  const elapsed = subagentElapsed(item);
  return (
    <div className={`subagent-row ${active ? "active" : ""} ${live ? "is-live" : ""}`}>
      <button className="subagent-hit" onClick={onInspect} title={item.description || item.subagentId}>
        <span className={`act-dot ${subagentDot(item)}`} />
        <span className="subagent-copy">
          <span className="subagent-title">
            <b>{item.subagentType || "subagent"}</b>
            {item.description ? <span>{item.description}</span> : null}
          </span>
          <span className="subagent-detail">
            {subagentStatusLabel(item)}
            {item.activity ? ` · ${item.activity}` : ""}
            {elapsed ? ` · ${elapsed}` : ""}
            {item.model ? ` · ${item.model}` : ""}
          </span>
        </span>
      </button>
      {canStop ? (
        <button className="ghost subagent-stop" onClick={onStop} title="Stop this subagent">
          Stop
        </button>
      ) : null}
    </div>
  );
}

export function SubagentInspector() {
  const childId = useApp((s) => s.inspectingSubagent);
  const parentId = useApp((s) => s.selectedSession);
  const item = useApp((s) => {
    const parent = s.selectedSession;
    const id = s.inspectingSubagent;
    if (!parent || !id) return null;
    return (
      (s.subagents[parent] ?? []).find((row) => row.childSessionId === id || row.subagentId === id) ?? null
    );
  });
  const blocks = useApp((s) => {
    const id = s.inspectingSubagent;
    return id ? s.transcripts[id]?.blocks : undefined;
  });
  const error = useApp((s) => s.subagentError);
  const close = useApp((s) => s.closeSubagentInspector);
  const refresh = useApp((s) => s.refreshInspectedSubagent);
  const loadSubagents = useApp((s) => s.loadSubagents);
  const stopSubagent = useApp((s) => s.stopSubagent);
  const attached = useApp((s) => {
    const id = s.selectedSession;
    return Boolean(id && isRunning(s.tasks[id]));
  });
  const readOnly = useApp((s) => isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds));
  const live = item ? isLiveSubagent(item) : false;
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    if (!childId) return;
    void refresh();
    const handle = window.setInterval(() => {
      void refresh();
      if (parentId) void loadSubagents(parentId);
    }, live ? 1500 : 10_000);
    return () => window.clearInterval(handle);
  }, [childId, parentId, live, refresh, loadSubagents]);

  const title = useMemo(() => {
    if (!item) return "Subagent";
    return [item.subagentType || "Subagent", item.description].filter(Boolean).join(" · ");
  }, [item]);

  if (!childId) return null;

  return (
    <div className="plan-overlay subagent-overlay">
      <div className="plan-sheet subagent-sheet" role="dialog" aria-label={title}>
        <div className="plan-sheet-head">
          <div>
            <div className="plan-kicker">
              {item ? subagentStatusLabel(item) : "Subagent"}
              {item?.model ? ` · ${item.model}` : ""}
              {item ? ` · ${subagentElapsed(item) || "just now"}` : ""}
            </div>
            <h2>{title}</h2>
          </div>
          <div className="subagent-sheet-actions">
            {attached && !readOnly && live ? (
              <button className="danger" onClick={() => void stopSubagent(childId)}>
                Stop
              </button>
            ) : null}
            <button className="ghost" onClick={() => close()}>
              Close
            </button>
          </div>
        </div>
        <p className="subagent-banner">
          Read-only child session. Grokzilla will not attach to it; the parent thread stays in control.
        </p>
        {error ? <div className="inline-error">{error}</div> : null}
        <div
          className="plan-sheet-body subagent-transcript"
          onScroll={(event) => {
            const el = event.currentTarget;
            setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
          }}
        >
          {blocks?.length ? (
            <div className="stack has-turns">
              <TranscriptView blocks={blocks} sessionId={childId} />
              {live ? (
                <div className="working-line">
                  <span className="act-dot running" />
                  {item?.activity || "Working"}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted panel-status">{live ? "Waiting for the first child update…" : "No child transcript yet."}</p>
          )}
        </div>
        {!stuck ? (
          <button
            className="jump-bottom"
            onClick={(event) => {
              const sheet = (event.currentTarget.parentElement as HTMLElement | null)?.querySelector(
                ".subagent-transcript",
              );
              if (sheet) sheet.scrollTop = sheet.scrollHeight;
              setStuck(true);
            }}
          >
            Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
