"use client";

import type { Plan } from "@/lib/plan";
import { EXPLORE, planName } from "@/lib/workspace";

type Props = { plans: Plan[]; active: string; busy: Record<string, boolean>; onSelect: (id: string) => void };

/** One conversation per plan, plus Explore for everything else. A dot marks a conversation still answering. */
export function PlanTabs({ plans, active, busy, onSelect }: Props) {
  if (!plans.length) return null;
  const tab = (id: string, label: string, sub?: string) => (
    <button key={id} type="button" role="tab" aria-selected={active === id} className="plan-tab" onClick={() => onSelect(id)}>
      <span className="plan-tab-name">
        {label}
        {busy[id] && <span className="plan-tab-busy" aria-label="answering" />}
      </span>
      {sub && <span className="plan-tab-sub">{sub}</span>}
    </button>
  );
  return (
    <div className="plan-tabs" role="tablist" aria-label="Your conversations">
      {tab(EXPLORE, "Explore", "everything else")}
      {plans.map((p) => tab(p.id!, planName(p), `${p.steps.filter((s) => s.done).length} of ${p.steps.length} done`))}
    </div>
  );
}

/** In Explore: the plans so far, to open one. */
export function PlansList({ plans, onOpen }: { plans: Plan[]; onOpen: (id: string) => void }) {
  return (
    <section className="plans-list">
      <h3>Your plans</h3>
      <ul>
        {plans.map((p) => (
          <li key={p.id}>
            <button type="button" className="plans-list-item" onClick={() => onOpen(p.id!)}>
              <strong>{planName(p)}</strong>
              <span className="q-help">
                {p.occupation} · {p.steps.filter((s) => s.done).length} of {p.steps.length} steps done
                {(p.openings ?? []).some((o) => !["found", "hidden"].includes(o.status)) &&
                  ` · ${(p.openings ?? []).filter((o) => !["found", "hidden"].includes(o.status)).length} applications`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="q-help">Each plan has its own conversation. Ask here to compare them or to start another.</p>
    </section>
  );
}
