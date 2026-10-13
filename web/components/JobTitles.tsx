"use client";

import { useState } from "react";
import { JobPicker } from "./JobPicker";

export type Title = { census: number; label: string };

type Props = {
  titles: Title[];
  onChange: (titles: Title[]) => void;
};

/** One or more job titles. Extra titles cover jobs no single title describes (e.g. manager who still codes). */
export function JobTitles({ titles, onChange }: Props) {
  const [adding, setAdding] = useState(titles.length === 0);
  const searching = adding || titles.length === 0;

  return (
    <div className="titles">
      {titles.length > 0 && (
        <ul className="title-list">
          {titles.map((t) => (
            <li key={t.census} className="picked">
              <span>{t.label}</span>
              <button
                type="button"
                className="linkish"
                aria-label={`Remove ${t.label}`}
                onClick={() => onChange(titles.filter((x) => x.census !== t.census))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {searching ? (
        <JobPicker
          value={null}
          onChange={(v) => {
            if (v && !titles.some((t) => t.census === v.census)) onChange([...titles, v]);
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" className="linkish more" onClick={() => setAdding(true)}>
          Add another title, if one doesn’t cover your job
        </button>
      )}
    </div>
  );
}
