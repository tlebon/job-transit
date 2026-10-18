"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CityMap as CityMapData, Stop } from "@/lib/api";
import { lineOf } from "@/lib/lines";
import { MapKey } from "./MapKey";
import { AROUND, circleBox, placeLabels, type Box, type LabelRequest } from "@/lib/labels";

// Muted hues for the 14 districts, spread around the colour wheel.
const DISTRICT_HUES = [205, 35, 150, 265, 15, 180, 95, 320, 55, 240, 125, 0, 285, 75];

const WIDTH = 1000;
const HEIGHT = 700;
const PAD = 40;

type View = { x: number; y: number; w: number; h: number };
const FULL: View = { x: -PAD, y: -PAD, w: WIDTH + 2 * PAD, h: HEIGHT + 2 * PAD };

type Props = {
  city: CityMapData;
  stops: Map<number, Stop>;
  pins: Stop[];
  path: number[]; // census codes from the start station to the current end of the journey
  selected: number | null;
  hovered: number | null;
  onSelect: (census: number) => void;
  onHover: (census: number | null) => void;
  onSelectStart: () => void;
  wheelZoom?: boolean; // off in the side panel's mini-map, so scrolling the panel doesn't zoom the map
};

export function CityMap({ city, stops, pins, path, selected, hovered, onSelect, onHover, onSelectStart, wheelZoom = true }: Props) {
  const [view, setView] = useState<View>(FULL);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  const station = useMemo(() => new Map(city.stations.map((s) => [s.census, s])), [city]);
  const pinSet = useMemo(() => new Set(pins.map((p) => p.census)), [pins]);
  const [pxWidth, setPxWidth] = useState(800);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setPxWidth(entry.contentRect.width || 800));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = view.w / pxWidth; // map units per screen pixel: marks keep a constant on-screen size

  // route: journey path plus the selected stop
  const route = useMemo(() => {
    const codes = selected !== null && selected !== path[path.length - 1] ? [...path, selected] : path;
    return codes.map((c) => station.get(c)).filter(Boolean) as typeof city.stations;
  }, [path, selected, station, city]);
  const routeKey = route.map((s) => s.census).join("-");

  const toMap = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: view.x + ((clientX - rect.left) / rect.width) * view.w, y: view.y + ((clientY - rect.top) / rect.height) * view.h };
  };

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const w = Math.min(FULL.w, Math.max(FULL.w / 8, v.w * factor));
      const h = w * (FULL.h / FULL.w);
      return { x: cx - ((cx - v.x) / v.w) * w, y: cy - ((cy - v.y) / v.h) * h, w, h };
    });

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !wheelZoom) return; // the page scrolls past it instead (the zoom buttons still work)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toMap(e.clientX, e.clientY);
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as Element).closest("[data-station]")) return;
    drag.current = { x: e.clientX, y: e.clientY, view };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const d = drag.current;
    setView({
      ...d.view,
      x: d.view.x - ((e.clientX - d.x) / rect.width) * d.view.w,
      y: d.view.y - ((e.clientY - d.y) / rect.height) * d.view.h,
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // When the suggestions change, frame the start, the journey and the pins.
  const fitKey = [...path, ...pins.map((p) => p.census)].join("-");
  useEffect(() => {
    const pts = [...path, ...pins.map((p) => p.census)].map((c) => station.get(c)).filter(Boolean) as typeof city.stations;
    if (pts.length < 2) {
      setView(FULL);
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const margin = 70;
    let w = Math.max(...xs) - Math.min(...xs) + 2 * margin;
    let h = Math.max(...ys) - Math.min(...ys) + 2 * margin;
    const ratio = FULL.w / FULL.h;
    if (w / h < ratio) w = h * ratio;
    else h = w / ratio;
    w = Math.max(w, FULL.w / 4);
    h = w / ratio;
    // Barely tighter than the whole city just looks like an accidental zoom: show the whole city instead.
    if (w > FULL.w * 0.7) {
      setView(FULL);
      return;
    }
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ x: cx - w / 2, y: cy - h / 2, w: Math.min(w, FULL.w * 1.2), h: Math.min(h, FULL.h * 1.2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const zoomedIn = FULL.w / view.w > 1.6;
  const highlight = hovered ?? selected;
  const start = path.length ? station.get(path[0]) : undefined;
  const r = (base: number) => base * scale;

  // One pass decides which labels fit: "you are here" first, then the stop you're looking at,
  // then the top five pins, then district names. Anything that would overlap is left out.
  const labels = useMemo(() => {
    const obstacles: Box[] = [];
    pins.forEach((p) => {
      const s = station.get(p.census);
      if (s) obstacles.push(circleBox(s.x, s.y, 15 * scale));
    });
    if (start) obstacles.push(circleBox(start.x, start.y, 17 * scale));

    const around = AROUND;
    const requests: LabelRequest[] = [];
    if (start) {
      requests.push({
        id: "here", kind: "here", text: path.length > 1 ? "Start" : "You are here",
        x: start.x, y: start.y, size: 15 * scale, gap: 22 * scale, charWidth: 0.66, sides: around, reaches: [1, 1.6], required: true,
      });
    }
    const focus = highlight !== null ? station.get(highlight) : undefined;
    if (focus && focus.census !== start?.census) {
      requests.push({
        id: `focus-${focus.census}`, kind: "pin", text: shorten(focus.title),
        x: focus.x, y: focus.y, size: 14 * scale, gap: (pinSet.has(focus.census) ? 20 : 9) * scale,
        charWidth: 0.62, sides: around, reaches: [1, 1.6], required: true,
      });
    }
    const pinRequests: LabelRequest[] = [];
    pins.slice(0, 5).forEach((p) => {
      const s = station.get(p.census);
      if (!s || s.census === focus?.census) return;
      pinRequests.push({
        id: `pin-${s.census}`, kind: "pin", text: shorten(s.title),
        x: s.x, y: s.y, size: 14 * scale, gap: 20 * scale, charWidth: 0.62, sides: around,
      });
    });
    // District names: at the district's centre if it's free and on screen, otherwise at the
    // nearest visible block inside the district, so every district you can see gets its name.
    // Districts you're in or have suggestions in are named before the pin labels, the rest after.
    const homeDistricts = new Set(
      [start?.district, ...pins.map((p) => station.get(p.census)?.district)].filter((d) => d !== undefined),
    );
    const homeRequests: LabelRequest[] = [];
    const otherRequests: LabelRequest[] = [];
    const inView = (p: { x: number; y: number }) =>
      p.x > view.x + 60 * scale && p.x < view.x + view.w - 60 * scale && p.y > view.y + 20 * scale && p.y < view.y + view.h - 20 * scale;
    city.districts.forEach((d) => {
      const spots = city.stations
        .filter((s) => s.district === d.id && inView(s))
        .sort((a, b) => Math.hypot(a.x - d.x, a.y - d.y) - Math.hypot(b.x - d.x, b.y - d.y));
      if (!inView(d) && spots.length === 0) return;
      (homeDistricts.has(d.id) ? homeRequests : otherRequests).push({
        id: `district-${d.id}`, kind: "district", text: d.name,
        x: inView(d) ? d.x : spots[0].x, y: inView(d) ? d.y : spots[0].y, spots,
        size: (zoomedIn ? 15 : 13) * scale, gap: 0, charWidth: 0.7, sides: ["center"],
      });
    });
    const visible = { x0: view.x, y0: view.y, x1: view.x + view.w, y1: view.y + view.h };
    return placeLabels([...requests, ...homeRequests, ...pinRequests, ...otherRequests], obstacles, visible);
  }, [pins, station, start, path.length, highlight, pinSet, city, scale, zoomedIn, view]);

  return (
    <div className="city">
      <svg
        ref={svgRef}
        className="city-svg"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="img"
        aria-label="Job City map. Each dot is an occupation; nearby dots need similar skills."
      >
        <g className="blocks">
          {city.stations.map((st) =>
            (city.blocks[String(st.census)] ?? []).map((ring, i) => (
              <polygon
                key={`${st.census}-${i}`}
                points={ring.map((p) => p.join(",")).join(" ")}
                className="block"
                style={{ ["--h" as string]: DISTRICT_HUES[st.district % DISTRICT_HUES.length] }}
              />
            )),
          )}
        </g>
        <g className="district-edges">
          {city.districts.flatMap((d) =>
            d.outline.map((ring, i) => (
              <polygon key={`${d.id}-${i}`} points={ring.map((p) => p.join(",")).join(" ")} className="district-edge" />
            )),
          )}
        </g>
        <g className="stations">
          {city.stations.map((s) =>
            pinSet.has(s.census) ? null : (
              <g
                key={s.census}
                data-station
                className="station"
                onClick={() => onSelect(s.census)}
                onPointerEnter={() => onHover(s.census)}
                onPointerLeave={() => onHover(null)}
              >
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={r(highlight === s.census ? 6 : zoomedIn ? 4 : 2.8)}
                  stroke={lineOf(s.family).color}
                  strokeWidth={r(zoomedIn ? 2 : 1.6)}
                  className="station-dot"
                />
                {/* invisible, larger target so the small dots are easy to hover and click */}
                <circle cx={s.x} cy={s.y} r={r(6)} className="station-hit" />
                <title>{s.title}</title>
              </g>
            ),
          )}
        </g>
        {route.length > 1 && (
          <g key={routeKey} className="route">
            <polyline points={route.map((s) => `${s.x},${s.y}`).join(" ")} className="route-casing" strokeWidth={r(11)} />
            <polyline
              points={route.map((s) => `${s.x},${s.y}`).join(" ")}
              className="route-line"
              strokeWidth={r(6)}
              pathLength={1}
            />
          </g>
        )}
        <g className="pins">
          {pins.map((p, i) => ({ p, i })).reverse().map(({ p, i }) => {
            const s = station.get(p.census);
            if (!s) return null;
            const on = selected === p.census || hovered === p.census;
            return (
              <g
                key={p.census}
                data-station
                className="pin"
                tabIndex={0}
                role="button"
                aria-label={`${s.title}, suggestion ${i + 1}`}
                onClick={() => onSelect(p.census)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(p.census)}
                onPointerEnter={() => onHover(p.census)}
                onPointerLeave={() => onHover(null)}
              >
                <circle cx={s.x} cy={s.y} r={r(on ? 15 : 12)} className="pin-ring" stroke={lineOf(s.family).color} strokeWidth={r(5)} />
                <text x={s.x} y={s.y} className="pin-number" fontSize={r(12)}>
                  {i + 1}
                </text>
              </g>
            );
          })}
        </g>
        {path.slice(1).map((c) => {
          const s = station.get(c);
          return s ? <circle key={`via-${c}`} cx={s.x} cy={s.y} r={r(8)} className="via" /> : null;
        })}
        {start && (
          <g
            className="here-marker"
            data-station
            transform={`translate(${start.x} ${start.y}) scale(${scale})`}
            role="button"
            tabIndex={0}
            aria-label="Your current station"
            onClick={onSelectStart}
            onKeyDown={(e) => e.key === "Enter" && onSelectStart()}
          >
            <circle r={20} className="here-halo" />
            <circle r={11} className="here-edge" />
            <circle r={9} className="here-dot-map" />
          </g>
        )}
        <g className="labels">
          {labels.map((l) => (
            <text
              key={l.id}
              x={l.x}
              y={l.y}
              className={l.kind === "here" ? "here-text" : l.kind === "district" ? "district-label" : "pin-label"}
              fontSize={l.size}
              textAnchor={l.anchor}
              strokeWidth={r(l.kind === "district" ? 5 : 4)}
            >
              {l.text}
            </text>
          ))}
        </g>
      </svg>
      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1 / 1.5, view.x + view.w / 2, view.y + view.h / 2)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1.5, view.x + view.w / 2, view.y + view.h / 2)}>
          −
        </button>
        <button type="button" aria-label="Show the whole city" onClick={() => setView(FULL)}>
          ⤢
        </button>
      </div>
      <MapKey />
      {stops.size === 0 && <p className="city-hint">Tell us a little on the left and your next jobs appear as pins.</p>}
    </div>
  );
}

function shorten(title: string) {
  const t = title.replace(/, all other$/, "").replace(/^Miscellaneous /, "");
  return t.length > 34 ? `${t.slice(0, 32)}…` : t;
}
