"use client";

import { useEffect, useMemo, useState } from "react";
import { Board, type Trip } from "@/components/Board";
import { CvReader, type CvApply } from "@/components/CvReader";
import { JobTitles, type Title } from "@/components/JobTitles";
import { Leg } from "@/components/Leg";
import { GoalPicker } from "@/components/GoalPicker";
import { ChipGroups } from "@/components/ChipGroups";
import { Logo } from "@/components/Logo";
import { Onboarding } from "@/components/Onboarding";
import { Scale } from "@/components/Scale";
import {
  api,
  EMPTY_PROFILE,
  type CityMap,
  type CvResult,
  type Meta,
  type Profile,
  type Recommendation,
  type SortKey,
} from "@/lib/api";
import { educationYears } from "@/lib/travel";

const STORAGE_KEY = "job-transit-profile-v1";
const ONBOARDED_KEY = "job-transit-onboarded-v1";

type Saved = {
  profile: Profile;
  jobLabel: string | null;
  extraLabels?: Record<number, string>;
  cv?: CvResult | null;
};

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
  const [cv, setCv] = useState<CvResult | null>(null);
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
      setCv(saved.cv ?? null);
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
    save({ profile, jobLabel, extraLabels, cv });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const body = trip ? { ...profile, job: trip.legs[trip.legs.length - 1].census, extra_jobs: [] } : profile;
      api
        .recommend(body, sort, controller.signal)
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
  }, [profile, sort, jobLabel, trip, cv]);

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
  const [hobbiesDraft, setHobbiesDraft] = useState<string | null>(null);
  useEffect(() => {
    if (hobbiesDraft === null) return;
    const timer = setTimeout(() => update({ hobbies: hobbiesDraft.trim() || null }), 800);
    return () => clearTimeout(timer);
  }, [hobbiesDraft]);
  const toggleGoal = (goal: string) =>
    setProfile((p) => ({ ...p, goals: p.goals.includes(goal) ? p.goals.filter((g) => g !== goal) : [...p.goals, goal] }));
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
  const applyCv = ({ titles: cvTitles, education, answers, activities, tools, record }: CvApply) => {
    setProfile((p) => ({
      ...p,
      education: education ?? p.education,
      answers: { ...answers, ...p.answers },
      activities,
      tools,
    }));
    if (cvTitles.length) setTitles(cvTitles);
    setCv(record);
  };
  const removeCv = () => {
    setProfile((p) => ({ ...p, activities: [], tools: [] }));
    setCv(null);
  };
  const removeActivity = (activity: string) =>
    setProfile((p) => ({ ...p, activities: p.activities.filter((a) => a !== activity) }));
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
  // Save the profile to a file and load it back: a stand-in for accounts, so nothing has to be retyped.
  const [fileError, setFileError] = useState<string | null>(null);
  const saveToFile = () => {
    const blob = new Blob([JSON.stringify({ app: "job-transit", version: 1, profile, jobLabel, extraLabels, cv }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "job-transit-profile.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  const loadFromFile = async (file: File) => {
    setFileError(null);
    try {
      const saved = JSON.parse(await file.text());
      if (saved?.app !== "job-transit" || typeof saved.profile !== "object") throw new Error("not a Job Transit profile");
      setProfile({ ...EMPTY_PROFILE, ...saved.profile });
      setJobLabel(saved.jobLabel ?? null);
      setExtraLabels(saved.extraLabels ?? {});
      setCv(saved.cv ?? null);
      setHobbiesDraft(null);
      setDescriptionDraft(null);
      setTrip(null);
      finishOnboarding();
    } catch (e) {
      setFileError(`Couldn’t load that file: ${e instanceof Error ? e.message : "unreadable"}.`);
    }
  };

  const startOver = () => {
    setProfile(EMPTY_PROFILE);
    setJobLabel(null);
    setExtraLabels({});
    setCv(null);
    setHobbiesDraft(null);
    setTrip(null);
    setDescriptionDraft(null);
    setDrawerOpen(false);
    setOnboarding(true);
  };

  const request = useMemo(
    () => (trip ? { ...profile, job: trip.legs[trip.legs.length - 1].census, extra_jobs: [] } : profile),
    [profile, trip],
  );
  const nSkills = Object.keys(profile.answers).length;
  const nQuiz = Object.keys(profile.quiz).length;

  return (
    <>
      <header className="topbar">
        <Logo />
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
          hobbies={hobbiesDraft ?? profile.hobbies ?? ""}
          onHobbies={setHobbiesDraft}
          onToggleGoal={toggleGoal}
          hasCv={cv !== null}
          onLoadFile={loadFromFile}
          onFinish={finishOnboarding}
        />
      )}

      <main className={drawerOpen ? "layout" : "layout layout-full"}>
        {drawerOpen && (
        <div className="planner">
          <Leg
            title={cv ? "From your CV" : "Start from your CV"}
            hint={cv ? "What we read from it. Remove anything that doesn’t fit." : "Fills in your roles, education and skills"}
            status={cv ? "Added" : "Optional"}
            done={cv !== null}
          >
            {cv ? (
              <div className="cv-summary">
                <p>{cv.summary}</p>
                {profile.activities.length > 0 && (
                  <>
                    <span className="fact-label">What you do (used to place you)</span>
                    <ul className="activity-list">
                      {profile.activities.map((a) => (
                        <li key={a}>
                          <span>{a}</span>
                          <button type="button" className="linkish" aria-label={`Remove: ${a}`} onClick={() => removeActivity(a)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {profile.tools.length > 0 && (
                  <>
                    <span className="fact-label">Tools</span>
                    <div className="chips">
                      {profile.tools.map((t) => (
                        <span key={t} className="chip static">
                          {t}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                <button type="button" className="linkish" onClick={removeCv}>
                  Remove CV data
                </button>
              </div>
            ) : (
              <CvReader onApply={applyCv} />
            )}
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
            hint="Hobbies, and topics you enjoy or would like to work with"
            status={profile.chips.length ? `${profile.chips.length} picked` : "Optional"}
            done={profile.chips.length > 0}
          >
            <label className="cv-row">
              <span className="q-text">What do you do for fun?</span>
              <textarea
                className="field area"
                rows={2}
                placeholder="Bouldering, improv comedy, writing short stories"
                value={hobbiesDraft ?? profile.hobbies ?? ""}
                onChange={(e) => setHobbiesDraft(e.target.value)}
              />
            </label>
            {data && data.hobby_areas.length > 0 && <p className="q-help">Picked up: {data.hobby_areas.join(", ")}</p>}
            <span className="q-text">Or tap topics</span>
            {meta && <ChipGroups chips={meta.chips} order={meta.riasec_order} picked={profile.chips} onToggle={toggleChip} />}
          </Leg>

          <Leg
            title="What do you want from a change?"
            hint="Pick any. It changes the order of your stops, never what you can see."
            status={profile.goals.length ? `${profile.goals.length} picked` : "Optional"}
            done={profile.goals.length > 0}
          >
            <GoalPicker goals={profile.goals} onToggle={toggleGoal} />
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

          <div className="profile-file">
            <span className="q-help">Nothing is stored on our side. Save your profile to pick it up on another device.</span>
            <div className="profile-file-actions">
              <button type="button" className="linkish" onClick={saveToFile}>
                Save to a file
              </button>
              <label className="linkish file-pick">
                Load from a file
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) loadFromFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {fileError && <p className="error">{fileError}</p>}
          </div>
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
          request={request}
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
