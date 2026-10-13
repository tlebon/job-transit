import type { Occupation, StopDetails } from "@/lib/api";

/** "What it is": the O*NET description, or for a catch-all group, the jobs inside it. */
export function WhatItIs({ occupation, details, showTasks = true }: { occupation: Occupation; details: StopDetails | null; showTasks?: boolean }) {
  if (!details) return <p className="q-help">Loading…</p>;

  if (details.catch_all) {
    return (
      <>
        <p>
          A group of jobs the US job-move data counts together
          {occupation.official_title ? ` (officially “${occupation.official_title}”)` : ""}:
        </p>
        <ul className="members">
          {(details.members ?? []).slice(0, 6).map((m) => (
            <li key={m.title}>
              <strong>{m.title}.</strong> {m.summary}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      {details.description && <p>{details.description}</p>}
      {details.example_titles && details.example_titles.length > 0 && (
        <p className="q-help">Also called: {details.example_titles.slice(0, 6).join(", ")}</p>
      )}
      {showTasks && details.tasks && details.tasks.length > 0 && (
        <ul className="tasks">
          {details.tasks.slice(0, 4).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </>
  );
}
