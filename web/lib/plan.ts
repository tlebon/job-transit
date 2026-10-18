// The person's plan for one move: drafted by the guide (save_plan), kept in this browser, ticked off here.
// due: YYYY-MM-DD; mine: added by the person (kept when the guide revises the plan)
// sessions: for learning steps, short practice sessions at growing intervals (spaced repetition); done = date practised
export type Session = { due: string; done?: string };
export type PlanStep = {
  id: string;
  title: string;
  detail: string;
  due: string;
  done: boolean;
  mine?: boolean;
  sessions?: Session[];
  resources?: string[]; // Markdown links the guide found for this step ("Help me start"); replaced, not appended
};
// A job posting kept with the plan for that move. found = the guide or the job page turned it up; the person can
// save it (then track it through applying) or hide it.
export type ApplicationStatus = "found" | "interested" | "applied" | "interview" | "offer" | "no" | "hidden";
export type SavedOpening = {
  url: string;
  title: string;
  company: string;
  location: string;
  where?: string; // "in Berlin", "remote", "elsewhere"
  pay?: string | null;
  career_changer?: boolean;
  status: ApplicationStatus;
  found: string; // YYYY-MM-DD
  updated?: string;
};
// A link the guide gave in this path's conversation or a step's resources, kept so it's easy to find again.
export type PlanLink = { url: string; title: string; added: string };
export type Plan = {
  id?: string; // set once there can be several plans (workspace.ts)
  name?: string; // short tab name ("Carpentry"); the occupation title when the guide gave none
  census: number;
  occupation: string;
  summary: string;
  created: string;
  steps: PlanStep[];
  openings?: SavedOpening[];
  links?: PlanLink[];
  hiddenLinks?: string[]; // removed by the person: not collected again
};
export type PlanAction = {
  type: "save_plan";
  census: number;
  occupation: string;
  name?: string;
  summary: string;
  steps: { title: string; detail: string; week: number; kind?: "learn" | "do" }[];
};

// Spaced repetition: come back to what you're learning after 1, 3, 7, 14 and 30 days. Retrieval practice at
// growing intervals is one of the best-supported ways to make learning stick (the spacing and testing effects).
export const SPACING_DAYS = [1, 3, 7, 14, 30];

export function sessionsFrom(start: Date): Session[] {
  return SPACING_DAYS.map((days) => {
    const d = new Date(start);
    d.setDate(d.getDate() + days);
    return { due: isoDate(d) };
  });
}

export const nextSession = (step: PlanStep) => step.sessions?.find((s) => !s.done);

/** Mark the next open practice session of a step as done today. The later sessions move with it, so the gaps
 * between practising stay 2, 4, 7 and 16 days whether you practised early or late. */
export function logSession(plan: Plan, id: string): Plan {
  const now = new Date();
  return {
    ...plan,
    steps: plan.steps.map((s) => {
      if (s.id !== id || !s.sessions) return s;
      const i = s.sessions.findIndex((x) => !x.done);
      if (i < 0) return s;
      const sessions = s.sessions.map((x, j) => {
        if (j < i) return x;
        if (j === i) return { ...x, done: isoDate(now) };
        const d = new Date(now);
        d.setDate(d.getDate() + (SPACING_DAYS[j] ?? 30) - (SPACING_DAYS[i] ?? 0));
        return { due: isoDate(d) };
      });
      return { ...s, sessions };
    }),
  };
}

/** The step the guide means by a title: exact match first, then a containing one. */
export function findStep(plan: Plan, title: string): PlanStep | undefined {
  const wanted = title.trim().toLowerCase();
  return (
    plan.steps.find((s) => s.title.trim().toLowerCase() === wanted) ??
    plan.steps.find((s) => s.title.toLowerCase().includes(wanted) || wanted.includes(s.title.toLowerCase()))
  );
}

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

/** A plan from the guide's save_plan action. A revision of the same move keeps the ticks on steps with the same
 * title, and the steps the person added themselves. */
export function planFromAction(action: PlanAction, previous: Plan | null): Plan {
  const today = new Date();
  const sameMove = previous && previous.census === action.census ? previous : null;
  const doneBefore = new Set(sameMove ? sameMove.steps.filter((s) => s.done).map((s) => s.title.toLowerCase()) : []);
  const sessionsBefore = new Map(
    (sameMove?.steps ?? []).filter((s) => s.sessions).map((s) => [s.title.toLowerCase(), s.sessions!]),
  );
  const newTitles = new Set(action.steps.map((s) => s.title.toLowerCase()));
  const keptMine = sameMove ? sameMove.steps.filter((s) => s.mine && !newTitles.has(s.title.toLowerCase())) : [];
  const plan: Plan = {
    id: sameMove?.id,
    name: action.name || sameMove?.name,
    openings: sameMove?.openings,
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
        sessions: s.kind === "learn" ? sessionsBefore.get(s.title.toLowerCase()) ?? sessionsFrom(today) : undefined,
      };
    }),
  };
  plan.steps.push(...keptMine);
  return plan;
}

export function addStep(plan: Plan, title: string, weeks = 2): Plan {
  const due = new Date();
  due.setDate(due.getDate() + 7 * weeks);
  const step: PlanStep = { id: `${Date.now().toString(36)}-mine`, title, detail: "", due: isoDate(due), done: false, mine: true };
  return { ...plan, steps: [...plan.steps, step] };
}

export function updateStep(plan: Plan, id: string, patch: Partial<PlanStep>): Plan {
  return { ...plan, steps: plan.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeStep(plan: Plan, id: string): Plan {
  return { ...plan, steps: plan.steps.filter((s) => s.id !== id) };
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
  const event = (uid: string, date: string, summary: string, description: string) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + 1);
    return [
      "BEGIN:VEVENT",
      `UID:${uid}@job-transit`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${isoDate(next).replace(/-/g, "")}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(description)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(summary)}`,
      "TRIGGER:PT9H",
      "END:VALARM",
      "END:VEVENT",
    ];
  };
  const events = plan.steps
    .filter((s) => !s.done)
    .flatMap((s) => [
      ...event(s.id, s.due, `Job Transit: ${s.title}`, `${s.detail}\n\nPart of your plan toward ${plan.occupation}.`),
      ...(s.sessions ?? [])
        .filter((x) => !x.done)
        .flatMap((x, i) =>
          event(`${s.id}-practice-${i}`, x.due, `Practice (10 min): ${s.title}`,
            "A short practice session: test yourself or do one small exercise. Ask the guide to quiz you."),
        ),
    ]);
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
