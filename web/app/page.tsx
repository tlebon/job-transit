"use client";

import { useEffect, useMemo, useState } from "react";
import { Board, type Trip } from "@/components/Board";
import { CvReader, type CvApply } from "@/components/CvReader";
import { JobTitles, type Title } from "@/components/JobTitles";
import { Leg } from "@/components/Leg";
import { Onboarding } from "@/components/Onboarding";
import { Scale } from "@/components/Scale";
import { api, EMPTY_PROFILE, type CityMap, type Meta, type Profile, type Recommendation, type SortKey } from "@/lib/api";
import { educationYears } from "@/lib/travel";

const STORAGE_KEY = "job-transit-profile-v1";
const ONBOARDED_KEY = "job-transit-onboarded-v1";

type Saved = { profile: Profile; jobLabel: string | null; extraLabels?: Record<number, string> };

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(saved: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* private mode or storage blocked: the app still works, it just won't remember */
  }
}

export default function Home() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [jobLabel, setJobLabel] = useState<string | null>(null);
  const [extraLabels, setExtraLabels] = useState<Record<number, string>>({});
  const [sort, setSort] = useState<SortKey>("best");
  const [data, setData] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [city, setCity] = useState<CityMap | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const saved = load();
    if (saved) {
      setProfile({ ...EMPTY_PROFILE, ...saved.profile });
      setJobLabel(saved.jobLabel);
      setExtraLabels(saved.extraLabels ?? {});
    }
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
      /* storage blocked: show the welcome flow each visit */
    }
    if (!seen) setOnboarding(true);
    api.meta().then(setMeta).catch((e: Error) => setError(e.message));
    api.map().then(setCity).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    save({ profile, jobLabel, extraLabels });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const request = trip ? { ...profile, job: trip.legs[trip.legs.length - 1].census } : profile;
      api
        .recommend(request, sort, controller.signal)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [profile, sort, jobLabel, trip]);

  // a new starting job starts a new trip
  useEffect(() => setTrip(null), [profile.job, profile.extra_jobs]);

  const update = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }));
  // typing shouldn't fire a request per keystroke: keep the draft locally, commit after a pause
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  useEffect(() => {
    if (descriptionDraft === null) return;
    const timer = setTimeout(() => update({ description: descriptionDraft.trim() || null }), 700);
    return () => clearTimeout(timer);
  }, [descriptionDraft]);
  const setDescription = (text: string) => setDescriptionDraft(text);
  const setIn = (key: "answers" | "quiz", id: string, value: number | undefined) =>
    setProfile((p) => {
      const next = { ...p[key] };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return { ...p, [key]: next };
    });

  const skillItems = useMemo(
    () => (meta ? meta.items.filter((i) => i.core || showAllSkills) : []),
    [meta, showAllSkills],
  );
  const applyCv = ({ job, education, answers, activities, tools }: CvApply) => {
    setProfile((p) => ({
      ...p,
      job: job ? job.census : p.job,
      education: education ?? p.education,
      answers: { ...answers, ...p.answers },
      activities,
      tools,
    }));
    if (job) setJobLabel(job.label);
  };

  const titles: Title[] = [
    ...(profile.job !== null && jobLabel ? [{ census: profile.job, label: jobLabel }] : []),
    ...profile.extra_jobs.map((c) => ({ census: c, label: extraLabels[c] ?? `Occupation ${c}` })),
  ];
  const setTitles = (next: Title[]) => {
    const [first, ...rest] = next;
    update({ job: first?.census ?? null, extra_jobs: rest.map((t) => t.census) });
    setJobLabel(first?.label ?? null);
    setExtraLabels(Object.fromEntries(rest.map((t) => [t.census, t.label])));
  };
  const toggleChip = (chip: string) =>
    setProfile((p) => ({ ...p, chips: p.chips.includes(chip) ? p.chips.filter((c) => c !== chip) : [...p.chips, chip] }));
  const finishOnboarding = () => {
    setOnboarding(false);
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* fine: it just shows again next time */
    }
  };
  const startOver = () => {
    setProfile(EMPTY_PROFILE);
    setJobLabel(null);
    setExtraLabels({});
    setTrip(null);
    setDescriptionDraft(null);
    setDrawerOpen(false);
    setOnboarding(true);
  };

  const nSkills = Object.keys(profile.answers).length;
  const nQuiz = Object.keys(profile.quiz).length;

  return (
    <>
      <header className="topbar">
        <span className="roundel" aria-hidden="true" />
        <span className="brand">Job Transit</span>
        <span className="tagline">Plan your next stop</span>
        <span className="topbar-actions">
          <button type="button" className="top-button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
            {drawerOpen ? "Hide your profile" : "Your profile"}
          </button>
          <button type="button" className="linkish" onClick={startOver}>
            Start over
          </button>
        </span>
      </header>

      {onboarding && (
        <Onboarding
          meta={meta}
          profile={profile}
          description={descriptionDraft ?? profile.description ?? ""}
          titles={titles}
          onTitles={setTitles}
          onDescription={setDescription}
          onApplyCv={applyCv}
          onToggleChip={toggleChip}
          onFinish={finishOnboarding}
        />
      )}

      <main className={drawerOpen ? "layout" : "layout layout-full"}>
        {drawerOpen && (
        <div className="planner">
          <Leg
            title="Start from your CV"
            hint="Fills in your job, education and skills. You can edit everything after."
            status="Optional"
            done={false}
          >
            <CvReader onApply={applyCv} />
          </Leg>

          <Leg
            title="Your work"
            hint="Job title and what the work actually involves"
            status={titles.length || profile.description ? "Set" : "Optional"}
            done={profile.job !== null || Boolean(profile.description)}
          >
            <JobTitles titles={titles} onChange={setTitles} />
            <label className="cv-row">
              <span className="q-text">What do you actually do?</span>
              <span className="q-help">A few lines in your own words. Titles hide a lot; this helps place you.</span>
              <textarea
                className="field area"
                rows={3}
                placeholder="Lead a team of five engineers, review code, plan sprints, still write some frontend features"
                value={descriptionDraft ?? profile.description ?? ""}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </Leg>

          <Leg
            title="What interests you?"
            hint="Topics you enjoy or would like to work with"
            status={profile.chips.length ? `${profile.chips.length} picked` : "Optional"}
            done={profile.chips.length > 0}
          >
            <div className="chips">
              {meta?.chips.map((chip) => {
                const on = profile.chips.includes(chip.name);
                return (
                  <button
                    key={chip.name}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    title={chip.description}
                    onClick={() => toggleChip(chip.name)}
                  >
                    {chip.name}
                  </button>
                );
              })}
            </div>
          </Leg>

          <Leg
            title="Would you enjoy these?"
            hint="Regardless of pay or training. Skip any you can’t judge."
            status={nQuiz ? `${nQuiz} of ${meta?.quiz.length ?? 24}` : "Optional"}
            done={nQuiz > 0}
          >
            {meta?.quiz.map((q) => (
              <div className="question" key={q.id}>
                <span className="q-text">{q.text}</span>
                <Scale
                  label={q.text}
                  value={profile.quiz[q.id]}
                  onChange={(v) => setIn("quiz", q.id, v)}
                  low="Strongly dislike"
                  high="Strongly like"
                />
              </div>
            ))}
          </Leg>

          <Leg
            title="What does your work rely on?"
            hint="How important each is to doing your job well"
            status={nSkills ? `${nSkills} of ${meta?.items.length ?? 43}` : "Optional"}
            done={nSkills > 0}
          >
            {skillItems.map((item) => (
              <div className="question" key={item.key}>
                <span className="q-text">
                  {item.label ?? (item.kind === "knowledge" ? `Knowledge of ${item.name}` : item.name)}
                </span>
                <span className="q-help">{item.description}</span>
                <Scale
                  label={item.name}
                  value={profile.answers[item.key]}
                  onChange={(v) => setIn("answers", item.key, v)}
                  low="Not important"
                  high="Extremely important"
                />
              </div>
            ))}
            {meta && (
              <button type="button" className="linkish more" onClick={() => setShowAllSkills(!showAllSkills)}>
                {showAllSkills ? "Show fewer questions" : `Answer ${meta.items.length - skillItems.length} more for a sharper match`}
              </button>
            )}
          </Leg>

          <Leg
            title="Highest education"
            hint="Used to show what each move would take"
            status={profile.education ? "Set" : "Optional"}
            done={profile.education !== null}
          >
            <select
              className="field"
              aria-label="Highest education completed"
              value={profile.education ?? ""}
              onChange={(e) => update({ education: e.target.value || null })}
            >
              <option value="">Prefer not to say</option>
              {meta?.education_ladder.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Leg>

        </div>
        )}

        <Board
          city={city}
          data={data}
          sort={sort}
          onSort={setSort}
          error={error}
          trip={trip}
          schooling={educationYears(profile.education)}
          onContinue={(stop) => {
            if (!data?.origin) return;
            setTrip((t) => (t ? { ...t, legs: [...t.legs, stop] } : { start: data.origin!, legs: [stop] }));
          }}
          onBack={() => setTrip((t) => (t && t.legs.length > 1 ? { ...t, legs: t.legs.slice(0, -1) } : null))}
        />
      </main>
    </>
  );
}
