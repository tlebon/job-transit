"use client";

import { useEffect, useRef, useState } from "react";
import { api, type Openings as Result } from "@/lib/api";
import { COUNTRIES, DEFAULT_LOCATION, loadLocation, saveLocation, type Country, type Location } from "@/lib/location";

const NEAR = ["Elsewhere", "Remote", "In your city"];

/** Live postings for one stop, from the job boards behind api/openings.py. Only runs when asked. */
export function Openings({ census }: { census: number }) {
  const [where, setWhere] = useState<Location>(DEFAULT_LOCATION);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => setWhere(loadLocation()), []);
  useEffect(() => {
    controller.current?.abort();
    setResult(null);
    setError(null);
    setBusy(false);
  }, [census]);

  async function search() {
    const city = where.city.trim();
    saveLocation({ ...where, city });
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.openings(census, city, where.country, controller.current.signal));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Couldn’t search the job boards. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  const unavailable = result ? Object.entries(result.sources).filter(([, v]) => typeof v === "string") : [];

  return (
    <section className="openings">
      <h3>Openings</h3>
      <form
        className="openings-form"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          className="field"
          aria-label="City"
          placeholder="City"
          value={where.city}
          onChange={(e) => setWhere({ ...where, city: e.target.value })}
        />
        <select
          className="field"
          aria-label="Country"
          value={where.country}
          onChange={(e) => setWhere({ ...where, country: e.target.value as Country })}
        >
          {COUNTRIES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button type="submit" className="action" disabled={busy}>
          {busy ? "Searching…" : "Find openings"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <p className="q-help">
            {result.total_matched === 0
              ? "No current postings matched this job."
              : `${result.total_matched} posting${result.total_matched === 1 ? "" : "s"} matched`}
            {result.total_matched > result.openings.length ? `, showing ${result.openings.length}` : ""}. Searched for{" "}
            {result.search_terms.map((t) => `“${t}”`).join(", ")}.
          </p>
          {result.openings.length > 0 && (
            <ul className="opening-list">
              {result.openings.map((o) => (
                <li key={o.url + o.title}>
                  <a href={o.url} target="_blank" rel="noreferrer" className="opening-title">
                    {o.title}
                  </a>
                  <span className="opening-meta">
                    {o.company}
                    <span className="sep" aria-hidden>·</span>
                    {o.location}
                  </span>
                  <span className="opening-meta">
                    {NEAR[o.near]}
                    <span className="sep" aria-hidden>·</span>
                    via {o.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {unavailable.length > 0 && (
            <p className="q-help">Not searched: {unavailable.map(([name, why]) => `${name} (${String(why).replace(/^unavailable: /, "")})`).join("; ")}.</p>
          )}
        </>
      )}
      {!result && !busy && !error && (
        <p className="q-help">Live postings from Adzuna, 80,000 Hours, Arbeitnow and AI company job boards.</p>
      )}
    </section>
  );
}
