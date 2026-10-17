"""The guide: a chat assistant grounded in the planner's own data.

Claude gets tools that wrap the engine (job search, recommendations, stop details) plus "app actions" that change
what the person sees (open a stop, update their profile). The reply streams to the browser as server-sent events:
  {"type": "text", "text": ...}          a piece of the answer
  {"type": "tool", "label": ...}         what the guide is looking up (shown as a status line)
  {"type": "action", "action": {...}}    something the app should do (open a stop, change the profile)
  {"type": "error", "message": ...} / {"type": "done"}
Configure with ANTHROPIC_API_KEY and optionally CHAT_MODEL in .env.
"""
import json
import os
from dataclasses import replace

import anthropic
from dotenv import load_dotenv

from api.engine import Engine, Profile
from api.openings import COUNTRIES, find_openings

load_dotenv()

CHAT_MODEL = os.getenv("CHAT_MODEL", "claude-sonnet-5-5")
MAX_TOOL_ROUNDS = 6
GOALS = ["pay", "stability", "less_ai", "passion"]

SYSTEM = """You are the guide in Job Transit, an app that helps people plan a career change. The app shows a map \
("Job City") where every block is an occupation and neighbours need similar skills; the person's next stops are \
ranked by real US job moves (Current Population Survey 2015-2021), skill fit, their interests and their goals.

How to work:
- Ground every factual claim about jobs (pay, growth, AI exposure, how common a move is, skill gaps) in tool results. \
Never invent numbers. If the data doesn't cover something, say so.
- General advice (how to learn a skill, how to network, what a portfolio should show) is fine, but say it is general \
advice rather than something from the data.
- Be concise and concrete: short paragraphs or a short list; plain words; no hype.
- Use app actions when they help the person see things: open the stop you are discussing; update their profile when \
they tell you something new about themselves (goals, hobbies, experience, a second job title). Say what you changed.
- Be honest about limits: the data places people by the kind of work, not seniority; some jobs (product designer, \
consultant) only exist inside broad census groups; pay and growth are US figures.
- find_openings searches live job boards (Adzuna, 80,000 Hours, Arbeitnow, AI company boards) for one occupation. \
Show a few concrete postings with their links. For counts, use by_place (in their city / remote / elsewhere), not \
total_matched alone. If a source wasn't searched, pass on its reason (for example "still loading after a restart, try \
again in a few minutes"). Use the person's city unless they ask about another place.
- A stop marked your_title is one of the person's own job titles, not a move.
- When they ask for a plan for a move: call stop_details for that stop first, then save_plan with 3 to 6 steps. \
Steps must be concrete and specific to this person and this job: name the actual skills from the gaps and tasks, \
what to build or learn and how to show it, who to talk to, and when to start applying. Give each step a realistic \
week to aim for. Prefer steps they can start this week. After saving, say in one or two sentences that the plan is \
in their plan panel, where they can tick steps off and add reminders to their calendar; don't repeat every step. \
If they ask to change the plan, call save_plan again with the whole revised plan.
- Occupations are identified by census codes; get them from search_jobs or recommend, never guess them.

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
        "description": ("Ranked next stops for the person, optionally with changes to their profile to explore "
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
        "name": "stop_details",
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
                        },
                        "required": ["title", "detail", "week"],
                    },
                },
            },
            "required": ["census", "summary", "steps"],
        },
    },
    {
        "name": "open_stop",
        "description": "App action: open a destination's stop page on the map so the person can see it.",
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

TOOL_LABELS = {
    "search_jobs": lambda a: f"Searching jobs for “{a.get('query', '')}”",
    "recommend": lambda a: "Ranking next stops" + (" with different settings" if a else ""),
    "stop_details": lambda a: "Looking up a stop",
    "find_openings": lambda a: "Searching job boards" + (f" in {a['city']}" if a.get("city") else ""),
    "save_plan": lambda a: "Saving your plan",
    "open_stop": lambda a: "Opening the stop on the map",
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
                lines.append("Their top stops now: " + "; ".join(
                    f"{r['title']} (census {r['census']}, {r.get('reach_label', '')})" for r in rec["results"][:8]))
        except Exception as error:  # the chat still works without the summary
            lines.append(f"(Couldn't compute recommendations: {error})")
        if plan and plan.get("steps"):
            steps = "; ".join(f"{'[done] ' if st.get('done') else ''}{st.get('title', '')}" for st in plan["steps"][:8])
            lines.append(f"Their saved plan, toward {plan.get('occupation', '?')} (census {plan.get('census')}): {steps}")
        if location:
            lines.append(f"Looking for work in: {location['city']} ({location['country']})")
        if selected is not None and selected in e.position:
            lines.append(f"They are looking at the stop page for: {e.census.at[selected, 'title']} (census {selected})")
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
                    "stops": [_job_summary(r) | ({"your_title": True} if r["census"] in own else {})
                              for r in rec["results"]]}, None
        if name == "stop_details":
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
        if name == "save_plan":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code; use search_jobs"}, None
            steps = [{"title": str(st.get("title", ""))[:80], "detail": str(st.get("detail", ""))[:400],
                      "week": max(1, min(52, int(st.get("week") or 1)))}
                     for st in (args.get("steps") or [])[:8] if st.get("title")]
            if len(steps) < 2:
                return {"error": "a plan needs at least 2 steps"}, None
            return {"ok": True, "saved_steps": len(steps)}, {
                "type": "save_plan", "census": code, "occupation": e.census.at[code, "title"],
                "summary": str(args.get("summary", ""))[:300], "steps": steps}
        if name == "open_stop":
            code = args.get("census")
            if code not in e.position:
                return {"error": "unknown census code"}, None
            return {"ok": True, "opened": e.census.at[code, "title"]}, {"type": "open_stop", "census": code}
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
                                                 tools=TOOLS, messages=convo) as stream:
                    for text in stream.text_stream:
                        yield event({"type": "text", "text": text})
                    final = stream.get_final_message()
                convo.append({"role": "assistant", "content": [block.model_dump(exclude_none=True) for block in final.content]})
                if final.stop_reason != "tool_use":
                    break
                results = []
                for block in final.content:
                    if block.type != "tool_use":
                        continue
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
