"use client";

export const GOALS: { id: string; label: string }[] = [
  { id: "pay", label: "More pay" },
  { id: "stability", label: "A growing field" },
  { id: "less_ai", label: "Less exposed to AI" },
  { id: "passion", label: "Room for something I love" },
];

export function GoalPicker({ goals, onToggle }: { goals: string[]; onToggle: (goal: string) => void }) {
  return (
    <div className="chips" role="group" aria-label="What you want from a change">
      {GOALS.map((g) => (
        <button key={g.id} type="button" className="chip" aria-pressed={goals.includes(g.id)} onClick={() => onToggle(g.id)}>
          {g.label}
        </button>
      ))}
    </div>
  );
}
