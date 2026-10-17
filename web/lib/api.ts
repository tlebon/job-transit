import type { Plan, PlanAction } from "./plan";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Item = { key: string; kind: "knowledge" | "skill"; name: string; label: string | null; description: string; core: boolean };
export type Chip = { name: string; description: string; riasec: string | null };
export type QuizItem = { id: string; type: string; text: string };
export type Meta = {
  items: Item[];
  chips: Chip[];
  quiz: QuizItem[];
  education_ladder: string[];
  families: string[];
  riasec_order: string[];
};

export type JobMatch = { census: number; matched_title: string; occupation: string; score: number };

export type Profile = {
  job: number | null;
  extra_jobs: number[];
  answers: Record<string, number>;
  chips: string[];
  quiz: Record<string, number>;
  education: string | null;
  description: string | null;
  activities: string[];
  tools: string[];
  hobbies: string | null;
  goals: string[];
  experience_years: number | null;
};

export type Occupation = {
  census: number;
  title: string;
  family: string | null;
  soc_major: string;
  job_zone: number | null;
  employment_2025: number | null;
  growth_pct: number | null;
  median_wage: number | null;
  entry_education: string | null;
  work_experience: string | null;
  on_the_job_training: string | null;
  ai_observed: number | null;
  ai_theoretical: number | null;
  ai_theoretical_pct_in_zone: number | null;
  official_title?: string;
  bls_ai_exposure?: "Low" | "Moderate" | "High" | "Very high" | null;
  education_level: number | null;
};

export type Stop = Occupation & {
  skill_match: number | null;
  reach_share: number | null;
  reach_pct: number | null;
  reach_score: number | null;
  reach_rank?: number | null;
  reach_label?: string | null;
  appeal_pct: number | null;
  same_line?: boolean;
  education_gap: number | null;
};

export type Recommendation = {
  origin:
    | (Occupation & {
        kind: "your job" | "your work" | "nearest station";
        nearby: string[];
        mix: { census: number; title: string; weight: number }[];
      })
    | null;
  evidence: { placed_as: string; statement: string; task: string; occupation: string; similarity: number }[];
  tools_matched: string[];
  hobby_areas: string[];
  signals: {
    job: boolean;
    skills_answered: number;
    skills_total: number;
    chips: number;
    quiz_answered: number;
    education: boolean;
  };
  confidence: number;
  sort: "best" | "reachable" | "appealing";
  results: Stop[];
};

export type Station = { census: number; title: string; family: string | null; x: number; y: number; district: number };
export type District = { id: number; name: string; x: number; y: number; outline: number[][][]; size: number };
export type CityMap = {
  stations: Station[];
  districts: District[];
  lines: { a: number; b: number; w: number }[];
  blocks: Record<string, number[][][]>;
};

export type SortKey = "best" | "reachable" | "appealing";

/** The API's own message for a failed request ({"detail": "..."} from FastAPI), else the status and body. */
async function failure(res: Response): Promise<Error> {
  const text = await res.text();
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof detail === "string") return new Error(detail);
  } catch {
    // not JSON
  }
  return new Error(`${res.status} ${text}`);
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

export type CvRole = {
  title: string;
  label: string;
  years: number | null;
  current: boolean;
  kind: "job" | "program";
  matches: JobMatch[];
};

export type CvResult = {
  summary: string;
  jobs: CvRole[];
  education: string | null;
  education_field: string | null;
  years_experience: number | null;
  tools: string[];
  activities: string[];
  answers: Record<string, number>;
};

export type SkillLine = { item: string; needed: number; you: number };
export type StopDetails = {
  occupation: Occupation;
  description?: string;
  tasks?: string[];
  example_titles?: string[];
  catch_all?: boolean;
  members?: { title: string; summary: string }[];
  experience_note?: string;
  reach?: { share: number; rank: number; label: string; from: string | null };
  skill_match?: number;
  gaps?: SkillLine[];
  transfers?: SkillLine[];
  pay_change_pct?: number;
  from_occupation?: Occupation;
};

export type Opening = {
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  near: 0 | 1 | 2;
  us_only?: boolean; // remote, but only for people in the US or the Americas
  language?: "German" | "English" | null; // the language the posting is written in
  needs_german?: boolean; // asks for good German
};
export type Openings = {
  occupation: string;
  search_terms: string[];
  city: string;
  country: string;
  sources: Record<string, number | string>; // matched postings, or "unavailable: ..."
  updated?: Record<string, string>; // ISO time each source's postings were fetched
  openings: Opening[];
  total_matched: number;
  by_place?: { in_city: number; remote: number; elsewhere: number };
};

export const api = {
  meta: () => getJson<Meta>("/meta"),
  map: () => getJson<CityMap>("/map"),
  searchJobs: (q: string, signal?: AbortSignal) =>
    getJson<JobMatch[]>(`/jobs/search?q=${encodeURIComponent(q)}&limit=6`, { signal }),
  readCv: (body: { text?: string; pdf_base64?: string }) =>
    getJson<CvResult>("/cv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  stop: (profile: Profile, census: number, signal?: AbortSignal) =>
    getJson<StopDetails>("/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, census }),
      signal,
    }),
  /** Start fetching openings for these jobs in the background, so the first search for them is quick. */
  warmOpenings: (census: number[], city: string, country: string) =>
    getJson<{ started: number }>("/openings/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ census, city, country }),
    }).catch(() => ({ started: 0 })),
  openings: (census: number, city: string, country: string, signal?: AbortSignal) =>
    getJson<Openings>("/openings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ census, city, country }),
      signal,
    }),
  emailPlan: (email: string, plan: Plan, remind: boolean) =>
    getJson<{ ok: boolean; token: string | null }>("/email/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, plan, remind }),
    }),
  remindersOff: (token: string) =>
    getJson<{ ok: boolean }>("/email/reminders/off", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  syncReminders: (token: string, plan: Plan) =>
    getJson<{ ok: boolean }>("/email/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, plan }),
    }),
  recommend: (profile: Profile, sort: SortKey, signal?: AbortSignal) =>
    getJson<Recommendation>("/recommend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, sort, limit: 600 }),
      signal,
    }),
};

export const EMPTY_PROFILE: Profile = {
  job: null,
  extra_jobs: [],
  answers: {},
  chips: [],
  quiz: {},
  education: null,
  description: null,
  activities: [],
  tools: [],
  hobbies: null,
  goals: [],
  experience_years: null,
};

// ---- the guide (chat) ----------------------------------------------------------------------
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatAction =
  | { type: "open_job"; census: number }
  | { type: "suggest_replies"; replies: string[] }
  | { type: "update_step"; title: string; resources: string[] }
  | { type: "log_practice"; title: string }
  | PlanAction
  | {
      type: "update_profile";
      goals?: string[];
      hobbies?: string;
      experience_years?: number;
      add_title?: number;
      add_title_label?: string;
    };
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "action"; action: ChatAction }
  | { type: "error"; message: string }
  | { type: "done" };

/** Streams the guide's reply (server-sent events) and calls onEvent for each event. */
export async function streamChat(
  body: {
    messages: ChatMessage[];
    profile: Profile;
    selected: number | null;
    location?: { city: string; country: string };
    plan?: Plan | null;
  },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await failure(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as ChatEvent);
    }
  }
}
