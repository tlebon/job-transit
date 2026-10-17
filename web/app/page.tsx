"use client";

import { useEffect, useRef, useState } from "react";
import { Board } from "@/components/Board";
import { PlanCard } from "@/components/PlanCard";
import { CvReader, type CvApply } from "@/components/CvReader";
import { JobTitles, type Title } from "@/components/JobTitles";
import { Leg } from "@/components/Leg";
import { GOALS, GoalPicker } from "@/components/GoalPicker";
import { AskBar } from "@/components/AskBar";
import { ChatPanel, type Turn } from "@/components/ChatPanel";
import { AboutData } from "@/components/AboutData";
import { DEFAULT_SEARCH, loadLocation, loadSearch, placeName, saveSearch, SEARCH_EVENT, type Search } from "@/lib/location";
import { LocationEditor } from "@/components/LocationEditor";
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
import { findStep, logSession, planFromAction, updateStep, type Plan } from "@/lib/plan";
import {
  activePlan,
  addFound,
  EMPTY as EMPTY_WORKSPACE,
  EXPLORE,
  loadWorkspace,
  newId,
  otherChatsForChat,
  otherPlansForChat,
  removePlan,
  saveWorkspace,
  setOpeningStatus,
  upsertPlan,
  type Workspace,
} from "@/lib/workspace";
import { PlanTabs, PlansList } from "@/components/PlanTabs";

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
  const [city, setCity] = useState<CityMap | null>(null);
  // plans and their conversations (workspace.ts); `plan` is the one whose tab is open, if any
  const [ws, setWsState] = useState<Workspace>(EMPTY_WORKSPACE);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const updateWs = (fn: (w: Workspace) => Workspace) =>
    setWsState((w) => {
      const next = fn(w);
      saveWorkspace(next);
      return next;
    });
  const plan = activePlan(ws);
  const [busyChats, setBusyChats] = useState<Record<string, boolean>>({});
  const [planSavedAt, setPlanSavedAt] = useState<number | undefined>(undefined);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [search, setSearchState] = useState<Search>(DEFAULT_SEARCH);
  useEffect(() => {
    const sync = () => setSearchState(loadSearch());
    sync();
    window.addEventListener(SEARCH_EVENT, sync);
    return () => window.removeEventListener(SEARCH_EVENT, sync);
  }, []);
  const setSearch = (next: Search) => {
    setSearchState(next);
    saveSearch(next);
  };
  // their top next jobs: fetch openings in the background once per new list, so a first search is a lookup
  const warmed = useRef("");
  const warmOpenings = (codes: number[]) => {
    const where = loadLocation();
    const key = `${codes.join(",")}|${where.city}|${where.country}`;
    if (!codes.length || key === warmed.current) return;
    warmed.current = key;
    api.warmOpenings(codes, where.city, where.country);
  };
  /** Replace one plan (null removes it, with its conversation). */
  const setPlanById = (id: string, next: Plan | null) =>
    updateWs((w) => (next ? { ...w, plans: w.plans.map((p) => (p.id === id ? { ...next, id } : p)) } : removePlan(w, id)));
  const openTab = (id: string) => updateWs((w) => ({ ...w, active: id }));
  // another tab: its plan starts at the top of the side panel, not where the last one was scrolled to
  useEffect(() => {
    document.querySelector(".board-compact")?.scrollTo({ top: 0 });
  }, [ws.active]);
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
          warmOpenings(d.results.slice(0, 5).map((r) => r.census));
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
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  useEffect(() => {
    const saved = loadWorkspace();
    setWsState(saved);
    if (Object.values(saved.chats).some((t) => t.length)) setChatMode(true); // returning with a conversation
  }, []);
  /** Each conversation writes to its own history, even while another tab is open. */
  const setTurnsFor = (id: string) => (fn: (t: Turn[]) => Turn[]) =>
    updateWs((w) => ({ ...w, chats: { ...w.chats, [id]: fn((w.chats[id] ?? []) as Turn[]) } }));
  const askFromMap = (question: string) => {
    setPendingQuestion(question);
    setChatMode(true);
  };
  const [viewing, setViewing] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ census: number; at: number } | null>(null);
  /** The plan an action from conversation `chatId` is about: that tab's plan, else the one with a matching step
   * (or occupation), so an action from Explore still lands somewhere sensible. */
  const planFor = (w: Workspace, chatId: string, match?: (p: Plan) => boolean) =>
    w.plans.find((p) => p.id === chatId && (!match || match(p))) ?? (match ? w.plans.find(match) : undefined);

  const onChatAction = (action: ChatAction, chatId: string) => {
    if (action.type === "set_location") {
      setSearch({ places: action.places, remote: action.remote, confirmed: true });
      return;
    }
    if (action.type === "save_plan") {
      updateWs((w) => {
        const previous = w.plans.find((p) => p.census === action.census) ?? null;
        const { ws: next, id, created } = upsertPlan(w, planFromAction(action, previous));
        return created ? { ...next, active: id } : next; // a new plan opens its own tab
      });
      setPlanSavedAt(Date.now());
      return;
    }
    if (action.type === "suggest_replies") return; // shown in the chat itself
    if (action.type === "log_practice" || action.type === "update_step") {
      updateWs((w) => {
        const target = planFor(w, chatId, (p) => !!findStep(p, action.title));
        const step = target && findStep(target, action.title);
        if (!target || !step) return w;
        const changed =
          action.type === "log_practice" ? logSession(target, step.id) : updateStep(target, step.id, { resources: action.resources });
        return { ...w, plans: w.plans.map((p) => (p.id === target.id ? changed : p)) };
      });
      return;
    }
    if (action.type === "openings_found") {
      updateWs((w) => {
        const target = w.plans.find((p) => p.census === action.census);
        return target ? { ...w, plans: w.plans.map((p) => (p.id === target.id ? addFound(p, action.openings) : p)) } : w;
      });
      return;
    }
    if (action.type === "track_application") {
      updateWs((w) => {
        const matches = (p: Plan) => (p.openings ?? []).some((o) => o.url === action.url);
        const target = planFor(w, chatId, matches);
        return target
          ? { ...w, plans: w.plans.map((p) => (p.id === target.id ? setOpeningStatus(p, action.url, action.status) : p)) }
          : w;
      });
      return;
    }
    if (action.type === "open_job") {
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
    const blob = new Blob([JSON.stringify({ app: "job-transit", version: 2, profile, jobLabel, extraLabels, cv, plans: ws.plans, search }, null, 2)], {
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
      if (Array.isArray(saved.plans)) {
        // plans come back with fresh, empty conversations (conversations aren't in the file)
        const plans = (saved.plans as Plan[]).filter((p) => Array.isArray(p.steps)).map((p) => ({ ...p, id: p.id ?? newId() }));
        updateWs(() => ({ plans, chats: Object.fromEntries([[EXPLORE, []], ...plans.map((p) => [p.id!, []])]), active: EXPLORE }));
      }
      if (saved.search?.places) setSearch(saved.search);
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
    updateWs(() => EMPTY_WORKSPACE);
    setDrawerOpen(false);
    setOnboarding(true);
  };

  const request = profile;
  const planMove = (stop: { census: number; title: string }) => {
    setFocus({ census: stop.census, at: Date.now() });
    const existing = ws.plans.find((p) => p.census === stop.census);
    if (existing) openTab(existing.id!); // already planned: open it
    else {
      openTab(EXPLORE);
      setPendingQuestion(`Make me a plan for moving to “${stop.title}”.`);
    }
    setChatMode(true);
  };
  // reminders cover every plan: the server keeps one list per address
  const allPlans: Plan | undefined = ws.plans.length
    ? {
        census: ws.plans[0].census,
        occupation: ws.plans.map((p) => p.name || p.occupation).join(", "),
        summary: "",
        created: ws.plans[0].created,
        steps: ws.plans.flatMap((p) =>
          p.steps.map((st) => (ws.plans.length > 1 ? { ...st, title: `${p.name || p.occupation}: ${st.title}` } : st)),
        ),
      }
    : undefined;
  const chatIds = [EXPLORE, ...ws.plans.map((p) => p.id!)];

  return (
    <>
      <header className="topbar">
        <Logo />
        <span className="brand">Job Transit</span>
        <span className="tagline">Plan your next job</span>
        <span className="topbar-actions">
          <button type="button" className="top-button top-guide" onClick={() => setChatMode(!chatMode)}>
            {chatMode ? "Map view" : "Ask the guide"}
          </button>
          <button type="button" className="top-button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
            {drawerOpen ? "Hide your profile" : "Your profile"}
          </button>
          <button type="button" className="linkish hide-narrow" onClick={() => setAboutOpen(true)}>
            About the data
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
          <div className="profile-head">
            <h2>Your profile</h2>
            <p className="q-help">The guide fills this in as you chat. Click any part to change it.</p>
          </div>
          <div className="profile-card">
          <Leg
            title="Your CV"
            value={cv ? <span className="clamp">{cv.summary}</span> : undefined}
            empty="Add your CV to fill in your roles, education and skills"
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
            value={
              titles.length || profile.description || profile.experience_years !== null ? (
                <>
                  {(titles.length > 0 || profile.experience_years !== null) && (
                    <span className="leg-line">
                      {titles.length > 0 && <strong>{titles.map((t) => t.label).join(" · ")}</strong>}
                      {profile.experience_years !== null &&
                        `${titles.length > 0 ? " ·\u00a0" : ""}${yearsText(profile.experience_years)}`}
                    </span>
                  )}
                  {profile.description && <span className="clamp">{profile.description}</span>}
                </>
              ) : undefined
            }
            empty="Your job title and what the work actually involves"
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
            title="Interests"
            value={
              profile.chips.length || profile.hobbies ? (
                <>
                  {profile.hobbies && <span className="clamp">{profile.hobbies}</span>}
                  {profile.chips.length > 0 && (
                    <span className="chips">
                      {profile.chips.map((c) => (
                        <span key={c} className="chip static small">
                          {c}
                        </span>
                      ))}
                    </span>
                  )}
                </>
              ) : undefined
            }
            empty="Hobbies, and topics you enjoy or would like to work with"
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
            title="What you want from a change"
            value={profile.goals.length ? GOALS.filter((g) => profile.goals.includes(g.id)).map((g) => g.label).join(" · ") : undefined}
            empty="More pay, a growing field, less AI, room for what you love"
          >
            <p className="q-help">Pick any. It changes the order of your next jobs, never what you can see.</p>
            <GoalPicker goals={profile.goals} onToggle={toggleGoal} />
          </Leg>

          <Leg title="Education" value={profile.education ?? undefined} empty="Used to show what each move would take">
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

          <Leg
            title="Where you're looking"
            value={
              <span className="leg-line">
                {search.places.map(placeName).join(" · ")}
                {search.remote && " · open to remote"}
                {!search.confirmed && " (a guess: is this right?)"}
              </span>
            }
            empty="Cities you'd work in, and whether remote is fine"
          >
            <LocationEditor search={search} onChange={setSearch} />
          </Leg>
          </div>

          <div className="profile-file">
            <span className="q-help">Your profile and plans stay in this browser. Save them to a file to pick them up on another device.</span>
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

        <div className="chat-column" hidden={!chatMode}>
          <PlanTabs plans={ws.plans} active={ws.active} busy={busyChats} onSelect={openTab} />
          {chatIds.map((id) => {
            const own = ws.plans.find((p) => p.id === id) ?? null;
            return (
              <ChatPanel
                key={id}
                hidden={id !== ws.active}
                turns={(ws.chats[id] ?? []) as Turn[]}
                setTurns={setTurnsFor(id)}
                profile={profile}
                selected={viewing}
                onAction={(action) => onChatAction(action, id)}
                pendingQuestion={id === ws.active ? pendingQuestion : null}
                onPendingSent={() => setPendingQuestion(null)}
                plan={own}
                extraBody={() => ({
                  other_plans: otherPlansForChat(wsRef.current, id),
                  other_chats: otherChatsForChat(wsRef.current, id),
                })}
                onBusy={(b) => setBusyChats((m) => (m[id] === b ? m : { ...m, [id]: b }))}
                placeholder={own ? `Ask about your ${own.name || own.occupation} plan` : undefined}
              />
            );
          })}
        </div>
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
          planSavedAt={planSavedAt}
          loading={loading}
          onAbout={() => setAboutOpen(true)}
          onOpeningsFound={(census, openings) => onChatAction({ type: "openings_found", census, openings }, EXPLORE)}
        >
          {!plan && ws.plans.length > 0 && (
            <PlansList
              plans={ws.plans}
              onOpen={(id) => {
                openTab(id);
                setChatMode(true);
              }}
            />
          )}
          {plan && (
            <PlanCard
              plan={plan}
              emailPlan={allPlans}
              onChange={(next) => setPlanById(plan.id!, next)}
              onPractice={(step) => {
                setPendingQuestion(`Give me a short practice session for this step of my plan: “${step.title}”`);
                setChatMode(true);
              }}
              onHelp={(step) => {
                setPendingQuestion(`Help me get started on this step of my plan: “${step.title}”`);
                setChatMode(true);
              }}
              onOpenStop={(census) => setFocus({ census, at: Date.now() })}
              savedAt={planSavedAt}
            />
          )}
        </Board>
      </main>
      {aboutOpen && <AboutData onClose={() => setAboutOpen(false)} />}
    </>
  );
}

function yearsText(years: number) {
  if (years < 1) return "under a year of experience";
  return `${Math.round(years)} year${Math.round(years) === 1 ? "" : "s"} of experience`;
}
