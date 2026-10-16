"""Live job openings for an occupation, from the sources Tim's job-finder uses.

Sources (ported from job-finder/src/sources):
  - Adzuna: search API by title and city; needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env
  - 80,000 Hours: the public Algolia index behind jobs.80000hours.org
  - Arbeitnow: free German job board API (no search: recent postings, filtered here)
  - Company boards on Ashby / Greenhouse / Lever (AI companies; job-finder's verified watchlist)
Every posting's title is run through the app's own title search, and only postings that land on the requested
occupation are kept, so "Senior Data Scientist" counts for data scientists and "Data Center Technician" doesn't.
Results are cached for 30 minutes per request.
"""
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from dotenv import load_dotenv

load_dotenv()

CACHE_SECONDS = 30 * 60
TIMEOUT = httpx.Timeout(8.0)
HEADERS = {"User-Agent": "job-transit (DSR capstone)", "Accept": "application/json"}

ALGOLIA_APP_ID = "W6KM1UDIB3"
ALGOLIA_API_KEY = "d1d7f2c8696e7b36837d5ed337c4a319"   # public search-only key used by the 80,000 Hours site
ALGOLIA_INDEX = "jobs_prod_super_ranked"

ATS_COMPANIES = [   # verified slugs from job-finder/src/sources/ats.ts
    ("ashby", "Perplexity", "Perplexity"), ("ashby", "granola", "Granola"), ("ashby", "zyphra", "Zyphra"),
    ("ashby", "langfuse", "Langfuse"), ("greenhouse", "anthropic", "Anthropic"), ("greenhouse", "proton", "Proton"),
    ("lever", "metr", "METR"), ("ashby", "modal", "Modal"), ("ashby", "baseten", "Baseten"),
    ("ashby", "fireworks", "Fireworks AI"), ("ashby", "langchain", "LangChain"), ("ashby", "llamaindex", "LlamaIndex"),
    ("ashby", "cursor", "Cursor (Anysphere)"), ("ashby", "elevenlabs", "ElevenLabs"), ("ashby", "parloa", "Parloa"),
    ("ashby", "supabase", "Supabase"), ("ashby", "linear", "Linear"), ("greenhouse", "vercel", "Vercel"),
    ("lever", "apolloresearch", "Apollo Research"), ("greenhouse", "ginkgobioworks", "Ginkgo Bioworks"),
    ("greenhouse", "recursionpharmaceuticals", "Recursion"), ("greenhouse", "isomorphiclabs", "Isomorphic Labs"),
]

COUNTRIES = ["de", "gb", "us", "nl", "at", "fr", "it", "pl", "ca", "au"]   # Adzuna's country sites we offer

_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = fetch()
    _cache[key] = (time.time(), value)
    return value


def _get(url: str, **kw):
    response = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True, **kw)
    response.raise_for_status()
    return response.json()


def _posting(title, company, location, url, source):
    return {"title": (title or "").strip(), "company": (company or "").strip() or "Unknown",
            "location": (location or "").strip() or "Unknown", "url": url or "", "source": source}


# ---- sources ---------------------------------------------------------------------------------
def adzuna(terms: list[str], city: str, country: str):
    app_id, app_key = os.getenv("ADZUNA_APP_ID"), os.getenv("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        raise RuntimeError("needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env")
    out = []
    for term in terms:
        params = {"app_id": app_id, "app_key": app_key, "what": term, "results_per_page": 30}
        if city:
            params["where"] = city
        data = _cached(f"adzuna|{country}|{term}|{city}",
                       lambda p=params: _get(f"https://api.adzuna.com/v1/api/jobs/{country}/search/1", params=p))
        for j in data.get("results", []):
            out.append(_posting(j.get("title"), (j.get("company") or {}).get("display_name"),
                                (j.get("location") or {}).get("display_name"), j.get("redirect_url"), "Adzuna"))
    return out


def eighty_thousand_hours(terms: list[str], city: str, country: str):
    out = []
    url = f"https://{ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/{ALGOLIA_INDEX}/query"
    headers = {"X-Algolia-Application-Id": ALGOLIA_APP_ID, "X-Algolia-API-Key": ALGOLIA_API_KEY}
    for term in terms:
        def fetch(term=term):
            r = httpx.post(url, headers=headers, json={"query": term, "hitsPerPage": 40}, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        for hit in _cached(f"80k|{term}", fetch).get("hits", []):
            company = hit.get("company_name") or (hit.get("company") or {}).get("name")
            places = (hit.get("card_locations") or []) + (hit.get("tags_city") or []) + (hit.get("tags_country") or [])
            if any(re.search("remote", t or "", re.I) for t in hit.get("tags_location_type") or []):
                places = ["Remote"] + places
            location = ", ".join(dict.fromkeys(p for p in places if p))
            out.append(_posting(hit.get("title"), company, location,
                                hit.get("url_external") or f"https://jobs.80000hours.org/job/{hit.get('objectID')}",
                                "80,000 Hours"))
    return out


def arbeitnow(terms: list[str], city: str, country: str):
    if country != "de":
        return []
    out = []
    for page in (1, 2, 3):
        data = _cached(f"arbeitnow|{page}", lambda page=page: _get(f"https://www.arbeitnow.com/api/job-board-api?page={page}"))
        for j in data.get("data", []):
            location = ("Remote, " if j.get("remote") else "") + (j.get("location") or "")
            out.append(_posting(j.get("title"), j.get("company_name"), location, j.get("url"), "Arbeitnow"))
    return out


def company_boards(terms: list[str], city: str, country: str):
    def board(platform, slug, name):
        try:
            if platform == "ashby":
                data = _cached(f"ashby|{slug}", lambda: _get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}"))
                return [_posting(j.get("title"), name, ("Remote, " if j.get("isRemote") else "") + (j.get("location") or ""),
                                 j.get("jobUrl") or j.get("applyUrl"), name) for j in data.get("jobs", [])]
            if platform == "greenhouse":
                data = _cached(f"gh|{slug}", lambda: _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"))
                return [_posting(j.get("title"), name, (j.get("location") or {}).get("name"), j.get("absolute_url"), name)
                        for j in data.get("jobs", [])]
            data = _cached(f"lever|{slug}", lambda: _get(f"https://api.lever.co/v0/postings/{slug}?mode=json"))
            return [_posting(j.get("text"), name, (j.get("categories") or {}).get("location"), j.get("hostedUrl"), name)
                    for j in data]
        except Exception:
            return []   # one board failing shouldn't sink the rest
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = pool.map(lambda c: board(*c), ATS_COMPANIES)
    return [p for postings in results for p in postings]


SOURCES = {"Adzuna": adzuna, "80,000 Hours": eighty_thousand_hours, "Arbeitnow": arbeitnow, "AI company boards": company_boards}


# ---- matching ----------------------------------------------------------------------------------
def _singular(title: str) -> str:
    words = re.sub(r"\(.*?\)", " ", title).lower().replace("&", " ").split()
    if words and words[-1].endswith("s") and not words[-1].endswith("ss"):
        words[-1] = words[-1][:-1]
    return " ".join(words)


def search_terms(engine, census: int) -> list[str]:
    """What to search job boards for: the occupation's most common real titles."""
    details = engine.details.get(str(census), {})
    examples = details.get("example_titles") or []
    if details.get("catch_all"):
        terms = [_singular(t) for t in examples[:3]]
    else:
        official = engine.census.at[census, "official_title"] if "official_title" in engine.census else engine.census.at[census, "title"]
        official = _singular(official.split(",")[0])
        terms = [official] * (" and " not in official) + [_singular(t) for t in examples[:3]]
    return list(dict.fromkeys(t for t in terms if t))[:3]


def _core_title(title: str) -> str:
    """The job part of a posting title: 'Data Scientist (m/w/d)', 'Data Scientist, Growth' and
    'ML Engineer - Search' become 'Data Scientist' and 'ML Engineer'; 'Full-Stack Engineer' stays whole."""
    core = re.sub(r"\(.*?\)|\[.*?\]", " ", title)
    core = re.split(r"\s+[-–—|/]\s+|\s*[|,:]\s*", core)[0]
    return " ".join(core.split()) or title


def _near(location: str, city: str) -> int:
    """2 = in the city, 1 = remote, 0 = elsewhere."""
    loc = (location or "").lower()
    if city and city.lower() in loc:
        return 2
    return 1 if "remote" in loc or "anywhere" in loc else 0


def find_openings(engine, census: int, city: str = "Berlin", country: str = "de", limit: int = 25):
    terms = search_terms(engine, census)
    status, postings = {}, []
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        futures = {name: pool.submit(fn, terms, city, country) for name, fn in SOURCES.items()}
        for name, future in futures.items():
            try:
                found = future.result(timeout=25)
                postings += found
                status[name] = len(found)
            except Exception as error:
                status[name] = f"unavailable: {str(error)[:80]}"

    keep, seen = [], set()
    title_cache: dict[str, int | None] = {}
    for p in postings:
        key = (p["title"].lower(), p["company"].lower())
        if not p["title"] or not p["url"] or key in seen:
            continue
        seen.add(key)
        if p["title"] not in title_cache:   # classify the posting with the app's own title search
            matches = engine.search_jobs(_core_title(p["title"]), limit=2)
            title_cache[p["title"]] = [m["census"] for m in matches]
        if census not in (title_cache[p["title"]] or []):
            continue
        p["near"] = _near(p["location"], city)
        keep.append(p)
    # city first, then remote, then elsewhere; sources keep their own order inside each group
    keep.sort(key=lambda p: -p["near"])
    return {"occupation": engine.census.at[census, "title"], "search_terms": terms, "city": city, "country": country,
            "sources": status, "openings": keep[:limit], "total_matched": len(keep)}
