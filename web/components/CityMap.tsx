"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CityMap as CityMapData, Stop } from "@/lib/api";
import { lineOf } from "@/lib/lines";

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
};

export function CityMap({ city, stops, pins, path, selected, hovered, onSelect, onHover }: Props) {
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
    if (!el) return;
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
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ x: cx - w / 2, y: cy - h / 2, w: Math.min(w, FULL.w * 1.2), h: Math.min(h, FULL.h * 1.2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const zoomedIn = FULL.w / view.w > 1.6;
  const highlight = hovered ?? selected;
  const start = path.length ? station.get(path[0]) : undefined;
  const r = (base: number) => base * scale;

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
        <g className="district-labels">
          {city.districts.map((d) => (
            <text key={d.id} x={d.x} y={d.y} className="district-label" fontSize={r(zoomedIn ? 15 : 13)} strokeWidth={r(5)}>
              {d.name}
            </text>
          ))}
        </g>
        <g className="stations">
          {city.stations.map((s) =>
            pinSet.has(s.census) ? null : (
              <circle
                key={s.census}
                data-station
                cx={s.x}
                cy={s.y}
                r={r(highlight === s.census ? 5 : zoomedIn ? 3 : 1.9)}
                stroke={lineOf(s.family).color}
                strokeWidth={r(zoomedIn ? 1.6 : 1.2)}
                className="station"
                onClick={() => onSelect(s.census)}
                onPointerEnter={() => onHover(s.census)}
                onPointerLeave={() => onHover(null)}
              >
                <title>{s.title}</title>
              </circle>
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
          {pins.map((p, i) => {
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
                {(on || i < 5) && (
                  <text x={s.x + r(20)} y={s.y} className="pin-label" fontSize={r(14)}>
                    {shorten(s.title)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        {path.slice(1).map((c) => {
          const s = station.get(c);
          return s ? <circle key={`via-${c}`} cx={s.x} cy={s.y} r={r(8)} className="via" /> : null;
        })}
        {start && (
          <g className="here" transform={`translate(${start.x} ${start.y}) scale(${scale})`} pointerEvents="none">
            <circle r={16} className="here-ring" />
            <rect x={-11} y={-3.5} width={22} height={7} rx={1} className="here-bar" />
            <text x={24} y={-18} className="here-text">
              {path.length > 1 ? "Start" : "You are here"}
            </text>
          </g>
        )}
        {hovered !== null && !pinSet.has(hovered) && station.get(hovered) && (
          <text
            x={station.get(hovered)!.x + r(10)}
            y={station.get(hovered)!.y - r(10)}
            className="pin-label"
            fontSize={r(14)}
          >
            {shorten(station.get(hovered)!.title)}
          </text>
        )}
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
      {stops.size === 0 && <p className="city-hint">Tell us a little on the left and your next stops appear as pins.</p>}
    </div>
  );
}

function shorten(title: string) {
  const t = title.replace(/, all other$/, "").replace(/^Miscellaneous /, "");
  return t.length > 34 ? `${t.slice(0, 32)}…` : t;
}
