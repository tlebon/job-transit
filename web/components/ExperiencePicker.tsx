"use client";

// Bands like job boards use; the value stored is a representative number of years.
const BANDS: { label: string; years: number; min: number; max: number }[] = [
  { label: "Starting out", years: 0.5, min: 0, max: 1 },
  { label: "1–4 years", years: 2.5, min: 1, max: 5 },
  { label: "5–9 years", years: 7, min: 5, max: 10 },
  { label: "10+ years", years: 12, min: 10, max: Infinity },
];

export function ExperiencePicker({ years, onChange }: { years: number | null; onChange: (years: number | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Years of work experience">
      {BANDS.map((b) => {
        const on = years !== null && years >= b.min && years < b.max;
        return (
          <button key={b.label} type="button" className="chip" aria-pressed={on} onClick={() => onChange(on ? null : b.years)}>
            {b.label}
          </button>
        );
      })}
    </div>
  );
}
