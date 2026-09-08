import { useEffect, useMemo, useState } from "react";
import { Markdown } from "./Markdown";
import {
  isDoneStatus,
  isLiveStatus,
  isPlanPermission,
  planEntries,
  planProgress,
  planTitle,
  statusLabel,
  type PlanEntry,
} from "../lib/plan";
import { isReadOnlySession } from "../lib/format";
import { useApp } from "../lib/store";

export function PlanChecklist({ entries }: { entries: PlanEntry[] }) {
  if (!entries.length) return null;
  const { done, total } = planProgress(entries);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="plan-check">
      <div className="plan-progress" title={`${done}/${total} steps`}>
        <span className="usage-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <b>
          {done}/{total}
        </b>
        <span>steps</span>
      </div>
      <ol className="plan-list">
        {entries.map((entry, index) => (
          <li
            key={`${entry.content}-${index}`}
            className={`${entry.status ?? ""} ${isLiveStatus(entry.status) ? "is-live" : ""}`}
          >
            <span className={`plan-mark ${entry.status ?? ""}`} />
            <span className="plan-copy">
              <span>{entry.content}</span>
              <em>{statusLabel(entry.status)}</em>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PlanChip() {
  const blocks = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.transcripts[id]?.blocks : undefined;
  });
  const planDoc = useApp((s) => s.planDoc);
  const modeId = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.transcripts[id]?.modeId : undefined;
  });
  const openPlanPanel = useApp((s) => s.openPlanPanel);
  const entries = useMemo(() => {
    const plan = blocks?.find((block) => block.type === "plan");
    return plan && plan.type === "plan" ? planEntries(plan.entries) : [];
  }, [blocks]);
  const { done, total, current } = planProgress(entries);
  const hasDoc = Boolean(planDoc?.exists);
  if (!hasDoc && !entries.length && modeId !== "plan") return null;
  const label =
    total > 0 ? `Plan ${done}/${total}` : modeId === "plan" ? "Planning" : "Plan";
  return (
    <button
      className={`plan-chip ${modeId === "plan" ? "on" : ""}`}
      title={current || planDoc?.path || "Open plan"}
      onClick={() => openPlanPanel()}
    >
      {label}
      {current ? <span className="plan-chip-now">{current}</span> : null}
    </button>
  );
}

export function PlanPanel() {
  const open = useApp((s) => s.planPanelOpen);
  const review = useApp((s) => s.planReviewOpen);
  const planDoc = useApp((s) => s.planDoc);
  const permission = useApp((s) => s.permission);
  const sending = useApp((s) => s.sending);
  const readOnly = useApp((s) => isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds));
  const modeId = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.transcripts[id]?.modeId : undefined;
  });
  const blocks = useApp((s) => {
    const id = s.selectedSession;
    return id ? s.transcripts[id]?.blocks : undefined;
  });
  const loadPlanDoc = useApp((s) => s.loadPlanDoc);
  const closePlanPanel = useApp((s) => s.closePlanPanel);
  const approvePlan = useApp((s) => s.approvePlan);
  const revisePlan = useApp((s) => s.revisePlan);
  const quitPlan = useApp((s) => s.quitPlan);
  const [tab, setTab] = useState<"doc" | "steps">("doc");
  const [notes, setNotes] = useState("");
  const [copying, setCopying] = useState(false);

  const entries = useMemo(() => {
    const plan = blocks?.find((block) => block.type === "plan");
    return plan && plan.type === "plan" ? planEntries(plan.entries) : [];
  }, [blocks]);

  const live = sending || modeId === "plan" || review;
  useEffect(() => {
    void loadPlanDoc();
    if (!live) return;
    const handle = window.setInterval(() => void loadPlanDoc(), 1500);
    return () => window.clearInterval(handle);
  }, [live, loadPlanDoc]);

  useEffect(() => {
    if (planDoc?.exists) setTab("doc");
    else if (entries.length) setTab("steps");
  }, [planDoc?.exists, entries.length]);

  if (!open) return null;

  const markdown = planDoc?.markdown ?? "";
  const title = markdown ? planTitle(markdown) : review ? "Review plan" : "Plan";
  const empty = !markdown.trim() && !entries.length;
  const planPerm = permission ? isPlanPermission(permission) : false;
  const showReview = !readOnly && (review || planPerm);

  async function copyPlan() {
    const text = markdown.trim() || entries.map((entry) => `- [${isDoneStatus(entry.status) ? "x" : " "}] ${entry.content}`).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopying(true);
      window.setTimeout(() => setCopying(false), 1200);
    } catch {
      /* clipboard may be denied */
    }
  }

  return (
    <div className={`plan-overlay ${showReview ? "review" : ""}`}>
      <div className="plan-sheet" role="dialog" aria-label={title}>
        <div className="plan-sheet-head">
          <div>
            <div className="plan-kicker">{showReview ? "Ready to build" : modeId === "plan" ? "Planning" : "Plan"}</div>
            <h2>{title}</h2>
          </div>
          <button className="ghost" onClick={() => closePlanPanel()}>
            Close
          </button>
        </div>
        <div className="plan-tabs">
          <button className={tab === "doc" ? "on" : ""} onClick={() => setTab("doc")}>
            Document
          </button>
          <button className={tab === "steps" ? "on" : ""} onClick={() => setTab("steps")}>
            Steps{entries.length ? ` · ${entries.length}` : ""}
          </button>
        </div>
        <div className="plan-sheet-body">
          {tab === "steps" ? (
            entries.length ? (
              <PlanChecklist entries={entries} />
            ) : (
              <div className="plan-empty">No live steps yet. Grok updates this list as it works.</div>
            )
          ) : markdown.trim() ? (
            <Markdown text={markdown} />
          ) : empty ? (
            <div className="plan-empty">
              {modeId === "plan"
                ? "Grok is still writing the plan. This view updates as plan.md lands."
                : "No saved plan for this thread yet. Switch to Plan and ask Grok to design the approach."}
            </div>
          ) : (
            <div className="plan-empty">The plan file is empty.</div>
          )}
        </div>
        <div className="plan-sheet-foot">
          {showReview ? (
            <>
              <textarea
                className="plan-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Request changes… optional notes for Grok"
              />
              <div className="perm-actions">
                <button className="primary" onClick={() => void approvePlan()}>
                  Approve & build
                </button>
                <button className="ghost" onClick={() => void revisePlan(notes)}>
                  Request changes
                </button>
                <button className="danger" onClick={() => void quitPlan()}>
                  Quit plan
                </button>
                <button className="ghost" onClick={() => void copyPlan()}>
                  {copying ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : (
            <div className="perm-actions">
              <button className="ghost" onClick={() => void copyPlan()}>
                {copying ? "Copied" : "Copy"}
              </button>
              <button className="ghost" onClick={() => closePlanPanel()}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
