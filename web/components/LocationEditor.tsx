"use client";

import { useState } from "react";
import { COUNTRIES, MAX_PLACES, placeName, type Country, type Search } from "@/lib/location";

type Props = { search: Search; onChange: (search: Search) => void };

/** Where they're looking for work: places to add and remove, and whether remote work is fine. Any change confirms it. */
export function LocationEditor({ search, onChange }: Props) {
  const [city, setCity] = useState("");
  const [country, setCountry] = useState<Country>(search.places[0]?.country ?? "de");
  const set = (change: Partial<Search>) => onChange({ ...search, ...change, confirmed: true });

  const add = () => {
    const name = city.trim();
    if (!name) return;
    const exists = search.places.some((p) => p.city.toLowerCase() === name.toLowerCase() && p.country === country);
    const places = search.confirmed ? search.places : []; // the default guess makes way for what they type
    if (!exists) set({ places: [...places, { city: name, country }].slice(0, MAX_PLACES) });
    setCity("");
  };

  return (
    <div className="location-editor">
      {search.places.length > 0 && (
        <ul className="place-list">
          {search.places.map((p) => (
            <li key={`${p.city}|${p.country}`}>
              <span>
                {placeName(p)}
                {!search.confirmed && <span className="q-help"> (a guess)</span>}
              </span>
              {search.places.length > 1 && ( // always keep one place: remote-only still needs a country and a city
                <button
                  type="button"
                  className="linkish"
                  aria-label={`Remove ${p.city}`}
                  onClick={() => set({ places: search.places.filter((x) => x !== p) })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!search.confirmed && (
        <button type="button" className="linkish" onClick={() => set({})}>
          Yes, {search.places.map((p) => p.city).join(" and ")} is right
        </button>
      )}
      <form
        className="place-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="field"
          aria-label="City"
          placeholder={search.confirmed && search.places.length >= MAX_PLACES ? `Up to ${MAX_PLACES} places` : "Add a city"}
          maxLength={80}
          disabled={search.confirmed && search.places.length >= MAX_PLACES}
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <select className="field" aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value as Country)}>
          {COUNTRIES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button type="submit" className="action secondary" disabled={!city.trim()}>
          Add
        </button>
      </form>
      <label className="check">
        <input type="checkbox" checked={search.remote} onChange={(e) => set({ remote: e.target.checked })} />
        Open to remote work
      </label>
    </div>
  );
}
