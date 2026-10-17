"use client";

import { useEffect, useState } from "react";
import { api, type Occupation, type Profile, type Stop, type StopDetails } from "@/lib/api";
import { WhatItIs } from "./WhatItIs";
import { aiExposure, growthText, usd } from "@/lib/describe";

type Props = {
  origin: Occupation;
  request: Profile;
  stops: Stop[];
  onSelect: (census: number) => void;
  onClose: () => void;
};

/** "You are here": what your current station is, how it's doing, and where people from it usually go. */
export function OriginCard({ origin, request, stops, onSelect, onClose }: Props) {
  const [details, setDetails] = useState<StopDetails | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.stop(request, origin.census, controller.signal).then(setDetails).catch(() => {});
    return () => controller.abort();
  }, [origin.census, request]);

  const common = [...stops].filter((s) => s.reach_share !== null).sort((a, b) => (b.reach_share ?? 0) - (a.reach_share ?? 0)).slice(0, 5);
  const ai = aiExposure(origin);
  const growth = growthText(origin);

  return (
    <article className="stop-page" aria-label={`You are here: ${origin.title}`}>
      <header className="route-head">
        <span className="here-dot" aria-hidden="true" />
        <h2 className="route-title">{origin.title}</h2>
        <button type="button" className="icon-button" aria-label="Back to the list" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="route-path">You are here</p>
      <section>
        <h3>What it is</h3>
        <WhatItIs occupation={origin} details={details} showTasks={false} />
      </section>
      <section>
        <h3>How it’s doing</h3>
        <dl className="route-facts">
          {growth && (
            <div>
              <dt>Job growth</dt>
              <dd>
                {growth.value}
                <span className="fact-sub">{growth.note}</span>
              </dd>
            </div>
          )}
          {origin.median_wage !== null && (
            <div>
              <dt>Median pay (US)</dt>
              <dd>{usd.format(origin.median_wage)}</dd>
            </div>
          )}
          {ai && (
            <div>
              <dt>AI exposure, in theory</dt>
              <dd>
                {ai.value}
                <span className="fact-sub">{ai.note}</span>
              </dd>
            </div>
          )}
          {origin.bls_ai_exposure && (
            <div>
              <dt>AI exposure, US labor bureau (BLS)</dt>
              <dd>
                {origin.bls_ai_exposure}
                <span className="fact-sub">Theory plus real Claude and Copilot use</span>
              </dd>
            </div>
          )}
        </dl>
      </section>
      {common.length > 0 && (
        <section>
          <h3>Where people from here usually go</h3>
          <ol className="common-moves">
            {common.map((s) => (
              <li key={s.census}>
                <button type="button" className="linkish" onClick={() => onSelect(s.census)}>
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
