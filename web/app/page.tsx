"use client";

import { useEffect, useState } from "react";
import { Board } from "@/components/Board";
import { PlanCard } from "@/components/PlanCard";
import { CvReader, type CvApply } from "@/components/CvReader";
import { JobTitles, type Title } from "@/components/JobTitles";
import { Leg } from "@/components/Leg";
import { GoalPicker } from "@/components/GoalPicker";
import { AskBar } from "@/components/AskBar";
import { ChatPanel, type Turn } from "@/components/ChatPanel";
import { ChipGroups } from "@/components/ChipGroups";
import { ExperiencePicker } from "@/components/ExperiencePicker";
import { Logo } from "@/components/Logo";
import { Onboarding } from "@/components/Onboarding";
import {
  api,
  EMPTY_PROFILE,
  type CityMap,
  type ChatAction,
  type CvResult,
  type Meta,
  type Profile,
  type Recommendation,
  type SortKey,
} from "@/lib/api";
import { educationYears } from "@/lib/travel";
import { loadPlan, planFromAction, savePlan, type Plan } from "@/lib/plan";

const STORAGE_KEY = "job-transit-profile-v1";
const ONBOARDED_KEY = "job-transit-onboarded-v1";
const CHAT_KEY = "job-transit-chat-v1";

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
  const [city, setCity] = useState<CityMap | null>(null);
  const [plan, setPlanState] = useState<Plan | null>(null);
  useEffect(() => setPlanState(loadPlan()), []);
  const setPlan = (next: Plan | null) => {
    setPlanState(next);
    savePlan(next);
  };
  const [onboarding, setOnboarding] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const saved = load();
    if (saved) {
      setProfile({
        ...EMPTY_PROFILE,
        ...saved.profile,
        // the skill questionnaire and interest quiz were removed (notebook 09): keep only CV-derived skill ratings
        quiz: {},
        answers: saved.cv ? saved.profile.answers : {},
      });
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
      api
        .recommend(profile, sort, controller.signal)
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
  }, [profile, sort, jobLabel, cv]);

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
  const applyCv = ({ titles: cvTitles, education, answers, activities, tools, record }: CvApply) => {
    setProfile((p) => ({
      ...p,
      education: education ?? p.education,
      answers: { ...p.answers, ...answers },
      activities,
      tools,
      experience_years: record.years_experience ?? p.experience_years,
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
  // The guide (chat): it can open stops on the map and change the profile.
  // Map first; once you ask the guide, the chat becomes the main space (map shrinks to the context panel).
  const [chatMode, setChatMode] = useState(false);
  const [turns, setTurnsState] = useState<Turn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]") as Turn[];
      if (saved.length) {
        setTurnsState(saved);
        setChatMode(true);   // returning with a conversation: go straight to it
      }
    } catch {
      /* no saved conversation */
    }
  }, []);
  const setTurns = (fn: (t: Turn[]) => Turn[]) =>
    setTurnsState((t) => {
      const next = fn(t);
      try {
        localStorage.setItem(CHAT_KEY, JSON.stringify(next.map(({ role, content }) => ({ role, content }))));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const askFromMap = (question: string) => {
    setPendingQuestion(question);
    setChatMode(true);
  };
  const [viewing, setViewing] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ census: number; at: number } | null>(null);
  const onChatAction = (action: ChatAction) => {
    if (action.type === "save_plan") {
      setPlan(planFromAction(action, plan));
      return;
    }
    if (action.type === "suggest_replies") return; // shown in the chat itself
    if (action.type === "open_stop") {
      setFocus({ census: action.census, at: Date.now() });
      return;
    }
    setProfile((p) => ({
      ...p,
      goals: action.goals ?? p.goals,
      hobbies: action.hobbies ?? p.hobbies,
      experience_years: action.experience_years ?? p.experience_years,
      extra_jobs:
        action.add_title !== undefined && action.add_title !== p.job && !p.extra_jobs.includes(action.add_title)
          ? [...p.extra_jobs, action.add_title]
          : p.extra_jobs,
    }));
    if (action.hobbies !== undefined) setHobbiesDraft(null);
    if (action.add_title !== undefined && action.add_title_label) {
      setExtraLabels((labels) => ({ ...labels, [action.add_title!]: action.add_title_label! }));
    }
  };

  const setExperience = (years: number | null) => setProfile((p) => ({ ...p, experience_years: years }));
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
      setProfile({
        ...EMPTY_PROFILE,
        ...saved.profile,
        // the skill questionnaire and interest quiz were removed (notebook 09): keep only CV-derived skill ratings
        quiz: {},
        answers: saved.cv ? saved.profile.answers : {},
      });
      setJobLabel(saved.jobLabel ?? null);
      setExtraLabels(saved.extraLabels ?? {});
      setCv(saved.cv ?? null);
      setHobbiesDraft(null);
      setDescriptionDraft(null);
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
    setDescriptionDraft(null);
    setPlan(null);
    setDrawerOpen(false);
    setOnboarding(true);
  };

  const request = profile;
  const planMove = (stop: { census: number; title: string }) => {
    setFocus({ census: stop.census, at: Date.now() });
    setPendingQuestion(`Make me a plan for moving to “${stop.title}”.`);
    setChatMode(true);
  };

  return (
    <>
      <header className="topbar">
        <Logo />
        <span className="brand">Job Transit</span>
        <span className="tagline">Plan your next stop</span>
        <span className="topbar-actions">
          <button type="button" className="top-button top-guide" onClick={() => setChatMode(!chatMode)}>
            {chatMode ? "Map view" : "Ask the guide"}
          </button>
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
          experienceYears={profile.experience_years}
          onExperience={setExperience}
          onLoadFile={loadFromFile}
          onFinish={finishOnboarding}
        />
      )}

      <main className={chatMode ? `workspace${drawerOpen ? " workspace-drawer" : ""}` : drawerOpen ? "layout" : "layout layout-full"}>
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
                placeholder="Run the front desk, handle bookings and complaints, train new staff, plan the weekly rota"
                value={descriptionDraft ?? profile.description ?? ""}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="cv-row">
              <span className="q-text">How much work experience do you have?</span>
              <span className="q-help">Some jobs, mostly management, usually need 5+ years in a related job.</span>
              <ExperiencePicker years={profile.experience_years} onChange={setExperience} />
            </div>
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
                placeholder="Gardening, cycling, cooking for friends"
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

        {chatMode && (
          <ChatPanel
            turns={turns}
            setTurns={setTurns}
            profile={profile}
            selected={viewing}
            onAction={onChatAction}
            pendingQuestion={pendingQuestion}
            onPendingSent={() => setPendingQuestion(null)}
            plan={plan}
          />
        )}
        <Board
          compact={chatMode}
          city={city}
          data={data}
          sort={sort}
          onSort={setSort}
          error={error}
          schooling={educationYears(profile.education)}
          request={request}
          onPlan={planMove}
          focus={focus}
          onSelectedChange={setViewing}
          mapOverlay={!onboarding ? <AskBar onAsk={askFromMap} /> : null}
        >
          {plan && (
            <PlanCard
              plan={plan}
              onToggle={(id) => setPlan({ ...plan, steps: plan.steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s)) })}
              onRemove={() => setPlan(null)}
              onOpenStop={(census) => setFocus({ census, at: Date.now() })}
            />
          )}
        </Board>
      </main>
    </>
  );
}
