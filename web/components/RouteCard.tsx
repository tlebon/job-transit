"use client";

import type { Occupation, Stop } from "@/lib/api";
import { lineOf } from "@/lib/lines";
import { formatYears, hopYears } from "@/lib/travel";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Props = {
  stop: Stop;
  start: Occupation;
  legs: Occupation[]; // stops already on the journey, before this one
  schooling: number; // years of schooling the traveller starts with
  onContinue: () => void;
  onClose: () => void;
};

export function RouteCard({ stop, start, legs, schooling, onContinue, onClose }: Props) {
  const route = [...legs, stop];
  let years = 0;
  let school = schooling;
  for (const leg of route) {
    const [hop, after] = hopYears(leg, school);
    years += hop;
    school = after;
  }
  const families = [start, ...route].map((o) => o.family);
  const changes = families.slice(1).filter((f, i) => f !== families[i]).length;
  const line = lineOf(stop.family);

  return (
    <section className="route-card" aria-label={`Route to ${stop.title}`}>
      <header className="route-head">
        <span className="line-badge" style={{ background: line.color }}>
          {line.code}
        </span>
        <h2 className="route-title">{stop.title}</h2>
        <button type="button" className="icon-button" aria-label="Back to the list" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="route-path">
        {[start, ...route].map((o) => shortTitle(o.title)).join("  →  ")}
      </p>
      <dl className="route-facts">
        <div>
          <dt>Travel time</dt>
          <dd>{formatYears(years)}</dd>
        </div>
        <div>
          <dt>Line changes</dt>
          <dd>{changes === 0 ? "None" : changes}</dd>
        </div>
        {stop.reach_share !== null && (
          <div>
            <dt>Riders on this route</dt>
            <dd>{(stop.reach_share * 100).toFixed(1)} in 100</dd>
          </div>
        )}
        {stop.appeal_pct !== null && (
          <div>
            <dt>Interest fit</dt>
            <dd>Top {Math.max(1, Math.round((1 - stop.appeal_pct) * 100))}%</dd>
          </div>
        )}
        {stop.growth_pct !== null && (
          <div>
            <dt>Jobs by 2035</dt>
            <dd className={stop.growth_pct >= 0 ? "up" : "down"}>
              {stop.growth_pct >= 0 ? "+" : ""}
              {stop.growth_pct.toFixed(1)}%
            </dd>
          </div>
        )}
        {stop.median_wage !== null && (
          <div>
            <dt>Median pay</dt>
            <dd>{usd.format(stop.median_wage)}</dd>
          </div>
        )}
        {stop.entry_education && (
          <div>
            <dt>Typical entry</dt>
            <dd>{stop.entry_education}</dd>
          </div>
        )}
        {stop.ai_theoretical_pct_in_zone !== null && (
          <div>
            <dt>AI exposure</dt>
            <dd>
              Higher than {Math.round(stop.ai_theoretical_pct_in_zone * 100)}% of similar-level jobs
            </dd>
          </div>
        )}
      </dl>
      <div className="route-actions">
        <button type="button" className="action" onClick={onContinue}>
          Continue from here
        </button>
        <button type="button" className="linkish" onClick={onClose}>
          Back to all stops
        </button>
      </div>
    </section>
  );
}

function shortTitle(title: string) {
  const t = title.replace(/, all other$/, "").replace(/^Miscellaneous /, "");
  return t.length > 30 ? `${t.slice(0, 28)}…` : t;
}
