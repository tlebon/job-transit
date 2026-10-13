"use client";

import type { ReactNode } from "react";

type Props = {
  title: string;
  hint: string;
  status: string;
  done: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
};

/** One optional step of the journey planner. Collapsible; the dot fills once something is answered. */
export function Leg({ title, hint, status, done, defaultOpen, children }: Props) {
  return (
    <details className="leg" data-done={done} open={defaultOpen}>
      <summary>
        <span className="leg-dot" aria-hidden="true" />
        <span>
          <span className="leg-title">{title}</span>
          <br />
          <span className="leg-hint">{hint}</span>
        </span>
        <span className="leg-status">{status}</span>
      </summary>
      <div className="leg-body">{children}</div>
    </details>
  );
}
