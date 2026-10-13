"use client";

import { useEffect, useState } from "react";
import { LINES } from "@/lib/lines";

const OPEN_KEY = "job-transit-map-key-open";

/** Collapsible map key in the corner of the map. Remembers whether you left it open. */
export function MapKey() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      /* storage blocked: start closed */
    }
  }, []);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      /* not remembered */
    }
  };

  return (
    <div className="map-key" data-open={open}>
      <button type="button" className="map-key-toggle" aria-expanded={open} onClick={toggle}>
        {open ? "Hide key" : "Key"}
      </button>
      {open && (
        <div className="map-key-body">
          <ul>
            <li>
              <span className="key-here" aria-hidden="true" />
              You are here
            </li>
            <li>
              <span className="key-pin" aria-hidden="true">1</span>
              Suggested next stop
            </li>
            <li>
              <span className="key-area" aria-hidden="true" />
              Block: one job (the dot is its station)
            </li>
            <li>
              <span className="key-district" aria-hidden="true">Aa</span>
              District: a cluster of jobs needing similar skills
            </li>
          </ul>
          <p>Ring colour: job family</p>
          <ul>
            {Object.entries(LINES).map(([family, line]) => (
              <li key={family}>
                <span className="key-swatch" style={{ borderColor: line.color }} aria-hidden="true" />
                {family}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
