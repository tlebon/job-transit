"use client";

import type { SortKey, Stop } from "@/lib/api";
import { lineOf } from "@/lib/lines";

type Props = {
  pins: Stop[];
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  selected: number | null;
  onSelect: (census: number) => void;
  onHover: (census: number | null) => void;
};

// "Next steps": real moves, nudged by interests and goals. "Toward what you love": interest matches, often bigger jumps.
const SORTS: { key: SortKey; label: string }[] = [
  { key: "best", label: "Next steps" },
  { key: "appealing", label: "Toward what you love" },
];

export function StopList({ pins, sort, onSort, selected, onSelect, onHover }: Props) {
  if (pins.length === 0) return null;
  return (
    <section className="stop-list" aria-label="Next stops">
      <div className="sorts" role="group" aria-label="Sort next stops">
        {SORTS.map((s) => (
          <button key={s.key} type="button" aria-pressed={sort === s.key} onClick={() => onSort(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <ol>
        {pins.map((p, i) => (
          <li key={p.census}>
            <button
              type="button"
              aria-current={selected === p.census}
              onClick={() => onSelect(p.census)}
              onPointerEnter={() => onHover(p.census)}
              onPointerLeave={() => onHover(null)}
            >
              <span className="list-num" style={{ borderColor: lineOf(p.family).color }}>
                {i + 1}
              </span>
              <span className="list-title">
                {p.title}
                {p.reach_label && <span className="list-sub">{p.reach_label}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
