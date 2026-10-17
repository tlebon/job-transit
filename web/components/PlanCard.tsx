"use client";

import { useEffect, useRef, useState } from "react";
import {
  addStep,
  downloadIcs,
  logSession,
  nextSession,
  removeStep,
  sessionsFrom,
  updateStep,
  type Plan,
  type PlanStep,
} from "@/lib/plan";
import { EmailPlan } from "./EmailPlan";
import { Markdown } from "./Markdown";

type Props = {
  plan: Plan;
  onChange: (plan: Plan | null) => void; // null removes the plan
  onOpenStop: (census: number) => void;
  onHelp: (step: PlanStep) => void; // ask the guide for resources and a first action
  onPractice: (step: PlanStep) => void; // a short quiz or exercise with the guide
  savedAt?: number; // when the guide last saved the plan: scroll it into view and highlight it
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** The saved plan: steps to tick off, edit or add to, with target dates and a calendar export for reminders. */
export function PlanCard({ plan, onChange, onOpenStop, onHelp, onPractice, savedAt }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const card = useRef<HTMLDetailsElement>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!savedAt || Date.now() - savedAt > 3000) return; // only right after a save, not on every remount
    card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), 2000);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const [draft, setDraft] = useState("");
  const done = plan.steps.filter((s) => s.done).length;
  const total = plan.steps.length;
  const open = plan.steps.some((s) => !s.done);

  return (
    <details className={fresh ? "plan plan-fresh" : "plan"} open ref={card}>
      <summary className="plan-head">
        <span className="plan-label">Your plan</span>
        <span className="plan-title">{plan.occupation}</span>
        <span className="plan-progress">
          {done} of {total} done
        </span>
      </summary>
      <div className="plan-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      {plan.summary && <p className="plan-summary">{plan.summary}</p>}
      <ol className="plan-steps">
        {plan.steps.map((s) =>
          editing === s.id ? (
            <li key={s.id}>
              <StepEditor
                step={s}
                onSave={(patch) => {
                  onChange(updateStep(plan, s.id, patch));
                  setEditing(null);
                }}
                onRemove={() => {
                  onChange(removeStep(plan, s.id));
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={s.id} data-done={s.done}>
              <input
                type="checkbox"
                checked={s.done}
                aria-label={`Done: ${s.title}`}
                onChange={() => onChange(updateStep(plan, s.id, { done: !s.done }))}
              />
              <span className="plan-step">
                <span className="plan-step-title">{s.title}</span>
                {s.detail && !s.done && (
                  <span className="plan-step-detail">
                    <Markdown text={s.detail} />
                  </span>
                )}
                {s.resources && s.resources.length > 0 && !s.done && (
                  <span className="plan-step-detail plan-resources">
                    <Markdown text={s.resources.map((r) => `- ${r}`).join("\n")} />
                  </span>
                )}
                {s.sessions && !s.done && <Practice step={s} onPractice={() => onPractice(s)} onLog={() => onChange(logSession(plan, s.id))} />}
                <span className="plan-step-due">
                  <span>
                    By {dateFormat.format(new Date(`${s.due}T12:00:00`))}
                    {s.mine ? " · added by you" : ""}
                  </span>
                  {!s.done && (
                    <button type="button" className="linkish plan-edit" onClick={() => onHelp(s)}>
                      Help me start
                    </button>
                  )}
                  <button type="button" className="linkish plan-edit" onClick={() => setEditing(s.id)}>
                    Edit
                  </button>
                </span>
              </span>
            </li>
          ),
        )}
      </ol>
      <form
        className="plan-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          onChange(addStep(plan, draft.trim()));
          setDraft("");
        }}
      >
        <input className="field" value={draft} placeholder="Add your own step…" aria-label="Add your own step" onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="top-button" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <div className="plan-actions">
        <EmailPlan plan={plan} />
        {open && (
          <button
            type="button"
            className="linkish"
            title="A .ics file: open it to add your steps and practice sessions to Apple, Google or Outlook calendar"
            onClick={() => downloadIcs(plan)}
          >
            Download calendar file
          </button>
        )}
        <button type="button" className="linkish" onClick={() => onOpenStop(plan.census)}>
          Show on the map
        </button>
        <button type="button" className="linkish" onClick={() => onChange(null)}>
          Remove plan
        </button>
      </div>
    </details>
  );
}

function StepEditor({
  step,
  onSave,
  onRemove,
  onCancel,
}: {
  step: PlanStep;
  onSave: (patch: Partial<PlanStep>) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(step.title);
  const [detail, setDetail] = useState(step.detail);
  const [due, setDue] = useState(step.due);
  const [spaced, setSpaced] = useState(Boolean(step.sessions));
  return (
    <form
      className="plan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim())
          onSave({
            title: title.trim(),
            detail: detail.trim(),
            due: due || step.due,
            sessions: spaced ? (step.sessions ?? sessionsFrom(new Date())) : undefined,
          });
      }}
    >
      <input className="field" value={title} aria-label="Step title" onChange={(e) => setTitle(e.target.value)} autoFocus />
      <textarea className="field area" rows={2} value={detail} aria-label="Details" placeholder="Details (optional)" onChange={(e) => setDetail(e.target.value)} />
      <label className="plan-editor-due">
        By <input className="field" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <label className="plan-editor-spaced">
        <input type="checkbox" checked={spaced} onChange={(e) => setSpaced(e.target.checked)} /> Practise this with spaced
        repetition (short sessions after 1, 3, 7, 14 and 30 days)
      </label>
      <div className="plan-editor-actions">
        <button type="submit" className="top-button" disabled={!title.trim()}>
          Save
        </button>
        <button type="button" className="linkish" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="linkish plan-delete" onClick={onRemove}>
          Delete step
        </button>
      </div>
    </form>
  );
}

const shortDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** A learning step's practice sessions: when the next one is due, and ways to do it now. */
function Practice({ step, onPractice, onLog }: { step: PlanStep; onPractice: () => void; onLog: () => void }) {
  const sessions = step.sessions ?? [];
  const next = nextSession(step);
  const done = sessions.filter((s) => s.done).length;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = next && next.due <= today;
  return (
    <span className="plan-practice">
      <span className="plan-dots" aria-label={`${done} of ${sessions.length} practice sessions done`}>
        {sessions.map((s, i) => (
          <span key={i} data-done={Boolean(s.done)} />
        ))}
      </span>
      <span className={overdue ? "plan-practice-next due" : "plan-practice-next"}>
        {next ? (overdue ? "Practice due" : `Next practice ${shortDate.format(new Date(`${next.due}T12:00:00`))}`) : "All practice sessions done"}
      </span>
      {next && (
        <>
          <button type="button" className="linkish" onClick={onPractice}>
            Practise now
          </button>
          <button type="button" className="linkish" onClick={onLog}>
            Did a session
          </button>
        </>
      )}
    </span>
  );
}
