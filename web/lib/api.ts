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
  answers: Record<string, number>;
  chips: string[];
  quiz: Record<string, number>;
  education: string | null;
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
  education_level: number | null;
};

export type Stop = Occupation & {
  skill_match: number | null;
  reach_share: number | null;
  reach_pct: number | null;
  reach_score: number | null;
  appeal_pct: number | null;
  same_line?: boolean;
  education_gap: number | null;
};

export type Recommendation = {
  origin: (Occupation & { kind: "your job" | "nearest station"; nearby: string[] }) | null;
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

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type CvResult = {
  summary: string;
  jobs: { title: string; years: number | null; matches: JobMatch[] }[];
  education: string | null;
  education_field: string | null;
  years_experience: number | null;
  tools: string[];
  answers: Record<string, number>;
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
  recommend: (profile: Profile, sort: SortKey, signal?: AbortSignal) =>
    getJson<Recommendation>("/recommend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, sort, limit: 600 }),
      signal,
    }),
};

export const EMPTY_PROFILE: Profile = { job: null, answers: {}, chips: [], quiz: {}, education: null };
