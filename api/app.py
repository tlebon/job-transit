"""Job Transit API.  Run from the repo root:  uv run uvicorn api.app:app --reload --port 8000"""
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from api.chat import Guide
from api.cv import read_cv
from api.engine import Engine, Profile
from api import mailer
from api.openings import find_openings, start_collector

app = FastAPI(title="Job Transit")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
engine = Engine()
start_collector(engine)   # job board postings, collected in the background (api/openings.py)
mailer.start_reminder_sender()   # emails what's due in people's plans (api/mailer.py)
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


# Claude costs money per call, so the endpoints that call it are rate limited: per address (generous, since a
# whole Demo Day room shares one wifi address) and a daily cap for everyone together.
CHAT_PER_HOUR = int(os.getenv("CHAT_PER_HOUR", "150"))
CHAT_PER_DAY = int(os.getenv("CHAT_PER_DAY", "2000"))
CV_PER_HOUR = int(os.getenv("CV_PER_HOUR", "20"))


def client_ip(request: Request) -> str:
    """The caller's address. Behind Railway's proxy request.client is the proxy, so use the address it appended
    (the last X-Forwarded-For entry; earlier ones come from the client and can be made up)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "?"


@app.post("/cv")
def cv(body: CvIn, request: Request):
    """Read a CV (PDF or text) and return planner inputs the person can review before applying."""
    if not mailer.allowed(f"cv:{client_ip(request)}", CV_PER_HOUR, 3600):
        raise HTTPException(429, "Too many CVs from here for now. Try again in an hour.")
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


class EmailPlanIn(BaseModel):
    email: str = Field(max_length=200)
    plan: dict
    remind: bool = False   # also email when steps and practice sessions are due


class SyncIn(BaseModel):
    token: str = Field(max_length=80)
    plan: dict


@app.post("/email/plan")
def email_plan(body: EmailPlanIn, request: Request):
    """Email the plan now; with remind, also store the dates and email when they're due."""
    email = body.email.strip().lower()
    if not mailer.valid_email(email):
        raise HTTPException(400, "That doesn't look like an email address.")
    if not (mailer.allowed(f"ip:{client_ip(request)}", 5, 3600) and mailer.allowed(f"to:{email}", 5, 86400)):
        raise HTTPException(429, "Too many emails for now. Try again later.")
    token = mailer.subscribe(email, body.plan) if body.remind else None
    subject, body_html, body_text = mailer.plan_email(body.plan, token)
    try:
        mailer.send(email, subject, body_html, body_text)
    except mailer.EmailError as error:
        if token:
            mailer.unsubscribe(token)
        raise HTTPException(502, str(error))
    return {"ok": True, "token": token}


@app.post("/email/reminders")
def sync_reminders(body: SyncIn):
    """The plan changed in the app: update the stored reminder dates (no email is sent)."""
    if not mailer.sync(body.token, body.plan):
        raise HTTPException(404, "No reminders for that token.")
    return {"ok": True}


class TokenIn(BaseModel):
    token: str = Field(max_length=80)


@app.post("/email/reminders/off")
def reminders_off(body: TokenIn):
    """Turn reminders off from the app: deletes the address and its reminders."""
    return {"ok": mailer.unsubscribe(body.token)}


@app.get("/email/unsubscribe", response_class=HTMLResponse)
def unsubscribe(token: str):
    done = mailer.unsubscribe(token)
    message = "Your reminders are stopped and your email address is deleted." if done else "There were no reminders for this link."
    return f'<html><body style="font-family:system-ui;max-width:480px;margin:60px auto"><h2>Job Transit</h2><p>{message}</p></body></html>'


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
def chat(body: ChatIn, request: Request):
    """The guide: streams server-sent events (see api/chat.py)."""
    global guide
    if not mailer.allowed(f"chat:{client_ip(request)}", CHAT_PER_HOUR, 3600):
        raise HTTPException(429, "The guide has had a lot of questions from here this hour. Try again a bit later.")
    if not mailer.allowed("chat:everyone", CHAT_PER_DAY, 86400):
        raise HTTPException(429, "The guide has reached its daily limit. It will be back tomorrow.")
    if guide is None:
        guide = Guide(engine)
    return StreamingResponse(
        guide.stream([m.model_dump() for m in body.messages], Profile(**body.profile.model_dump()), body.selected,
                     body.location.model_dump() if body.location else None, body.plan),
        media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
