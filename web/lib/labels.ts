// Greedy label placement for the map: labels are tried in priority order, each at a few
// positions around its anchor, and dropped if every position would overlap something
// already drawn. Everything is in map units, so it works at any zoom.

export type Box = { x0: number; y0: number; x1: number; y1: number };
type Side = "right" | "left" | "above" | "below" | "upper-right" | "lower-right" | "upper-left" | "lower-left" | "center";

/** Every side around a point, best first. */
export const AROUND: Side[] = ["right", "left", "upper-right", "lower-right", "above", "below", "upper-left", "lower-left"];

export type LabelRequest = {
  id: string;
  kind: "here" | "pin" | "district";
  text: string;
  x: number;
  y: number;
  size: number; // font size, map units
  gap: number; // distance from the anchor to the label, map units
  charWidth: number; // rough glyph width as a share of the font size
  sides: Side[];
  spots?: { x: number; y: number }[]; // extra anchor points to try, in order, after (x, y)
  reaches?: number[]; // multiples of gap to try; default just 1
  required?: boolean; // always drawn (at its first side if nothing fits)
};

export type PlacedLabel = {
  id: string;
  kind: LabelRequest["kind"];
  text: string;
  x: number;
  y: number;
  size: number;
  anchor: "start" | "middle" | "end";
};

export function circleBox(x: number, y: number, radius: number): Box {
  return { x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius };
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function candidate(req: LabelRequest, side: Side, reach = 1, at = { x: req.x, y: req.y }): { box: Box; label: PlacedLabel } {
  const w = req.text.length * req.size * req.charWidth;
  const h = req.size * 1.15;
  const pad = req.size * 0.2;
  const gap = req.gap * reach;
  let x = at.x;
  let y = at.y;
  let anchor: PlacedLabel["anchor"] = "middle";
  let x0 = x - w / 2;
  if (side.endsWith("right")) {
    x += side === "right" ? gap : gap * 0.6;
    anchor = "start";
    x0 = x;
  } else if (side.endsWith("left")) {
    x -= side === "left" ? gap : gap * 0.6;
    anchor = "end";
    x0 = x - w;
  }
  if (side === "above" || side.startsWith("upper")) y -= (side === "above" ? gap : gap * 0.6) + h / 2;
  if (side === "below" || side.startsWith("lower")) y += (side === "below" ? gap : gap * 0.6) + h / 2;
  const box = { x0: x0 - pad, y0: y - h / 2 - pad, x1: x0 + w + pad, y1: y + h / 2 + pad };
  return { box, label: { id: req.id, kind: req.kind, text: req.text, x, y, size: req.size, anchor } };
}

export function placeLabels(requests: LabelRequest[], obstacles: Box[]): PlacedLabel[] {
  const taken = [...obstacles];
  const placed: PlacedLabel[] = [];
  for (const req of requests) {
    // Try each anchor point, each side, each distance. Labels that must be drawn take the
    // spot with the fewest collisions if nothing is free.
    const points = [{ x: req.x, y: req.y }, ...(req.spots ?? [])];
    const options = points.flatMap((at) =>
      (req.reaches ?? [1]).flatMap((reach) => req.sides.map((side) => candidate(req, side, reach, at))),
    );
    if (options.length === 0) continue;
    let chosen = options.find((c) => !taken.some((b) => overlaps(b, c.box))) ?? null;
    if (!chosen && req.required) {
      const clashes = (c: (typeof options)[number]) => taken.filter((b) => overlaps(b, c.box)).length;
      chosen = options.reduce((best, c) => (clashes(c) < clashes(best) ? c : best));
    }
    if (chosen) {
      taken.push(chosen.box);
      placed.push(chosen.label);
    }
  }
  return placed;
}
