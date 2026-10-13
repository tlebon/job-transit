"use client";

import { useEffect, useState } from "react";
import { api, type JobMatch } from "@/lib/api";

type Props = {
  value: { census: number; label: string } | null;
  onChange: (value: { census: number; label: string } | null) => void;
};

export function JobPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<JobMatch[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchJobs(query, controller.signal).then(setMatches).catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (value) {
    return (
      <div className="picked">
        <span>{value.label}</span>
        <button type="button" className="linkish" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <>
      <input
        className="field"
        type="search"
        placeholder="Frontend developer"
        aria-label="Your current or most recent job title"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length > 0 && (
        <ul className="matches">
          {matches.map((m) => (
            <li key={m.census}>
              <button
                type="button"
                onClick={() => {
                  onChange({ census: m.census, label: m.occupation });
                  setQuery("");
                  setMatches([]);
                }}
              >
                <span className="match-title">{m.matched_title}</span>
                <span className="match-occ">{m.occupation}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
