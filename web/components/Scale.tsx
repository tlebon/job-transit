"use client";

type Props = {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  low: string;
  high: string;
};

/** 1-5 rating; clicking the selected value again clears it (skips the question). */
export function Scale({ label, value, onChange, low, high }: Props) {
  return (
    <div role="group" aria-label={label}>
      <div className="scale">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={value === n}
            aria-label={`${n}${n === 1 ? ` (${low})` : n === 5 ? ` (${high})` : ""}`}
            onClick={() => onChange(value === n ? undefined : n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="scale-ends">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}
