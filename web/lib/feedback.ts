// Save / Not for me on openings, sent to the API as labels for training later (api/feedback.py). Anonymous: a
// random id for this browser groups one person's clicks, nothing else about them is sent. Fire and forget.
import { API_URL } from "./api";
import type { ApplicationStatus, Plan, SavedOpening } from "./plan";

const KEY = "job-transit-browser-id";

function browserId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `b${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "b-no-storage";
  }
}

export type Via = "plan" | "guide" | "job_page";

/** One label: `status` for this opening in this path. Openings just found are logged as "found" (shown, no answer yet). */
export function logLabel(plan: Plan, opening: SavedOpening | Omit<SavedOpening, "status" | "found">, status: ApplicationStatus, via: Via, previous?: ApplicationStatus) {
  try {
    void fetch(`${API_URL}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        browser: browserId(),
        label: status,
        previous: previous ?? null,
        via,
        url: opening.url,
        move_census: plan.census,
        move: plan.occupation.slice(0, 200),
        title: opening.title?.slice(0, 300) ?? null,
        company: opening.company?.slice(0, 300) ?? null,
        location: opening.location?.slice(0, 300) ?? null,
        where: opening.where?.slice(0, 40) ?? null,
      }),
    }).catch(() => {});
  } catch {}
}
