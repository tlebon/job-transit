"use client";

import { useEffect, useState } from "react";
import { api, type Occupation, type Profile, type Stop, type StopDetails } from "@/lib/api";
import { WhatItIs } from "./WhatItIs";
import { aiExposure, growthText, shortTitle, usd } from "@/lib/describe";
import { lineOf } from "@/lib/lines";
import { formatYears, hopYears } from "@/lib/travel";

type Props = {
  stop: Stop;
  request: Profile; // the profile the results were computed for (job = last stop of the trip)
  start: Occupation;
  legs: Occupation[];
  schooling: number;
  hasEducation: boolean;
  onContinue: () => void;
  onClose: () => void;
};

const EDUCATION_NOTE: Record<string, string> = {
  "Doctoral or professional degree": "a doctoral or professional degree (e.g. PhD, MD, JD)",
  "Master's degree": "a master’s degree",
  "Bachelor's degree": "a bachelor’s degree",
  "Associate's degree": "an associate degree (2 years)",
  "Postsecondary nondegree award": "a certificate programme",
  "Some college, no degree": "some college",
  "High school diploma or equivalent": "a high school diploma",
  "No formal educational credential": "no formal credential",
};

export function StopPage({ stop, request, start, legs, schooling, hasEducation, onContinue, onClose }: Props) {
  const [details, setDetails] = useState<StopDetails | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    api.stop(request, stop.census, controller.signal).then(setDetails).catch(() => {});
    return () => controller.abort();
  }, [stop.census, request]);

  const line = lineOf(stop.family);
  const route = [...legs, stop];
  let years = 0;
  let school = schooling;
  for (const leg of route) {
    const [hop, after] = hopYears(leg, school);
    years += hop;
    school = after;
  }
  const ai = aiExposure(stop);
  const growth = growthText(stop);
  const reach = details?.reach;

  return (
    <article className="stop-page" aria-label={stop.title}>
      <header className="route-head">
        <span className="line-badge" style={{ background: line.color }} title={stop.family ?? ""}>
          {line.code}
        </span>
        <h2 className="route-title">{stop.title}</h2>
        <button type="button" className="icon-button" aria-label="Back to the list" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="route-path">{[start, ...route].map((o) => shortTitle(o.title)).join("  →  ")}</p>

      <section>
        <h3>What it is</h3>
        <WhatItIs occupation={stop} details={details} />
      </section>

      <section>
        <h3>Why you</h3>
        <dl className="route-facts">
          {reach && (
            <div>
              <dt>How common</dt>
              <dd>
                {reach.label}
                <span className="fact-sub">
                  {ordinal(reach.rank)} most common{reach.from ? ` from ${shortTitle(reach.from, 28).toLowerCase()}` : ""}
                </span>
              </dd>
            </div>
          )}
          {details?.skill_match !== undefined && (
            <div>
              <dt>Skill overlap</dt>
              <dd>{Math.round(((details.skill_match + 1) / 2) * 100)}%</dd>
            </div>
          )}
          {stop.appeal_pct !== null && (
            <div>
              <dt>Interest fit</dt>
              <dd>Top {Math.max(1, Math.round((1 - stop.appeal_pct) * 100))}%</dd>
            </div>
          )}
        </dl>
        {details?.transfers && details.transfers.length > 0 && (
          <p className="q-help">You already bring: {details.transfers.map((t) => t.item).join(", ")}.</p>
        )}
      </section>

      {details?.gaps && (
        <section>
          <h3>Your gap</h3>
          {details.gaps.length === 0 ? (
            <p>No clear skill gaps compared with your profile.</p>
          ) : (
            <ul className="gaps">
              {details.gaps.map((g) => (
                <li key={g.item}>
                  <span>{g.item}</span>
                  <span className="gap-bar" aria-label={`You ${g.you} of 5, the job needs ${g.needed}`}>
                    <span className="gap-you" style={{ width: `${(g.you / 5) * 100}%` }} />
                    <span className="gap-need" style={{ left: `${(g.needed / 5) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="q-help">Filled: you. Line: what the job needs (1–5).</p>
        </section>
      )}

      <section>
        <h3>How to get there</h3>
        <dl className="route-facts">
          <div>
            <dt>Rough time</dt>
            <dd>{formatYears(years)}</dd>
          </div>
          {stop.entry_education && (
            <div>
              <dt>Typical entry</dt>
              <dd>{stop.entry_education}</dd>
            </div>
          )}
          {stop.on_the_job_training && stop.on_the_job_training !== "None" && (
            <div>
              <dt>Training on the job</dt>
              <dd>{stop.on_the_job_training}</dd>
            </div>
          )}
          {stop.work_experience && stop.work_experience !== "None" && (
            <div>
              <dt>Related experience</dt>
              <dd>{stop.work_experience}</dd>
            </div>
          )}
        </dl>
        <p className="q-help">
          Rough guide: schooling{stop.entry_education ? ` (${EDUCATION_NOTE[stop.entry_education] ?? stop.entry_education})` : ""} beyond{" "}
          {hasEducation ? "yours" : "your current job’s"}, plus usual training.
        </p>
      </section>

      <section>
        <h3>Is it a good bet?</h3>
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
          {stop.median_wage !== null && (
            <div>
              <dt>Median pay (US)</dt>
              <dd>
                {usd.format(stop.median_wage)}
                {details?.pay_change_pct !== undefined && details.from_occupation && Math.round(details.pay_change_pct) !== 0 && (
                  <span className="fact-sub">
                    {Math.abs(Math.round(details.pay_change_pct))}% {details.pay_change_pct > 0 ? "more" : "less"} than{" "}
                    {shortTitle(details.from_occupation.title, 32).toLowerCase()}
                  </span>
                )}
              </dd>
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
          {stop.bls_ai_exposure && (
            <div>
              <dt>AI exposure, BLS rating</dt>
              <dd>
                {stop.bls_ai_exposure}
                <span className="fact-sub">Theory plus real Claude and Copilot use</span>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <div className="route-actions">
        <button type="button" className="action" onClick={onContinue}>
          Continue from here
        </button>
        <span className="q-help">See where you could go after this stop.</span>
      </div>
    </article>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
