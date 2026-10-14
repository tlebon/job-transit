"use client";

import type { Chip } from "@/lib/api";

// O*NET's six interest types, in plain words.
const GROUP_NAMES: Record<string, string> = {
  Realistic: "Hands-on and outdoors",
  Investigative: "Science and analysis",
  Artistic: "Creative",
  Social: "People and helping",
  Enterprising: "Business and leading",
  Conventional: "Organising and detail",
};

type Props = {
  chips: Chip[];
  order: string[];
  picked: string[];
  onToggle: (chip: string) => void;
};

/** Interest topics grouped by the kind of work they lean towards, so 41 chips scan as six short rows. */
export function ChipGroups({ chips, order, picked, onToggle }: Props) {
  const groups = [...order, null].map((type) => ({
    type,
    chips: chips.filter((c) => (type === null ? !c.riasec || !order.includes(c.riasec) : c.riasec === type)),
  }));
  return (
    <div className="chip-groups">
      {groups
        .filter((g) => g.chips.length > 0)
        .map((g) => (
          <div key={g.type ?? "other"} className="chip-group" role="group" aria-label={g.type ? GROUP_NAMES[g.type] ?? g.type : "Other"}>
            <span className="chip-group-name">{g.type ? GROUP_NAMES[g.type] ?? g.type : "Other"}</span>
            <div className="chips">
              {g.chips.map((chip) => (
                <button
                  key={chip.name}
                  type="button"
                  className="chip"
                  aria-pressed={picked.includes(chip.name)}
                  title={chip.description}
                  onClick={() => onToggle(chip.name)}
                >
                  {chip.name}
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
