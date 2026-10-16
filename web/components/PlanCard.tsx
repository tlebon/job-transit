"use client";

import { downloadIcs, type Plan } from "@/lib/plan";

type Props = {
  plan: Plan;
  onToggle: (id: string) => void;
  onRemove: () => void;
  onOpenStop: (census: number) => void;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** The saved plan: steps to tick off, with target dates and a calendar export for reminders. */
export function PlanCard({ plan, onToggle, onRemove, onOpenStop }: Props) {
  const done = plan.steps.filter((s) => s.done).length;
  const open = plan.steps.some((s) => !s.done);
  return (
    <details className="plan" open>
      <summary className="plan-head">
        <span className="plan-label">Your plan</span>
        <span className="plan-title">{plan.occupation}</span>
        <span className="plan-progress">
          {done} of {plan.steps.length} done
        </span>
      </summary>
      {plan.summary && <p className="plan-summary">{plan.summary}</p>}
      <ol className="plan-steps">
        {plan.steps.map((s) => (
          <li key={s.id} data-done={s.done}>
            <label>
              <input type="checkbox" checked={s.done} onChange={() => onToggle(s.id)} />
              <span className="plan-step">
                <span className="plan-step-title">{s.title}</span>
                <span className="plan-step-detail">{s.detail}</span>
                <span className="plan-step-due">By {dateFormat.format(new Date(`${s.due}T12:00:00`))}</span>
              </span>
            </label>
          </li>
        ))}
      </ol>
      <div className="plan-actions">
        {open && (
          <button type="button" className="top-button" onClick={() => downloadIcs(plan)}>
            Add reminders to calendar
          </button>
        )}
        <button type="button" className="linkish" onClick={() => onOpenStop(plan.census)}>
          Open the stop
        </button>
        <button type="button" className="linkish" onClick={onRemove}>
          Remove plan
        </button>
      </div>
    </details>
  );
}
