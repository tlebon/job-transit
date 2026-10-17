"use client";

import type { ReactNode } from "react";

type Props = {
  title: string;
  value?: ReactNode; // what we know, shown while closed; empty → the placeholder
  empty: string; // what this part is for, when nothing is known yet
  defaultOpen?: boolean;
  children: ReactNode; // the editor, shown when opened
};

/** One part of the profile: shows what we know at a glance, opens to edit it. */
export function Leg({ title, value, empty, defaultOpen, children }: Props) {
  const known = value !== undefined && value !== null && value !== false && value !== "";
  return (
    <details className="leg" data-done={known} open={defaultOpen}>
      <summary>
        <span className="leg-text">
          <span className="leg-title">{title}</span>
          {known ? <span className="leg-value">{value}</span> : <span className="leg-hint">{empty}</span>}
        </span>
        <span className="leg-status">
          <span className="leg-closed">{known ? "Edit" : "Add"}</span>
          <span className="leg-opened">Done</span>
        </span>
      </summary>
      <div className="leg-body">{children}</div>
    </details>
  );
}
