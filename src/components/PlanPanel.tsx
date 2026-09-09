import { useEffect, useMemo, useState } from "react";
import { Markdown } from "./Markdown";
import {
  formatPlanFeedback,
  isDoneStatus,
  isLiveStatus,
  isPlanPermission,
  planEntries,
  planLines,
  planProgress,
  planTitle,
  quotePlanLines,
  statusLabel,
  type PlanComment,
  type PlanEntry,
} from "../lib/plan";
import { isReadOnlySession } from "../lib/format";
import { useApp } from "../lib/store";

type DocView = "preview" | "review" | "edit";

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
  const label = total > 0 ? `Plan ${done}/${total}` : modeId === "plan" ? "Planning" : "Plan";
  return (
    <button
      className={`plan-chip ${modeId === "plan" ? "on" : ""}`}
      title={current || planDoc?.path || "Open plan"}
      onClick={() => openPlanPanel()}
    >
      <span className="plan-chip-label">{label}</span>
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
  const setPlanDirty = useApp((s) => s.setPlanDirty);
  const savePlan = useApp((s) => s.savePlan);
  const approvePlan = useApp((s) => s.approvePlan);
  const revisePlan = useApp((s) => s.revisePlan);
  const quitPlan = useApp((s) => s.quitPlan);
  const [tab, setTab] = useState<"doc" | "steps">("doc");
  const [docView, setDocView] = useState<DocView>("preview");
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState("");
  const [comments, setComments] = useState<PlanComment[]>([]);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const entries = useMemo(() => {
    const plan = blocks?.find((block) => block.type === "plan");
    return plan && plan.type === "plan" ? planEntries(plan.entries) : [];
  }, [blocks]);

  const live = sending || modeId === "plan" || review;
  const markdown = planDoc?.markdown ?? "";
  const dirty = draft !== markdown;
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

  const planPerm = permission ? isPlanPermission(permission) : false;
  const showReview = !readOnly && (review || planPerm);

  useEffect(() => {
    if (showReview) setDocView((current) => (current === "edit" ? current : "review"));
  }, [showReview]);

  useEffect(() => {
    if (docView !== "edit") setDraft(markdown);
  }, [markdown, docView]);

  useEffect(() => {
    setPlanDirty(open && docView === "edit" && dirty);
  }, [open, docView, dirty, setPlanDirty]);

  useEffect(() => {
    setComments([]);
    setSelection(null);
    setCommentBody("");
    setNotes("");
    setError("");
  }, [planDoc?.path]);

  useEffect(() => {
    if (open) return;
    setDocView("preview");
    setDraft(markdown);
    setComments([]);
    setSelection(null);
    setCommentBody("");
    setNotes("");
    setError("");
  }, [open, markdown]);

  if (!open) return null;

  const title = markdown ? planTitle(markdown) : review ? "Review plan" : "Plan";
  const empty = !markdown.trim() && !entries.length;
  const pending = comments.filter((comment) => comment.body.trim()).length;
  const lines = planLines(draft || markdown);

  function selectLine(line: number, shift: boolean) {
    setSelection((prev) => {
      if (shift && prev) return { start: prev.start, end: line };
      return { start: line, end: line };
    });
    setCommentBody("");
  }

  function addComment() {
    if (!selection) return;
    const body = commentBody.trim();
    if (!body) return;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    setComments((current) => [
      ...current,
      {
        id: `c-${Date.now()}-${start}`,
        start,
        end,
        quote: quotePlanLines(lines, start, end),
        body,
      },
    ]);
    setCommentBody("");
    setSelection(null);
  }

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

  async function onSave() {
    setSaving(true);
    setError("");
    try {
      await savePlan(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function switchView(next: DocView) {
    if (docView === "edit" && dirty && next !== "edit") {
      if (!window.confirm("Discard unsaved plan edits?")) return;
      setDraft(markdown);
    }
    setDocView(next);
  }

  const feedback = formatPlanFeedback(comments, notes);

  return (
    <div className={`plan-overlay ${showReview ? "review" : ""}`}>
      <div className="plan-sheet" role="dialog" aria-label={title}>
        <div className="plan-sheet-head">
          <div>
            <div className="plan-kicker">
              {showReview ? "Ready to build" : modeId === "plan" ? "Planning" : "Plan"}
              {pending ? ` · ${pending} comment${pending === 1 ? "" : "s"}` : ""}
              {docView === "edit" && dirty ? " · unsaved" : ""}
            </div>
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
          {tab === "doc" ? (
            <span className="plan-view-toggle">
              <button className={docView === "preview" ? "on" : ""} onClick={() => switchView("preview")}>
                Preview
              </button>
              <button className={docView === "review" ? "on" : ""} onClick={() => switchView("review")}>
                Review
              </button>
              {readOnly ? null : (
                <button className={docView === "edit" ? "on" : ""} onClick={() => switchView("edit")}>
                  Edit
                </button>
              )}
            </span>
          ) : null}
        </div>
        <div className="plan-sheet-body">
          {tab === "steps" ? (
            entries.length ? (
              <PlanChecklist entries={entries} />
            ) : (
              <div className="plan-empty">No live steps yet. Grok updates this list as it works.</div>
            )
          ) : docView === "edit" ? (
            <textarea
              className="plan-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              aria-label="Edit plan markdown"
            />
          ) : docView === "review" ? (
            markdown.trim() || draft.trim() ? (
              <PlanReviewLines
                lines={lines}
                comments={comments}
                selection={selection}
                allowComments={showReview}
                commentBody={commentBody}
                onSelect={selectLine}
                onCommentBody={setCommentBody}
                onAddComment={addComment}
                onRemoveComment={(id) => setComments((current) => current.filter((item) => item.id !== id))}
              />
            ) : (
              <div className="plan-empty">
                {modeId === "plan"
                  ? "Grok is still writing the plan. This view updates as plan.md lands."
                  : "No saved plan for this thread yet. Switch to Plan and ask Grok to design the approach."}
              </div>
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
          {error ? <p className="inline-error">{error}</p> : null}
          {docView === "edit" && !readOnly ? (
            <div className="perm-actions">
              <button className="primary" disabled={saving || !dirty} onClick={() => void onSave()}>
                {saving ? "Saving…" : "Save plan"}
              </button>
              <button
                className="ghost"
                disabled={!dirty}
                onClick={() => {
                  setDraft(markdown);
                  setError("");
                }}
              >
                Discard
              </button>
              {showReview ? (
                <button className="ghost" disabled={dirty} onClick={() => setDocView("review")}>
                  Back to review
                </button>
              ) : null}
            </div>
          ) : showReview ? (
            <>
              <textarea
                className="plan-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={pending ? "Optional extra notes for Grok…" : "Request changes… or comment on a line in Review"}
              />
              <div className="perm-actions">
                <button
                  className="primary"
                  onClick={() => void approvePlan(comments, notes)}
                  title={feedback ? "Approve and send comments with the plan" : "Approve the plan and start building"}
                >
                  {pending ? "Approve w/ comments" : "Approve & build"}
                </button>
                <button className="ghost" onClick={() => void revisePlan(notes, comments)}>
                  Request changes
                </button>
                <button className="ghost" onClick={() => switchView("edit")}>
                  Edit
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
              {readOnly ? null : (
                <button className="ghost" onClick={() => switchView("edit")}>
                  Edit
                </button>
              )}
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

function PlanReviewLines({
  lines,
  comments,
  selection,
  allowComments,
  commentBody,
  onSelect,
  onCommentBody,
  onAddComment,
  onRemoveComment,
}: {
  lines: string[];
  comments: PlanComment[];
  selection: { start: number; end: number } | null;
  allowComments: boolean;
  commentBody: string;
  onSelect: (line: number, shift: boolean) => void;
  onCommentBody: (value: string) => void;
  onAddComment: () => void;
  onRemoveComment: (id: string) => void;
}) {
  const selStart = selection ? Math.min(selection.start, selection.end) : 0;
  const selEnd = selection ? Math.max(selection.start, selection.end) : -1;
  return (
    <div className="plan-review" role="list">
      {lines.map((line, index) => {
        const n = index + 1;
        const selected = n >= selStart && n <= selEnd;
        const lineComments = comments.filter((comment) => Math.max(comment.start, comment.end) === n);
        return (
          <div key={n} className="plan-review-block">
            <button
              type="button"
              className={`plan-line ${selected ? "on" : ""} ${lineComments.length ? "has-comment" : ""}`}
              onClick={(event) => onSelect(n, event.shiftKey)}
            >
              <span className="plan-line-n">{n}</span>
              <code>{line || " "}</code>
            </button>
            {lineComments.map((comment) => (
              <div key={comment.id} className="plan-comment">
                <p>{comment.body}</p>
                <button className="ghost" onClick={() => onRemoveComment(comment.id)}>
                  Remove
                </button>
              </div>
            ))}
            {allowComments && selected && n === selEnd ? (
              <div className="plan-comment-form">
                <textarea
                  autoFocus
                  value={commentBody}
                  onChange={(event) => onCommentBody(event.target.value)}
                  placeholder={`Comment on L${selStart === selEnd ? selStart : `${selStart}–${selEnd}`}`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      onAddComment();
                    }
                  }}
                />
                <div className="perm-actions">
                  <button className="primary" disabled={!commentBody.trim()} onClick={onAddComment}>
                    Add comment
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {allowComments ? <p className="plan-review-hint">Click a line, Shift-click a range, then add a comment. ⌘Enter to save it.</p> : null}
    </div>
  );
}
