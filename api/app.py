"""Job Transit API.  Run from the repo root:  uv run uvicorn api.app:app --reload --port 8000"""
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from api.chat import Guide
from api.cv import read_cv
from api.engine import Engine, Profile
from api.openings import find_openings, start_collector

app = FastAPI(title="Job Transit")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
engine = Engine()
start_collector(engine)   # job board postings, collected in the background (api/openings.py)
guide = None  # created on first chat, so the API starts without an Anthropic key


class ProfileIn(BaseModel):
    job: int | None = None
    extra_jobs: list[int] = Field(default_factory=list)
    answers: dict[str, float] = Field(default_factory=dict)
    chips: list[str] = Field(default_factory=list)
    quiz: dict[str, float] = Field(default_factory=dict)
    education: str | None = None
    description: str | None = None
    activities: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    hobbies: str | None = None
    goals: list[str] = Field(default_factory=list)
    experience_years: float | None = Field(default=None, ge=0, le=60)


class RecommendIn(BaseModel):
    profile: ProfileIn
    sort: Literal["best", "reachable", "appealing"] = "best"
    limit: int = Field(30, ge=1, le=600)


@app.get("/health")
def health():
    return {"ok": True, "occupations": len(engine.codes)}


@app.get("/meta")
def meta():
    """Survey items, interest chips, quiz activities and education options for the UI."""
    m = engine.meta
    return {k: m[k] for k in ["items", "chips", "quiz", "education_ladder", "families", "riasec_order"]}


@app.get("/map")
def city_map():
    """Job City: every occupation's map position, the districts and the busiest real moves (transit lines)."""
    return engine.city


@app.get("/jobs/search")
def search_jobs(q: str, limit: int = 8):
    return engine.search_jobs(q, limit)


@app.get("/occupations/{code}")
def occupation(code: int):
    if code not in engine.position:
        raise HTTPException(404, "Unknown occupation code")
    return engine.occupation(code)


class StopIn(BaseModel):
    profile: ProfileIn
    census: int


@app.post("/stop")
def stop(body: StopIn):
    """The stop page: what the job is, why it fits, the skill gap, how to get there, and the outlook."""
    if body.census not in engine.position:
        raise HTTPException(404, "Unknown occupation code")
    return engine.stop_details(Profile(**body.profile.model_dump()), body.census)


class PlaceIn(BaseModel):
    statements: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    k: int = Field(5, ge=1, le=50)


@app.post("/place")
def place(body: PlaceIn):
    """Occupations that best match what someone does (for evaluation and debugging)."""
    if engine.placer is None:
        raise HTTPException(503, "Placement assets are not built (api/build_embeddings.py).")
    result = engine.placer.place(body.statements, body.tools, k=body.k)
    if result is None:
        return {"stations": [], "evidence": [], "tools": []}
    return {
        "stations": [{"census": int(engine.codes[s]), "title": engine.census["title"].iat[s], "weight": round(float(w), 4)}
                     for s, w in zip(result["stations"], result["weights"])],
        "evidence": result["evidence"],
        "tools": result["tools"],
    }


@app.post("/recommend")
def recommend(body: RecommendIn):
    if body.profile.job is not None and body.profile.job not in engine.position:
        raise HTTPException(400, "Unknown occupation code for job")
    return engine.recommend(Profile(**body.profile.model_dump()), sort=body.sort, limit=body.limit)


class CvIn(BaseModel):
    text: str | None = None
    pdf_base64: str | None = None


@app.post("/cv")
def cv(body: CvIn):
    """Read a CV (PDF or text) and return planner inputs the person can review before applying."""
    try:
        record = read_cv(engine.meta["items"], engine.meta["education_ladder"], body.text, body.pdf_base64)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:  # API errors (key, credits, network) come back as a readable message, not a bare 500
        raise HTTPException(502, f"Couldn't read the CV: {type(e).__name__}: {e}")

    job_matches = []
    for job in record.get("jobs", [])[:6]:
        top = engine.search_jobs(job["title"], limit=3)
        job_matches.append({"title": job["title"], "label": job.get("label") or job["title"], "years": job.get("years"),
                            "current": bool(job.get("current")), "kind": job.get("kind", "job"), "matches": top})

    known_items = set(engine.item_order)
    answers = {k: float(v) for k, v in (record.get("skill_ratings") or {}).items() if k in known_items}
    education = record.get("education")
    return {
        "summary": record.get("summary", ""),
        "jobs": job_matches,
        "education": education if education in engine.meta["education_ladder"] else None,
        "education_field": record.get("education_field") or None,
        "years_experience": record.get("years_experience"),
        "tools": record.get("tools", []),
        "activities": record.get("activities", []),
        "answers": answers,
    }


Country = Literal["de", "gb", "us", "nl", "at", "fr", "it", "pl", "ca", "au"]   # same as openings.COUNTRIES


class OpeningsIn(BaseModel):
    census: int
    city: str = Field(default="Berlin", max_length=80)
    country: Country = "de"


@app.post("/openings")
def openings(body: OpeningsIn):
    """Live postings for an occupation from Adzuna, 80,000 Hours, Arbeitnow and AI company boards."""
    if body.census not in engine.position:
        raise HTTPException(400, "Unknown occupation code")
    return find_openings(engine, body.census, body.city.strip(), body.country)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class Location(BaseModel):
    city: str = Field(default="Berlin", max_length=80)
    country: Country = "de"


class ChatIn(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    profile: ProfileIn
    selected: int | None = None
    location: Location | None = None
    plan: dict | None = None   # the saved plan, so the guide can discuss and revise it


@app.post("/chat")
def chat(body: ChatIn):
    """The guide: streams server-sent events (see api/chat.py)."""
    global guide
    if guide is None:
        guide = Guide(engine)
    return StreamingResponse(
        guide.stream([m.model_dump() for m in body.messages], Profile(**body.profile.model_dump()), body.selected,
                     body.location.model_dump() if body.location else None, body.plan),
        media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
