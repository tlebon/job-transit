// The person's plan for one move: drafted by the guide (save_plan), kept in this browser, ticked off here.
export type PlanStep = { id: string; title: string; detail: string; due: string; done: boolean }; // due: YYYY-MM-DD
export type Plan = { census: number; occupation: string; summary: string; created: string; steps: PlanStep[] };
export type PlanAction = {
  type: "save_plan";
  census: number;
  occupation: string;
  summary: string;
  steps: { title: string; detail: string; week: number }[];
};

const KEY = "job-transit-plan-v1";

export function loadPlan(): Plan | null {
  try {
    const plan = JSON.parse(localStorage.getItem(KEY) ?? "null") as Plan | null;
    return plan && Array.isArray(plan.steps) ? plan : null;
  } catch {
    return null;
  }
}

export function savePlan(plan: Plan | null) {
  try {
    if (plan) localStorage.setItem(KEY, JSON.stringify(plan));
    else localStorage.removeItem(KEY);
  } catch {}
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A plan from the guide's save_plan action. A revision of the same move keeps the ticks on steps with the same title. */
export function planFromAction(action: PlanAction, previous: Plan | null): Plan {
  const today = new Date();
  const doneBefore = new Set(
    previous && previous.census === action.census ? previous.steps.filter((s) => s.done).map((s) => s.title.toLowerCase()) : [],
  );
  return {
    census: action.census,
    occupation: action.occupation,
    summary: action.summary,
    created: previous && previous.census === action.census ? previous.created : isoDate(today),
    steps: action.steps.map((s, i) => {
      const due = new Date(today);
      due.setDate(due.getDate() + 7 * Math.max(1, s.week));
      return {
        id: `${Date.now().toString(36)}-${i}`,
        title: s.title,
        detail: s.detail,
        due: isoDate(due),
        done: doneBefore.has(s.title.toLowerCase()),
      };
    }),
  };
}

// ---- calendar file (.ics): one all-day event per open step, with a 9:00 reminder that day ----------
function escapeText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function fold(line: string) {
  // RFC 5545: lines longer than 75 octets continue on the next line after a space
  const out: string[] = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 74;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function planToIcs(plan: Plan): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const events = plan.steps
    .filter((s) => !s.done)
    .flatMap((s) => {
      const start = s.due.replace(/-/g, "");
      const next = new Date(`${s.due}T12:00:00`);
      next.setDate(next.getDate() + 1);
      const end = isoDate(next).replace(/-/g, "");
      return [
        "BEGIN:VEVENT",
        `UID:${s.id}@job-transit`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        `SUMMARY:${escapeText(`Job Transit: ${s.title}`)}`,
        `DESCRIPTION:${escapeText(`${s.detail}\n\nPart of your plan toward ${plan.occupation}.`)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(s.title)}`,
        "TRIGGER:PT9H",
        "END:VALARM",
        "END:VEVENT",
      ];
    });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Job Transit//Plan//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"]
    .map(fold)
    .join("\r\n");
}

export function downloadIcs(plan: Plan) {
  const blob = new Blob([planToIcs(plan)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "job-transit-plan.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
