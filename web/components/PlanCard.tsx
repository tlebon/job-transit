"use client";

import { useState } from "react";
import { addStep, downloadIcs, removeStep, updateStep, type Plan, type PlanStep } from "@/lib/plan";
import { Markdown } from "./Markdown";

type Props = {
  plan: Plan;
  onChange: (plan: Plan | null) => void; // null removes the plan
  onOpenStop: (census: number) => void;
  onHelp: (step: PlanStep) => void; // ask the guide for resources and a first action
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** The saved plan: steps to tick off, edit or add to, with target dates and a calendar export for reminders. */
export function PlanCard({ plan, onChange, onOpenStop, onHelp }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const done = plan.steps.filter((s) => s.done).length;
  const total = plan.steps.length;
  const open = plan.steps.some((s) => !s.done);

  return (
    <details className="plan" open>
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
        {open && (
          <button type="button" className="top-button" onClick={() => downloadIcs(plan)}>
            Add reminders to calendar
          </button>
        )}
        <button type="button" className="linkish" onClick={() => onOpenStop(plan.census)}>
          Open the stop
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
  return (
    <form
      className="plan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title: title.trim(), detail: detail.trim(), due: due || step.due });
      }}
    >
      <input className="field" value={title} aria-label="Step title" onChange={(e) => setTitle(e.target.value)} autoFocus />
      <textarea className="field area" rows={2} value={detail} aria-label="Details" placeholder="Details (optional)" onChange={(e) => setDetail(e.target.value)} />
      <label className="plan-editor-due">
        By <input className="field" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
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
