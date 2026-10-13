import type { Occupation } from "./api";

// Rough "travel time" for a move: extra schooling the destination typically needs beyond yours, plus its usual
// on-the-job training. A display heuristic from BLS categories, not a model output.
const EDUCATION_YEARS: Record<string, number> = {
  "No formal educational credential": 0,
  "High school diploma or equivalent": 0,
  "Some college, no degree": 1,
  "Postsecondary nondegree award": 1,
  "Associate's degree": 2,
  "Bachelor's degree": 4,
  "Master's degree": 6,
  "Doctoral or professional degree": 9,
};

const TRAINING_YEARS: Record<string, number> = {
  None: 0,
  "Short-term on-the-job training": 0.1,
  "Moderate-term on-the-job training": 0.5,
  "Long-term on-the-job training": 1,
  "Internship/residency": 2,
  Apprenticeship: 3,
};

export const educationYears = (label: string | null | undefined) =>
  label && label in EDUCATION_YEARS ? EDUCATION_YEARS[label] : null;

/** Years for one hop, given the schooling (in years) the traveller already has. Returns [years, schoolingAfter]. */
export function hopYears(dest: Occupation, schooling: number): [number, number] {
  const needed = educationYears(dest.entry_education) ?? schooling;
  const study = Math.max(0, needed - schooling);
  const training = TRAINING_YEARS[dest.on_the_job_training ?? "None"] ?? 0;
  return [study + training, Math.max(schooling, needed)];
}

export function formatYears(years: number) {
  if (years < 0.5) return "Under 6 months";
  if (years < 1.5) return "About a year";
  return `About ${Math.round(years)} years`;
}
