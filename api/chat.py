"""The guide: a chat assistant grounded in the planner's own data.

Claude gets tools that wrap the engine (job search, recommendations, job details) plus "app actions" that change
what the person sees (open a job on the map, update their profile). The reply streams to the browser as server-sent events:
  {"type": "text", "text": ...}          a piece of the answer
  {"type": "tool", "label": ...}         what the guide is looking up (shown as a status line)
  {"type": "action", "action": {...}}    something the app should do (open a job, change the profile)
  {"type": "error", "message": ...} / {"type": "done"}
Configure with ANTHROPIC_API_KEY and optionally CHAT_MODEL in .env.
"""
import json
import os
from dataclasses import replace

import anthropic
from dotenv import load_dotenv

from api.engine import Engine, Profile
from api.openings import COUNTRIES, find_openings, read_posting

load_dotenv()

CHAT_MODEL = os.getenv("CHAT_MODEL", "claude-sonnet-5-5")
MAX_TOOL_ROUNDS = 6
GOALS = ["pay", "stability", "less_ai", "passion"]

SYSTEM = """You are the guide in Job Transit, an app that helps people plan a career change. The app shows a map \
("Job City") where every block is an occupation and neighbours need similar skills; the person's next jobs are \
ranked by real US job moves (Current Population Survey 2015-2021), skill fit, their interests and their goals.

How to work:
- Ground every factual claim about jobs (pay, growth, AI exposure, how common a move is, skill gaps) in tool results. \
Never invent numbers. If the data doesn't cover something, say so.
- General advice (how to learn a skill, how to network, what a portfolio should show) is fine, but say it is general \
advice rather than something from the data.
- Be concise and concrete: short paragraphs or a short list; plain words; no hype.
- Use app actions when they help the person see things: open the job you are discussing; update their profile when \
they tell you something new about themselves (goals, hobbies, experience, a second job title). Say what you changed.
- Be honest about limits: the data places people by the kind of work, not seniority; some jobs (product designer, \
consultant) only exist inside broad census groups; pay and growth are US figures.
- find_openings searches live job boards (Adzuna, 80,000 Hours, Arbeitnow, AI company boards) for one occupation. \
Show a few concrete postings with their links. For counts, use by_place (in their city / remote / elsewhere), not \
total_matched alone. If a source wasn't searched, pass on its reason (for example "still loading after a restart, try \
again in a few minutes"). Use the person's city unless they ask about another place.
- A job marked your_title is one of the person's own job titles, not a move.
- Before the first plan for a move, if you don't know it yet, ask how much time they can give it (hours a week) and \
when they would like to have switched; offer typical answers as suggestions ("A few hours a week", "Evenings and \
weekends", "I can study full-time"). Base every step's week on their answer, say the dates are a suggestion, and \
never invent a timeline they didn't agree to.
- Never quote the 1-5 skill ratings (like "needed 4.7, you 1.3") to the person: they are abstract. Say the gap in \
words ("you'd be starting from scratch on building and construction") and turn it into what to learn or practise.
- Pay, growth and AI figures come from the US Bureau of Labor Statistics (BLS). They are good for comparing jobs with \
each other (which pays more, which is growing), so use them that way and always say they are US figures. Don't present \
a US salary as what they would earn where they live; if local pay matters, look it up with web_search.
- When they ask for a plan for a move: call job_details for that job first, then save_plan with 3 to 6 steps. \
Steps must be concrete and specific to this person and this job: name the actual skills from the gaps and tasks, \
what to build or learn and how to show it, who to talk to, and when to start applying. Give each step a realistic \
week to aim for. Prefer steps they can start this week. After saving, say in one or two sentences that the plan is \
in their plan panel, where they can tick steps off; then ask whether they'd like email reminders when steps \
and practice sessions are due (they turn them on with "Get email reminders" in the plan panel). Don't repeat every \
step. \
If they ask to change the plan, call save_plan again with the whole revised plan; steps they added themselves are \
kept automatically, so don't repeat them.
- web_search finds real, current resources: courses, practice sites, programs, meetups, events, people to follow. \
Use it for plan steps and for "help me start" requests, not for facts the job data already covers (pay, growth, AI \
exposure, moves). Link what you recommend as Markdown links, prefer free or well-known options, and say when \
something costs money. Keep it to a few good options rather than a long list.
- When they ask for help starting a step of their plan: find 2 or 3 concrete resources with web_search and answer \
in your reply: the resources with a line each on why, a first small action for this week, and anything you offer \
to draft (an email, a message) written out in full in the reply itself. Then save just the links on the step with \
update_step. Your reply is what they read; never point to "the chat" or "below" for something you haven't written.
- When drafting a plan, you may include a link or two in a step's detail if you searched for them. Mark steps that \
build a skill or knowledge as kind "learn": the app schedules short practice sessions for them after 1, 3, 7, 14 and \
30 days (spaced repetition), with reminders.
- When they ask for a practice session on a step: run a short (about 10 minute) session of retrieval practice. Ask \
one question or give one small exercise at a time, wait for their answer, give brief feedback, and adjust the \
difficulty; 3 to 5 questions in total, mixing recall with applying it. Base it on what that step is about and what \
they have practised before. When the session is done, call log_practice with the step's title and say when the \
next session is due. If they only want to mark a session as done, call log_practice. In a practice session, either ask an open \
question and skip suggest_replies (they type the answer; recalling it is the point), or ask a real multiple-choice \
question: then suggest_replies holds 3 options, the right one plus two plausible wrong ones, in random order, \
written alike so the right one doesn't stand out. Mix both kinds. Never put a lone answer next to filler options.
- End every reply (except an open practice question) by calling suggest_replies, on its own, after you have written your final text: never in the \
same step as another tool. Give it 2 or 3 short things the person might say next, in their own voice \
("Make me a plan for this", "What about remote roles?"). If you asked them a question about themselves, offer likely answers (never for quiz or practice questions). If \
something important about them is still unknown (what they want from a change, years of experience, their city, \
what they enjoy), make one suggestion a quick way to tell you ("I care most about pay").
- Occupations are identified by census codes; get them from search_jobs or recommend, never guess them.
- When they ask about a specific posting, read it with read_posting before judging the fit, and point to the \
parts of the posting that match or don't match their profile.

The person's current situation:
{context}"""

TOOLS = [
    {
        "name": "search_jobs",
        "description": "Find occupations by job title. Returns census codes to use with the other tools.",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "recommend",
        "description": ("Ranked next jobs for the person, optionally with changes to their profile to explore "
                        "'what if' (different goals, a different starting job, more experience). Does not change "
                        "the app; use update_profile for that."),
        "input_schema": {
            "type": "object",
            "properties": {
                "job": {"type": "integer", "description": "Census code of a different starting job."},
                "goals": {"type": "array", "items": {"type": "string", "enum": GOALS}},
                "hobbies": {"type": "string"},
                "experience_years": {"type": "number"},
                "sort": {"type": "string", "enum": ["best", "reachable", "appealing"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 15},
            },
        },
    },
    {
        "name": "job_details",
        "description": ("Everything about one destination relative to where the person starts: what the job is, "
                        "how common the move is, skill gaps and what transfers, pay change, growth, AI exposure, "
                        "entry education and experience needed."),
        "input_schema": {"type": "object", "properties": {"census": {"type": "integer"}}, "required": ["census"]},
    },
    {
        "name": "find_openings",
        "description": ("Live job postings for one occupation from job boards, postings in the city first, then "
                        "remote, then elsewhere. Each posting's title is checked against the occupation."),
        "input_schema": {
            "type": "object",
            "properties": {
                "census": {"type": "integer"},
                "city": {"type": "string", "description": "Defaults to the person's city."},
                "country": {"type": "string", "enum": COUNTRIES, "description": "Two-letter code; defaults to theirs."},
            },
            "required": ["census"],
        },
    },
    {
        "name": "read_posting",
              "description": "Read the full text of one job posting from its link (from find_openings results) to determine "
                       "if it fits the person's profile or to suggest adjusting a CV. The result says whether it is the "
                       "full posting or only a short snippet.",
        "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
    },
    {
        "name": "save_plan",
        "description": ("App action: save a step-by-step plan for moving to one occupation. It appears in the app as a "
                        "to-do list with dates, replacing any earlier plan."),
        "input_schema": {
            "type": "object",
            "properties": {
                "census": {"type": "integer", "description": "The destination's census code."},
                "summary": {"type": "string", "description": "One sentence: the move and the main thing to close."},
                "steps": {
                    "type": "array", "minItems": 2, "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "Short imperative, under 60 characters."},
                            "detail": {"type": "string", "description": "One or two concrete sentences."},
                            "week": {"type": "integer", "minimum": 1, "maximum": 52,
                                     "description": "Week from now to aim to finish it by."},
                            "kind": {"type": "string", "enum": ["learn", "do"],
                                     "description": ("learn: building a skill or knowledge (gets spaced practice "
                                                     "sessions); do: a one-off action (apply, contact someone).")},
                        },
                        "required": ["title", "detail", "week"],
                    },
                },
            },
            "required": ["census", "summary", "steps"],
        },
    },
    {
        "name": "update_step",
        "description": ("App action: set the resource links shown under one step of their plan (replaces that step's "
                        "earlier resources). Only links with a few words each; the explanation belongs in your reply."),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "The step's current title, exactly as in their plan."},
                "resources": {"type": "array", "maxItems": 5,
                              "items": {"type": "string",
                                        "description": "One resource as a Markdown link plus a few words, e.g. "
                                                       "'[SQLBolt](https://sqlbolt.com): free interactive lessons'."}},
            },
            "required": ["title", "resources"],
        },
    },
    {
        "name": "log_practice",
        "description": "App action: record that the person just finished a practice session for one learning step.",
        "input_schema": {"type": "object", "properties": {"title": {"type": "string", "description": "The step's title."}},
                         "required": ["title"]},
    },
    {
        "name": "suggest_replies",
        "description": "App action: show 2-3 tappable suggestions for the person's next message. Call it once, last.",
        "input_schema": {
            "type": "object",
            "properties": {"replies": {"type": "array", "minItems": 1, "maxItems": 3,
                                       "items": {"type": "string", "description": "Under 60 characters, first person."}}},
            "required": ["replies"],
        },
    },
    {
        "name": "open_job",
        "description": "App action: open a job's page on the map so the person can see it.",
        "input_schema": {"type": "object", "properties": {"census": {"type": "integer"}}, "required": ["census"]},
    },
    {
        "name": "update_profile",
        "description": ("App action: change the person's profile in the app. Only for things they told you or "
                        "agreed to. Fields left out stay as they are."),
        "input_schema": {
            "type": "object",
            "properties": {
                "goals": {"type": "array", "items": {"type": "string", "enum": GOALS},
                          "description": "Replaces their goals."},
                "hobbies": {"type": "string", "description": "Replaces their hobbies text."},
                "experience_years": {"type": "number"},
                "add_title": {"type": "integer", "description": "Census code to add as a second job title (hybrid roles)."},
            },
        },
    },
]

WEB_SEARCH_MAX_USES = 3   # per request round; $10 per 1,000 searches plus the result tokens


def tools_for(location: dict | None) -> list[dict]:
    """Our tools plus Claude's server-side web search, localized to the person's city when we know it."""
    search = {"type": "web_search_20250305", "name": "web_search", "max_uses": WEB_SEARCH_MAX_USES}
    if location and location.get("city"):
        search["user_location"] = {"type": "approximate", "city": location["city"],
                                   "country": (location.get("country") or "de").upper()}
    return TOOLS + [search]


TOOL_LABELS = {
    "search_jobs": lambda a: f"Searching jobs for “{a.get('query', '')}”",
    "recommend": lambda a: "Ranking next jobs" + (" with different settings" if a else ""),
    "job_details": lambda a: "Looking up the job",
    "find_openings": lambda a: "Searching job boards" + (f" in {a['city']}" if a.get("city") else ""),
    "save_plan": lambda a: "Saving your plan",
    "update_step": lambda a: "Updating your plan",
    "log_practice": lambda a: "Logging your practice session",
    "read_posting": lambda a: "Reading the posting",
    "open_job": lambda a: "Opening the job on the map",
    "update_profile": lambda a: "Updating your profile",
}


def _json(obj) -> str:
    return json.dumps(obj, default=lambda o: o.item() if hasattr(o, "item") else str(o))


OWN_TITLE_NOTE = ("This is one of the person's own job titles, not a move, so there is no move frequency or skill "
                  "match for it. Say so plainly rather than calling the figures missing.")


def _job_summary(row: dict) -> dict:
    keep = ["census", "title", "reach_label", "median_wage", "growth_pct", "bls_ai_exposure", "ai_theoretical",
            "entry_education", "work_experience", "skill_match", "appeal_pct", "family"]
    return {k: row.get(k) for k in keep if row.get(k) is not None}


class Guide:
    def __init__(self, engine: Engine):
        self.engine = engine
        self.client = anthropic.Anthropic()

    # ---- context and tools -----------------------------------------------------------------
    def context(self, profile: Profile, selected: int | None, location: dict | None = None, plan: dict | None = None) -> str:
        e = self.engine
        lines = []
        if profile.job is not None and profile.job in e.position:
            titles = [e.census.at[profile.job, "title"]] + [e.census.at[j, "title"] for j in profile.extra_jobs if j in e.position]
            lines.append(f"Job title(s): {', '.join(titles)} (census {profile.job})")
        if profile.description:
            lines.append(f"Describes their work as: {profile.description}")
        if profile.activities:
            lines.append(f"From their CV: {'; '.join(profile.activities[:10])}")
        if profile.experience_years is not None:
            lines.append(f"Experience: about {profile.experience_years:g} years")
        if profile.education:
            lines.append(f"Education: {profile.education}")
        if profile.hobbies:
            lines.append(f"Hobbies: {profile.hobbies}")
        if profile.chips:
            lines.append(f"Interests: {', '.join(profile.chips)}")
        if profile.goals:
            lines.append(f"Wants from a change: {', '.join(profile.goals)}")
        try:
            rec = e.recommend(profile, limit=8)
            if rec.get("origin"):
                lines.append(f"Placed at: {rec['origin']['title']}")
            if rec.get("results"):
                lines.append("Their top next jobs now: " + "; ".join(
                    f"{r['title']} (census {r['census']}, {r.get('reach_label', '')})" for r in rec["results"][:8]))
        except Exception as error:  # the chat still works without the summary
            lines.append(f"(Couldn't compute recommendations: {error})")
        if plan and plan.get("steps"):
            def describe(st):
                tags = ["done"] * bool(st.get("done")) + ["added by them"] * bool(st.get("mine"))
                sessions = st.get("sessions") or []
                if sessions:
                    left = [x for x in sessions if not x.get("done")]
                    tags.append(f"learning: {len(sessions) - len(left)}/{len(sessions)} practice sessions"
                                + (f", next {left[0].get('due')}" if left else ""))
                return (f"[{'; '.join(tags)}] " if tags else "") + str(st.get("title", ""))
            steps = "; ".join(describe(st) for st in plan["steps"][:12])
            lines.append(f"Their saved plan, toward {plan.get('occupation', '?')} (census {plan.get('census')}): {steps}")
        if location:
            lines.append(f"Looking for work in: {location['city']} ({location['country']})")
        if selected is not None and selected in e.position:
            lines.append(f"They are looking at the job page for: {e.census.at[selected, 'title']} (census {selected})")
        return "\n".join(lines) or "They haven't told the app anything yet."

    def run_tool(self, name: str, args: dict, profile: Profile, location: dict | None = None):
        """Returns (result for Claude, app action or None)."""
        e = self.engine
        if name == "search_jobs":
            return e.search_jobs(args.get("query", ""), limit=5), None
        if name == "recommend":
            changes = {k: args[k] for k in ("job", "goals", "hobbies", "experience_years") if k in args}
            if "job" in changes and changes["job"] not in e.position:
                return {"error": "unknown census code; use search_jobs"}, None
            asked = replace(profile, **changes)
            rec = e.recommend(asked, sort=args.get("sort", "best"), limit=args.get("limit", 8))
            origin = rec.get("origin") or {}
            own = {asked.job, *asked.extra_jobs}
            return {"starting_from": origin.get("title"), "mix": origin.get("mix"),
                    "jobs": [_job_summary(r) | ({"your_title": True} if r["census"] in own else {})
                              for r in rec["results"]]}, None
        if name == "job_details":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code; use search_jobs"}, None
            d = e.stop_details(profile, code)
            occ = d.get("occupation", {})
            return {"job": _job_summary(occ), "description": d.get("description"), "tasks": d.get("tasks", [])[:4],
                    "includes": d.get("example_titles") if d.get("catch_all") else None,
                    "move": d.get("reach"), "skill_gaps": d.get("gaps"), "transfers": d.get("transfers"),
                    "pay_change_pct": d.get("pay_change_pct"), "experience_note": d.get("experience_note"),
                    "on_the_job_training": occ.get("on_the_job_training"),
                    "note": OWN_TITLE_NOTE if code in {profile.job, *profile.extra_jobs} else None}, None
        if name == "find_openings":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code; use search_jobs"}, None
            where = location or {"city": "Berlin", "country": "de"}
            found = find_openings(e, code, args.get("city") or where["city"], args.get("country") or where["country"], limit=10)
            for p in found["openings"]:
                p["where"] = ["elsewhere", "remote", "in their city"][p.pop("near")]
            return found, None
        if name == "read_posting":   # Tim: the function is in api/openings.py
            return read_posting(args.get("url", "")), None
        if name == "save_plan":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code; use search_jobs"}, None
            steps = [{"title": str(st.get("title", ""))[:80], "detail": str(st.get("detail", ""))[:600],
                      "week": max(1, min(52, int(st.get("week") or 1))),
                      "kind": "learn" if st.get("kind") == "learn" else "do"}
                     for st in (args.get("steps") or [])[:8] if st.get("title")]
            if len(steps) < 2:
                return {"error": "a plan needs at least 2 steps"}, None
            return {"ok": True, "saved_steps": len(steps)}, {
                "type": "save_plan", "census": code, "occupation": e.census.at[code, "title"],
                "summary": str(args.get("summary", ""))[:300], "steps": steps}
        if name == "update_step":
            title = str(args.get("title", "")).strip()
            resources = [str(r).strip()[:300] for r in (args.get("resources") or []) if str(r).strip()][:5]
            if not title or not resources:
                return {"error": "needs the step's title and at least one resource"}, None
            return {"ok": True}, {"type": "update_step", "title": title, "resources": resources}
        if name == "log_practice":
            title = str(args.get("title", "")).strip()
            return ({"ok": True}, {"type": "log_practice", "title": title}) if title else ({"error": "needs the step title"}, None)
        if name == "suggest_replies":
            replies = [str(r).strip()[:80] for r in (args.get("replies") or []) if str(r).strip()][:3]
            return {"ok": True}, ({"type": "suggest_replies", "replies": replies} if replies else None)
        if name == "open_job":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code"}, None
            return {"ok": True, "opened": e.census.at[code, "title"]}, {"type": "open_job", "census": code}
        if name == "update_profile":
            change = {k: args[k] for k in ("goals", "hobbies", "experience_years", "add_title") if k in args}
            if "add_title" in change:
                if change["add_title"] not in e.position:
                    return {"error": "unknown census code"}, None
                change["add_title_label"] = e.census.at[change["add_title"], "title"]
            return {"ok": True, "changed": list(change)}, {"type": "update_profile", **change}
        return {"error": f"unknown tool {name}"}, None

    # ---- the conversation ------------------------------------------------------------------
    def stream(self, messages: list[dict], profile: Profile, selected: int | None = None, location: dict | None = None,
               plan: dict | None = None):
        """Yields server-sent-event lines. `messages`: [{role: user|assistant, content: str}]."""
        def event(payload):
            return f"data: {_json(payload)}\n\n"

        try:
            system = SYSTEM.format(context=self.context(profile, selected, location, plan))
            convo = [{"role": m["role"], "content": m["content"]} for m in messages if m.get("content")]
            for _ in range(MAX_TOOL_ROUNDS):
                with self.client.messages.stream(model=CHAT_MODEL, max_tokens=2500, system=system,
                                                 tools=tools_for(location), messages=convo) as stream:
                    for ev in stream:
                        if ev.type == "text":
                            yield event({"type": "text", "text": ev.text})
                        elif (ev.type == "content_block_start"
                              and getattr(ev.content_block, "type", None) == "server_tool_use"):
                            yield event({"type": "tool", "label": "Searching the web"})
                    final = stream.get_final_message()
                # sent back unchanged: web search results carry encrypted content the API checks
                convo.append({"role": "assistant", "content": [block.model_dump(exclude_none=True) for block in final.content]})
                if final.stop_reason == "pause_turn":   # a long web search paused the turn: let Claude continue
                    continue
                if final.stop_reason != "tool_use":
                    break
                results, called = [], set()
                for block in final.content:
                    if block.type != "tool_use":
                        continue
                    called.add(block.name)
                    if block.name != "suggest_replies":   # suggestions are silent: no status line
                        label = TOOL_LABELS.get(block.name, lambda a: block.name)(block.input or {})
                        yield event({"type": "tool", "label": label})
                    try:
                        result, action = self.run_tool(block.name, block.input or {}, profile, location)
                    except Exception as error:  # report to Claude, keep going
                        result, action = {"error": str(error)}, None
                    if action:
                        yield event({"type": "action", "action": action})
                        if action["type"] == "update_profile":   # later tool calls see the change
                            profile = _apply(profile, action)
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": _json(result)})
                # A round that only suggests replies ends the answer. Anything else (even an app action like
                # save_plan) gets its result back, so Claude can tell the person what it did.
                if called == {"suggest_replies"}:
                    break
                convo.append({"role": "user", "content": results})
            yield event({"type": "done"})
        except anthropic.AuthenticationError:
            yield event({"type": "error", "message": "The chat needs a valid ANTHROPIC_API_KEY in .env."})
        except anthropic.APIError as error:
            yield event({"type": "error", "message": f"Claude API error: {getattr(error, 'message', error)}"})
        except Exception as error:
            yield event({"type": "error", "message": f"Something went wrong: {error}"})


def _apply(profile: Profile, action: dict) -> Profile:
    changes = {k: action[k] for k in ("goals", "hobbies", "experience_years") if k in action}
    if "add_title" in action and action["add_title"] not in profile.extra_jobs:
        changes["extra_jobs"] = profile.extra_jobs + [action["add_title"]]
    return replace(profile, **changes)


__all__ = ["Guide"]
