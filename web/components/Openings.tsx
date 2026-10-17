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
  const collecting = unavailable.filter(([, why]) => String(why).includes("still collecting")).map(([name]) => name);

  // A source still collecting (its first search for this job ran past the time limit): look again once, shortly.
  const rechecked = useRef(false);
  useEffect(() => {
    rechecked.current = false;
  }, [census]);
  useEffect(() => {
    if (!collecting.length || rechecked.current) return;
    rechecked.current = true;
    const timer = setTimeout(search, 20000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

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
              : `${result.total_matched} posting${result.total_matched === 1 ? "" : "s"} matched` +
                (result.by_place
                  ? ` (${result.by_place.in_city} in ${result.city || "your city"}, ${result.by_place.remote} remote, ${result.by_place.elsewhere} elsewhere)`
                  : "")}
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
                    {o.us_only ? "Remote, US only" : NEAR[o.near]}
                    <span className="sep" aria-hidden>·</span>
                    via {o.source}
                  </span>
                  {(o.pay || o.career_changer || o.home_office || o.needs_german || o.language === "German") && (
                    <span className="opening-flags">
                      {o.pay && <span className="opening-pay">{o.pay}</span>}
                      {o.career_changer && <span className="badge badge-good">Open to career changers</span>}
                      {o.home_office && <span className="badge">Home office possible</span>}
                      {o.needs_german ? (
                        <span className="badge">Asks for good German</span>
                      ) : (
                        o.language === "German" && <span className="badge">Written in German</span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.updated && Object.keys(result.updated).length > 0 && (
            <p className="q-help">
              Updated:{" "}
              {Object.entries(result.updated)
                .map(([name, at]) => `${name} ${ago(at)}`)
                .join(" · ")}
            </p>
          )}
          {collecting.length > 0 && !rechecked.current && (
            <p className="q-help">Still collecting from {collecting.join(" and ")}. Checking again in a moment…</p>
          )}
          {unavailable.length > 0 && (
            <p className="q-help">Not searched: {unavailable.map(([name, why]) => `${name} (${String(why).replace(/^unavailable: /, "")})`).join("; ")}.</p>
          )}
        </>
      )}
      {!result && !busy && !error && (
        <p className="q-help">Live postings from Adzuna, the Bundesagentur für Arbeit, 80,000 Hours, Arbeitnow and AI company job boards.</p>
      )}
    </section>
  );
}

function ago(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
