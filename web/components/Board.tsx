"use client";

import { useEffect, useMemo, useState } from "react";
import type { CityMap as CityMapData, Occupation, Profile, Recommendation, SortKey, Stop } from "@/lib/api";
import { CityMap } from "./CityMap";
import { OriginCard } from "./OriginCard";
import { StopList } from "./StopList";
import { StopPage } from "./StopPage";

export type Trip = { start: Occupation; legs: Occupation[] };

type Props = {
  city: CityMapData | null;
  data: Recommendation | null;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  error: string | null;
  trip: Trip | null;
  schooling: number | null;
  request: Profile;
  onContinue: (stop: Stop) => void;
  onBack: () => void;
};

const PIN_COUNT = 10;

export function Board({ city, data, sort, onSort, error, trip, schooling, request, onContinue, onBack }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const stops = useMemo(() => new Map((data?.results ?? []).map((s) => [s.census, s])), [data]);
  const pins = useMemo(() => (data?.results ?? []).slice(0, PIN_COUNT), [data]);
  const origin = data?.origin ?? null;
  const start = trip?.start ?? origin;
  const path = useMemo(
    () => (start ? [start.census, ...(trip?.legs.map((l) => l.census) ?? [])] : []),
    [start, trip],
  );

  const currentCode = trip ? trip.legs[trip.legs.length - 1].census : origin?.census ?? null;
  useEffect(() => {
    if (selected !== null && selected !== currentCode && !stops.has(selected)) setSelected(null);
  }, [stops, selected, currentCode]);

  const selectedStop = selected !== null ? stops.get(selected) : undefined;
  const baseSchooling = schooling ?? yearsFor(start?.entry_education) ?? 4;

  return (
    <section className="board">
      <div className="board-head">
        <div className="here-label">
          {trip
            ? "Your route so far"
            : origin?.kind === "your job"
              ? "You are here"
              : origin?.kind === "your work"
                ? "Closest to your work"
                : origin
                  ? "Rough placement from your answers"
                  : "Job City"}
        </div>
        <h1 className="here">
          {trip
            ? [trip.start, ...trip.legs].map((o) => o.title).join(" → ")
            : origin
              ? origin.title
              : "Where to next?"}
        </h1>
        {!trip && origin && origin.mix.length > 1 && origin.kind !== "nearest station" && (
          <p className="near-note">
            Your work looks like{" "}
            {origin.mix
              .slice(0, 4)
              .map((m) => `${m.title} (${Math.round(m.weight * 100)}%)`)
              .join(", ")}
            .
          </p>
        )}
        {!trip && data && data.evidence.length > 0 && (
          <details className="evidence">
            <summary>Why we placed you here</summary>
            <ul>
              {data.evidence.map((e, i) => (
                <li key={i}>
                  <strong>{e.placed_as}</strong>: “{e.statement}” is like “{e.task}”
                </li>
              ))}
            </ul>
            {data.tools_matched.length > 0 && <p>Tools recognised: {data.tools_matched.join(", ")}.</p>}
          </details>
        )}
        {data && data.hobby_areas.length > 0 && (
          <p className="near-note">From your hobbies we picked up: {data.hobby_areas.join(", ")}.</p>
        )}
        {!trip && origin?.kind === "nearest station" && (
          <p className="near-note">
            {origin.nearby.length ? `Also close to ${origin.nearby.slice(0, 2).join(" and ")}. ` : ""}
            Add your job or CV for routes based on real moves.
          </p>
        )}
        {trip && (
          <button type="button" className="linkish" onClick={onBack}>
            Back one stop
          </button>
        )}
        {data && <Signal confidence={data.confidence} />}
        {error && <p className="error">Couldn’t reach the planner: {error}. Check that the API is running.</p>}
      </div>

      <div className={selected !== null ? "board-body board-body-wide" : "board-body"}>
        {city ? (
          <CityMap
            city={city}
            stops={stops}
            pins={pins}
            path={path}
            selected={selected}
            hovered={hovered}
            onSelect={setSelected}
            onHover={setHovered}
            onSelectStart={() => currentCode !== null && setSelected(currentCode)}
          />
        ) : (
          <div className="city city-loading">Loading the map…</div>
        )}
        <aside className="side">
          {selected !== null && selected === currentCode && start ? (
            <OriginCard
              origin={trip ? trip.legs[trip.legs.length - 1] : start}
              request={request}
              stops={data?.results ?? []}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
          ) : selectedStop && start ? (
            <StopPage
              stop={selectedStop}
              request={request}
              start={start}
              legs={trip?.legs ?? []}
              schooling={baseSchooling}
              hasEducation={schooling !== null}
              onClose={() => setSelected(null)}
              onContinue={() => {
                onContinue(selectedStop);
                setSelected(null);
              }}
            />
          ) : pins.length ? (
            <StopList pins={pins} sort={sort} onSort={onSort} selected={selected} onSelect={setSelected} onHover={setHovered} />
          ) : (
            <Legend />
          )}
        </aside>
      </div>
      <p className="footnote">
        Nearby means similar skills. Common, occasional and rare moves come from real US job changes in the Current
        Population Survey, 2015–2021.
      </p>
    </section>
  );
}

function yearsFor(label: string | null | undefined) {
  const map: Record<string, number> = {
    "Associate's degree": 2,
    "Bachelor's degree": 4,
    "Master's degree": 6,
    "Doctoral or professional degree": 9,
    "Some college, no degree": 1,
    "Postsecondary nondegree award": 1,
  };
  return label ? (map[label] ?? 0) : null;
}

function Signal({ confidence }: { confidence: number }) {
  const bars = Math.round(confidence * 5);
  const label = ["No signal yet", "Weak signal", "Some signal", "Decent signal", "Good signal", "Strong signal"][bars];
  return (
    <div className="signal">
      <span className="signal-bars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} data-on={n <= bars} style={{ height: 4 + n * 3 }} />
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}

function Legend() {
  return (
    <section className="legend" aria-label="How to read Job City">
      <h2>Job City</h2>
      <p>Every block is an occupation. Neighbours need similar skills, and districts group jobs that draw on the same kind of knowledge.</p>
      <p>Tell us about your work and interests (Your profile, top right). Your best next stops appear as numbered pins, with routes from where you are.</p>
      <p>Click any stop to see what the job is, why it suits you, your gap and how to get there. Then continue from there to plan a second step.</p>
    </section>
  );
}
