// Where the person is looking for work: used by the Openings section and passed to the guide.
export const COUNTRIES = [
  ["de", "Germany"],
  ["at", "Austria"],
  ["nl", "Netherlands"],
  ["gb", "United Kingdom"],
  ["fr", "France"],
  ["it", "Italy"],
  ["pl", "Poland"],
  ["us", "United States"],
  ["ca", "Canada"],
  ["au", "Australia"],
] as const;
export type Country = (typeof COUNTRIES)[number][0];
export type Location = { city: string; country: Country };

const KEY = "job-transit-location";
export const DEFAULT_LOCATION: Location = { city: "Berlin", country: "de" };

/** Everywhere they're looking: one or more places, open to remote or not. `confirmed` is false while it's only the
 * app's default guess, so the guide knows to ask. */
export type Search = { places: Location[]; remote: boolean; confirmed: boolean };
const SEARCH_KEY = "job-transit-search-v1";
export const DEFAULT_SEARCH: Search = { places: [DEFAULT_LOCATION], remote: false, confirmed: false };
export const SEARCH_EVENT = "job-transit-search";
export const MAX_PLACES = 3; // each place is its own openings search // fired on save, so open components pick up the change

const validPlace = (p: unknown): p is Location =>
  !!p && typeof (p as Location).city === "string" && COUNTRIES.some(([c]) => c === (p as Location).country);

export function loadSearch(): Search {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_KEY) ?? "null") as Search | null;
    if (saved && Array.isArray(saved.places)) {
      const places = saved.places.filter(validPlace);
      if (places.length) return { places, remote: !!saved.remote, confirmed: !!saved.confirmed };
    }
    // before multiple places: one city, saved when they searched for openings, so they chose it
    const old = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (validPlace(old)) return { places: [old], remote: false, confirmed: true };
  } catch {}
  return DEFAULT_SEARCH;
}

export function saveSearch(search: Search) {
  try {
    localStorage.setItem(SEARCH_KEY, JSON.stringify(search));
    window.dispatchEvent(new Event(SEARCH_EVENT));
  } catch {}
}

export const placeName = (p: Location) => `${p.city}, ${COUNTRIES.find(([c]) => c === p.country)?.[1] ?? p.country}`;

/** What the guide gets: the first place (older field names) plus all of them. */
export function searchForChat(search: Search = loadSearch()) {
  return { ...(search.places[0] ?? DEFAULT_LOCATION), places: search.places, remote: search.remote, confirmed: search.confirmed };
}

/** The first place they're looking in. */
export function loadLocation(): Location {
  return loadSearch().places[0] ?? DEFAULT_LOCATION;
}
