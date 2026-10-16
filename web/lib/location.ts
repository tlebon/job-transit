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

export function loadLocation(): Location {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Location | null;
    if (saved && typeof saved.city === "string" && COUNTRIES.some(([c]) => c === saved.country)) return saved;
  } catch {}
  return DEFAULT_LOCATION;
}

export function saveLocation(location: Location) {
  try {
    localStorage.setItem(KEY, JSON.stringify(location));
  } catch {}
}
