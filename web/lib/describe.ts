import type { Occupation } from "./api";

/** AI exposure as a short level plus a one-line note: share of tasks, and how that compares with similar-level jobs. */
export function aiExposure(o: Occupation) {
  if (o.ai_theoretical === null) return null;
  const share = Math.round(o.ai_theoretical * 100);
  const value = o.ai_theoretical < 0.25 ? "Low" : o.ai_theoretical < 0.5 ? "Moderate" : "High";
  const pct = o.ai_theoretical_pct_in_zone;
  const compared = pct === null ? "" : pct < 0.34 ? ", below similar jobs" : pct < 0.67 ? ", typical for similar jobs" : ", above similar jobs";
  return { value, note: `~${share}% of tasks${compared}` };
}

export function growthText(o: Occupation) {
  if (o.growth_pct === null) return null;
  const g = o.growth_pct;
  const word = g >= 8 ? "Growing fast" : g >= 3 ? "Growing" : g > -3 ? "Steady" : "Shrinking";
  return { value: `${word}, ${g >= 0 ? "+" : ""}${g.toFixed(0)}%`, note: "US jobs, 2025–35" };
}

export const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function shortTitle(title: string, max = 30) {
  const t = title.replace(/, all other$/, "").replace(/^Miscellaneous /, "");
  return t.length > max ? `${t.slice(0, max - 2)}…` : t;
}
