"""Live job openings for an occupation, from the sources Tim's job-finder uses.

Sources (ported from job-finder/src/sources):
  - Adzuna: search API by title and city; needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env
  - 80,000 Hours: the public Algolia index behind jobs.80000hours.org
  - Arbeitnow: free German job board API (no search: recent postings)
  - Company boards on Ashby / Greenhouse / Lever (AI companies; job-finder's verified watchlist)

How it works: postings are collected into a small SQLite table and each one is matched to an occupation once, when
it is stored (the app's own title search, top result only, so "Senior Data Scientist" lands on data scientists and
"Data Center Technician" doesn't). A search is then a lookup by occupation code.
  - Boards that can't be searched (company boards, Arbeitnow) are collected in the background: when the API starts
    and again every REFRESH_SECONDS (start_collector).
  - Searchable sources (Adzuna, 80,000 Hours) are fetched for the occupation's search terms when someone asks, and
    stored the same way, so a repeat search is a lookup too.
  - If a source fails, its last stored postings are still shown, with their age.
The table lives in data/cache/openings.sqlite (OPENINGS_CACHE to move it; on Railway, put a volume there).
"""

import html
import ipaddress
import os
import re
import socket
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import closing
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
import urllib.parse
from html.parser import HTMLParser
import httpx

from dotenv import load_dotenv

load_dotenv()

REFRESH_SECONDS = 6 * 3600  # stored postings older than this are fetched again
SEARCH_BUDGET_SECONDS = (
    15  # a search waits this long for live sources, then answers with what it has
)
MIN_MATCH_SCORE = 80  # below this the title search is guessing ("Head of People" -> butchers); stored, so tunable

TIMEOUT = httpx.Timeout(8.0)
HEADERS = {"User-Agent": "job-transit (DSR capstone)", "Accept": "application/json"}

ALGOLIA_APP_ID = "W6KM1UDIB3"
ALGOLIA_API_KEY = "d1d7f2c8696e7b36837d5ed337c4a319"  # public search-only key used by the 80,000 Hours site
ALGOLIA_INDEX = "jobs_prod_super_ranked"

ATS_COMPANIES = [  # verified slugs from job-finder/src/sources/ats.ts
    ("ashby", "Perplexity", "Perplexity"),
    ("ashby", "granola", "Granola"),
    ("ashby", "zyphra", "Zyphra"),
    ("ashby", "langfuse", "Langfuse"),
    ("greenhouse", "anthropic", "Anthropic"),
    ("greenhouse", "proton", "Proton"),
    ("lever", "metr", "METR"),
    ("ashby", "modal", "Modal"),
    ("ashby", "baseten", "Baseten"),
    ("ashby", "fireworks", "Fireworks AI"),
    ("ashby", "langchain", "LangChain"),
    ("ashby", "llamaindex", "LlamaIndex"),
    ("ashby", "cursor", "Cursor (Anysphere)"),
    ("ashby", "elevenlabs", "ElevenLabs"),
    ("ashby", "parloa", "Parloa"),
    ("ashby", "supabase", "Supabase"),
    ("ashby", "linear", "Linear"),
    ("greenhouse", "vercel", "Vercel"),
    ("lever", "apolloresearch", "Apollo Research"),
    ("greenhouse", "ginkgobioworks", "Ginkgo Bioworks"),
    ("greenhouse", "recursionpharmaceuticals", "Recursion"),
    ("greenhouse", "isomorphiclabs", "Isomorphic Labs"),
]

COUNTRIES = [
    "de",
    "gb",
    "us",
    "nl",
    "at",
    "fr",
    "it",
    "pl",
    "ca",
    "au",
]  # Adzuna's country sites we offer


# ---- fetching ------------------------------------------------------------------------------------
def _get(url: str, **kw):
    response = httpx.get(
        url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True, **kw
    )
    response.raise_for_status()
    return response.json()


def _posting(title, company, location, url, description=None):
    """description: the posting's text as the source gives it (plain text or HTML; read_posting cleans it)."""
    return {
        "title": (title or "").strip(),
        "company": (company or "").strip() or "Unknown",
        "location": (location or "").strip() or "Unknown",
        "url": url or "",
        "description": description or None,
    }


def adzuna_feed(term: str, city: str, country: str):
    params = {
        "app_id": os.getenv("ADZUNA_APP_ID"),
        "app_key": os.getenv("ADZUNA_APP_KEY"),
        "what": term,
        "results_per_page": 50,
    }
    if city:
        params["where"] = city
    data = _get(f"https://api.adzuna.com/v1/api/jobs/{country}/search/1", params=params)
    return [
        _posting(
            j.get("title"),
            (j.get("company") or {}).get("display_name"),
            (j.get("location") or {}).get("display_name"),
            j.get("redirect_url"),
            j.get("description"),
        )
        for j in data.get("results", [])
    ]  # Adzuna's description is a short snippet, not the full text


def eighty_thousand_hours_feed(term: str):
    r = httpx.post(
        f"https://{ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/{ALGOLIA_INDEX}/query",
        headers={
            "X-Algolia-Application-Id": ALGOLIA_APP_ID,
            "X-Algolia-API-Key": ALGOLIA_API_KEY,
        },
        json={"query": term, "hitsPerPage": 50},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for hit in r.json().get("hits", []):
        company = hit.get("company_name") or (hit.get("company") or {}).get("name")
        places = (
            (hit.get("card_locations") or [])
            + (hit.get("tags_city") or [])
            + (hit.get("tags_country") or [])
        )
        if any(
            re.search("remote", t or "", re.I)
            for t in hit.get("tags_location_type") or []
        ):
            places = ["Remote"] + places
        out.append(
            _posting(
                hit.get("title"),
                company,
                ", ".join(dict.fromkeys(p for p in places if p)),
                hit.get("url_external")
                or f"https://jobs.80000hours.org/job/{hit.get('objectID')}",
                hit.get("description") or hit.get("description_short"),
            )
        )
    return out


def arbeitnow_feed(page: int):
    data = _get(f"https://www.arbeitnow.com/api/job-board-api?page={page}")
    return [
        _posting(
            j.get("title"),
            j.get("company_name"),
            ("Remote, " if j.get("remote") else "") + (j.get("location") or ""),
            j.get("url"),
            j.get("description"),
        )
        for j in data.get("data", [])
    ]  # HTML


def board_feed(platform: str, slug: str, name: str):
    if platform == "ashby":
        data = _get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
        return [
            _posting(
                j.get("title"),
                name,
                ("Remote, " if j.get("isRemote") else "") + (j.get("location") or ""),
                j.get("jobUrl") or j.get("applyUrl"),
                j.get("descriptionPlain") or j.get("descriptionHtml"),
            )
            for j in data.get("jobs", [])
        ]
    if platform == "greenhouse":
        data = _get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
        )
        return [
            _posting(
                j.get("title"),
                name,
                (j.get("location") or {}).get("name"),
                j.get("absolute_url"),
                j.get("content"),
            )
            for j in data.get("jobs", [])
        ]  # HTML, entity-escaped (&lt;p&gt;)
    data = _get(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    return [
        _posting(
            j.get("text"),
            name,
            (j.get("categories") or {}).get("location"),
            j.get("hostedUrl"),
            j.get("descriptionPlain") or j.get("description"),
        )
        for j in data
    ]


# A feed is one fetch: (key, source name, function returning postings).
def background_feeds():
    """Boards that can't be searched by job: collected in the background."""
    feeds = [
        (f"arbeitnow|{page}", "Arbeitnow", partial(arbeitnow_feed, page))
        for page in (1, 2, 3)
    ]
    feeds += [
        (
            f"{platform}|{slug}",
            "AI company boards",
            partial(board_feed, platform, slug, name),
        )
        for platform, slug, name in ATS_COMPANIES
    ]
    return feeds


def search_feeds(terms: list[str], city: str, country: str):
    """Searchable sources: fetched for this occupation's terms when someone asks."""
    feeds = [
        (f"80k|{term}", "80,000 Hours", partial(eighty_thousand_hours_feed, term))
        for term in terms
    ]
    if os.getenv("ADZUNA_APP_ID") and os.getenv("ADZUNA_APP_KEY"):
        feeds += [
            (
                f"adzuna|{country}|{term}|{city.lower()}",
                "Adzuna",
                partial(adzuna_feed, term, city, country),
            )
            for term in terms
        ]
    return feeds


SOURCE_ORDER = ["Adzuna", "80,000 Hours", "Arbeitnow", "AI company boards"]


# ---- storage -------------------------------------------------------------------------------------
CACHE_DB = Path(
    os.getenv(
        "OPENINGS_CACHE",
        Path(__file__).resolve().parent.parent / "data" / "cache" / "openings.sqlite",
    )
)
_write_lock = threading.Lock()
_titles: dict[str, tuple[int | None, float]] | None = (
    None  # posting title -> (census, score), mirrored in the db
)


SCHEMA_VERSION = 3  # bump when the tables change: it's only a cache, so an old file is simply rebuilt


def _connect() -> sqlite3.Connection:
    CACHE_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(CACHE_DB, timeout=15)
    if con.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        with _write_lock:
            con.executescript(
                "DROP TABLE IF EXISTS postings; DROP TABLE IF EXISTS feeds; DROP TABLE IF EXISTS titles;"
            )
            con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    con.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS postings (
            feed TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, company TEXT, location TEXT,
            url TEXT NOT NULL, census INTEGER, score REAL, fetched_at REAL NOT NULL, description TEXT,
            PRIMARY KEY (feed, url, title));
        CREATE INDEX IF NOT EXISTS postings_url ON postings (url);
        CREATE INDEX IF NOT EXISTS postings_census ON postings (census);
        CREATE TABLE IF NOT EXISTS feeds (
            feed TEXT PRIMARY KEY, source TEXT NOT NULL, fetched_at REAL, error TEXT, error_at REAL);
        CREATE TABLE IF NOT EXISTS titles (title TEXT PRIMARY KEY, census INTEGER, score REAL);
    """)
    return con


def _classify(engine, title: str) -> tuple[int | None, float]:
    """Top title-search match for a posting title (~60 ms, so each title is matched once and remembered)."""
    global _titles
    if _titles is None:
        with closing(_connect()) as con:
            _titles = {
                t: (c, s)
                for t, c, s in con.execute("SELECT title, census, score FROM titles")
            }
    if title not in _titles:
        matches = engine.search_jobs(_core_title(title), limit=1)
        _titles[title] = (
            (matches[0]["census"], float(matches[0]["score"]))
            if matches
            else (None, 0.0)
        )
    return _titles[title]


def _store(engine, feed: str, source: str, postings: list[dict]):
    """Replace a feed's postings with a fresh fetch, each matched to an occupation."""
    rows, seen = [], set()
    for p in postings:
        if not p["title"] or not p["url"] or (p["url"], p["title"]) in seen:
            continue
        seen.add((p["url"], p["title"]))
        census, score = _classify(engine, p["title"])
        rows.append(
            (
                feed,
                source,
                p["title"],
                p["company"],
                p["location"],
                p["url"],
                census,
                score,
                time.time(),
                p.get("description"),
            )
        )
    with _write_lock, closing(_connect()) as con, con:
        con.execute("DELETE FROM postings WHERE feed = ?", (feed,))
        con.executemany(
            "INSERT OR REPLACE INTO postings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        con.execute(
            "INSERT OR REPLACE INTO feeds (feed, source, fetched_at, error, error_at) VALUES (?, ?, ?, NULL, NULL)",
            (feed, source, time.time()),
        )
        con.executemany(
            "INSERT OR IGNORE INTO titles VALUES (?, ?, ?)",
            [(r[2], r[6], r[7]) for r in rows],
        )


def _record_error(feed: str, source: str, error: Exception):
    with _write_lock, closing(_connect()) as con, con:
        con.execute(
            "INSERT INTO feeds (feed, source, error, error_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (feed) DO UPDATE SET error = excluded.error, error_at = excluded.error_at",
            (feed, source, str(error)[:120], time.time()),
        )


def _refresh(engine, feed: str, source: str, fetch) -> bool:
    try:
        postings = fetch()
    except Exception as error:
        _record_error(feed, source, error)
        return False
    _store(engine, feed, source, postings)
    return True


def _fetched_at(feeds: list[str]) -> dict[str, float | None]:
    if not feeds:
        return {}
    with closing(_connect()) as con:
        rows = dict(
            con.execute(
                f"SELECT feed, fetched_at FROM feeds WHERE feed IN ({','.join('?' * len(feeds))})",
                feeds,
            )
        )
    return {f: rows.get(f) for f in feeds}


# ---- background collection ---------------------------------------------------------------------
_collector_started = False

# Searchable sources are fetched per occupation, so the first search for a job used to come back thin (Adzuna
# often takes longer than the search budget). The app warms them as soon as it knows someone's next jobs.
WARM_LIMIT = 5   # occupations per request: the top of their list
_warm_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="openings-warm")
_warming: set[str] = set()
_warming_lock = threading.Lock()


def warm(engine, censuses: list[int], city: str, country: str) -> int:
    """Fetch the searchable sources for these occupations in the background. Returns how many fetches started."""
    feeds = [f for census in censuses[:WARM_LIMIT] for f in search_feeds(search_terms(engine, census), city, country)]
    ages = _fetched_at([f[0] for f in feeds])
    started = 0
    for feed, source, fetch in feeds:
        if ages.get(feed) and time.time() - ages[feed] < REFRESH_SECONDS:
            continue   # fresh enough: a search will be a lookup
        with _warming_lock:
            if feed in _warming:
                continue
            _warming.add(feed)

        def job(feed=feed, source=source, fetch=fetch):
            try:
                _refresh(engine, feed, source, fetch)
            finally:
                with _warming_lock:
                    _warming.discard(feed)

        _warm_pool.submit(job)
        started += 1
    return started


def collect_once(engine):
    """Fetch every stale background feed (in parallel), then match and store them one by one."""
    feeds = background_feeds()
    ages = _fetched_at([f[0] for f in feeds])
    stale = [
        f for f in feeds if not ages[f[0]] or time.time() - ages[f[0]] > REFRESH_SECONDS
    ]
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = {f[0]: pool.submit(f[2]) for f in stale}
    for feed, source, _ in stale:
        try:
            _store(engine, feed, source, fetched[feed].result())
        except Exception as error:
            _record_error(feed, source, error)


def start_collector(engine, every_seconds: int = 600):
    """Background thread: collect on start, then check for stale feeds every 10 minutes."""
    global _collector_started
    if _collector_started or os.getenv("OPENINGS_COLLECT", "1") == "0":
        return
    _collector_started = True

    def loop():
        while True:
            try:
                collect_once(engine)
            except Exception as error:  # never let the thread die
                print(f"openings collector: {error}")
            time.sleep(every_seconds)

    threading.Thread(target=loop, name="openings-collector", daemon=True).start()


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
        official = (
            engine.census.at[census, "official_title"]
            if "official_title" in engine.census
            else engine.census.at[census, "title"]
        )
        official = _singular(official.split(",")[0])
        terms = [official] * (" and " not in official) + [
            _singular(t) for t in examples[:3]
        ]
    return list(dict.fromkeys(t for t in terms if t))[:3]


# In posting titles these lead words are rank, not the job ("Staff Data Scientist"); the app's title search keeps
# them because "staff" and "lead" are jobs on their own in O*NET's titles.
POSTING_RANKS = {"staff", "principal", "lead", "founding"}


def _core_title(title: str) -> str:
    """The job part of a posting title: 'Data Scientist (m/w/d)', 'Data Scientist, Growth' and
    'ML Engineer - Search' become 'Data Scientist' and 'ML Engineer'; 'Full-Stack Engineer' stays whole."""
    core = re.sub(r"\(.*?\)|\[.*?\]", " ", title)
    core = re.split(r"\s+[-–—|/]\s+|\s*[|,:]\s*", core)[0]
    words = core.split()
    if (
        len(words) >= 3 and words[0].lower() in POSTING_RANKS
    ):  # "Staff Data Scientist" -> "Data Scientist"
        words = words[1:]
    return " ".join(words) or title


def _near(location: str, city: str) -> int:
    """2 = in the city, 1 = remote, 0 = elsewhere."""
    loc = (location or "").lower()
    if city and city.lower() in loc:
        return 2
    return 1 if "remote" in loc or "anywhere" in loc else 0


# Remote postings that are really only for people in the US (or the Americas)
US_IN_LOCATION = re.compile(r"\b(us|usa|u\.s\.?|united states|north america|americas|canada)\b", re.I)
EUROPE_IN_LOCATION = re.compile(r"\b(europe|emea|eu|germany|deutschland|uk|worldwide|global|anywhere)\b", re.I)
US_IN_TEXT = re.compile(
    r"(must|need to|required to|should) (be )?(based|located|living|reside) in the (us|u\.s\.|usa|united states)"
    r"|(us|u\.s\.)[- ]based (candidates|applicants|only)|authori[sz]ed to work in the (us|u\.s\.|united states)"
    r"|\b(us|u\.s\.|north american?) time ?zones?|\b(est|pst|cst|edt|pdt)\b[^.]{0,40}(hours|overlap|time ?zone)",
    re.I,
)


def us_only(location: str, text: str) -> bool:
    loc = location or ""
    if US_IN_LOCATION.search(loc) and not EUROPE_IN_LOCATION.search(loc):
        return True
    return bool(US_IN_TEXT.search(text or ""))


GERMAN_WORDS = set("und der die das mit für wir sie ist ein eine zu von auf bei oder als ihre unser deine du".split())
ENGLISH_WORDS = set("and the with for we you is a to of on at or as your our are will be".split())
NEEDS_GERMAN = re.compile(
    r"(deutsch|german)\w*\W{1,30}(c1|c2|b2|fließend|fliessend|fluent|verhandlungssicher|native|muttersprach|required|erforderlich)"
    r"|(fließend|fliessend|sehr gut|verhandlungssicher|fluent)\w*\W{1,20}(deutsch|german)|deutschkenntnisse",
    re.I,
)


def posting_language(title: str, text: str) -> str | None:
    """'German' or 'English' from common words; None when there isn't enough text to tell."""
    words = re.findall(r"[a-zäöüß]+", f"{title} {text or ''}".lower())[:400]
    de, en = sum(w in GERMAN_WORDS for w in words), sum(w in ENGLISH_WORDS for w in words)
    if de + en < 5:
        return None
    return "German" if de > en else "English"


def _ago(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def find_openings(
    engine, census: int, city: str = "Berlin", country: str = "de", limit: int = 25
):
    terms = search_terms(engine, census)
    live = search_feeds(terms, city, country)

    # searchable sources: fetch the stale ones now (in parallel, within the budget); late ones still get stored
    ages = _fetched_at([f[0] for f in live])
    stale = [
        f for f in live if not ages[f[0]] or time.time() - ages[f[0]] > REFRESH_SECONDS
    ]
    if stale:
        pool = ThreadPoolExecutor(max_workers=len(stale))
        futures = [pool.submit(_refresh, engine, *f) for f in stale]
        wait(futures, timeout=SEARCH_BUDGET_SECONDS)
        pool.shutdown(wait=False)

    background = [
        f[0]
        for f in background_feeds()
        if country == "de" or not f[0].startswith("arbeitnow|")
    ]
    feeds = [f[0] for f in live] + background
    marks = ",".join("?" * len(feeds))
    with closing(_connect()) as con:
        rows = con.execute(
            f"SELECT source, title, company, location, url, fetched_at, description FROM postings "
            f"WHERE census = ? AND score >= ? AND feed IN ({marks}) ORDER BY fetched_at DESC",
            [census, MIN_MATCH_SCORE, *feeds],
        ).fetchall()
        feed_rows = con.execute(
            f"SELECT feed, source, fetched_at, error FROM feeds WHERE feed IN ({marks})",
            feeds,
        ).fetchall()

    rank = {s: i for i, s in enumerate(SOURCE_ORDER)}
    rows.sort(
        key=lambda r: rank.get(r[0], 9)
    )  # the same posting on two boards: keep the first source's copy
    keep, seen = [], set()
    for source, title, company, location, url, fetched_at, description in rows:
        key = (title.lower(), (company or "").lower())
        if key in seen:
            continue
        seen.add(key)
        near = _near(location, city)
        us = near < 2 and us_only(location, description)
        keep.append(
            {
                "title": title,
                "company": company,
                "location": location,
                "url": url,
                "source": source,
                "near": 0 if us else near,   # remote but US-only isn't remote for someone in Europe
                "us_only": us,
                "language": posting_language(title, description),
                "needs_german": bool(NEEDS_GERMAN.search(f"{title} {description or ''}")),
            }
        )
    keep.sort(
        key=lambda p: (
            -p["near"],
            SOURCE_ORDER.index(p["source"]) if p["source"] in SOURCE_ORDER else 9,
        )
    )

    # per source: how many matched, or why not; and when its postings were fetched
    status, updated = {}, {}
    known = {f: (s, t, e) for f, s, t, e in feed_rows}
    wanted = {s: [] for s in SOURCE_ORDER}
    for f in [x for x in live] + [x for x in background_feeds() if x[0] in background]:
        wanted[f[1]].append(f[0])
    if not (os.getenv("ADZUNA_APP_ID") and os.getenv("ADZUNA_APP_KEY")):
        status["Adzuna"] = "unavailable: needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env"
    for source, source_feeds in wanted.items():
        if not source_feeds:
            continue
        times = [known[f][1] for f in source_feeds if f in known and known[f][1]]
        errors = [known[f][2] for f in source_feeds if f in known and known[f][2]]
        if times:
            status[source] = sum(1 for p in keep if p["source"] == source)
            updated[source] = _ago(min(times))
        elif errors:
            status[source] = f"unavailable: {errors[0]}"
        else:
            status[source] = "unavailable: still collecting, try again in a few minutes"
    return {
        "occupation": engine.census.at[census, "title"],
        "search_terms": terms,
        "city": city,
        "country": country,
        "sources": status,
        "updated": updated,
        "openings": keep[:limit],
        "total_matched": len(keep),
        "by_place": {
            "in_city": sum(p["near"] == 2 for p in keep),
            "remote": sum(p["near"] == 1 for p in keep),
            "elsewhere": sum(p["near"] == 0 for p in keep),
        },
    }


POSTING_TEXT_LIMIT = 6000   # characters (~1,500 tokens): enough to judge a posting, small enough for the chat


class Collector(HTMLParser):
    """Collects the visible text of an HTML page (skipping scripts and styles) and its <title>."""

    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self.title = ""
        self._skipping = 0       # depth inside tags whose text isn't content
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skipping += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"p", "br", "li", "div", "h1", "h2", "h3", "h4", "tr"}:
            self.parts.append(" ")   # keep words from neighbouring blocks apart

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skipping:
            self._skipping -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skipping:
            self.parts.append(data)


def to_text(markup: str) -> tuple[str, str]:
    """(title, text) from HTML or plain text: entities decoded, tags stripped, whitespace collapsed, cut to the limit.
    Greenhouse sends its HTML entity-escaped (&lt;p&gt;), so unescape first; harmless for everything else."""
    collector = Collector()
    collector.feed(html.unescape(markup))
    collector.close()
    text = re.sub(r"\s+", " ", "".join(collector.parts)).strip()
    return " ".join(collector.title.split()), text[:POSTING_TEXT_LIMIT]


def _public_url_error(url: str) -> str | None:
    """Why this URL can't be fetched from our server, or None if it's fine. Blocks non-web schemes and anything
    resolving to a private, loopback or link-local address (so the guide can't be used to probe our network)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "only http(s) links can be read"
    try:
        address = ipaddress.ip_address(socket.gethostbyname(parsed.hostname))
    except (OSError, ValueError):
        return "couldn't resolve that address"
    if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved:
        return "private and local addresses are not allowed"
    return None


# ---- reading one posting -------------------------------------------------------------------
def read_posting(url: str) -> dict:
    """The text of one job posting, for the guide (tool: read_posting in api/chat.py).

    Stored text first (most collected postings have it); the page itself only when there's none, or when the
    stored text is Adzuna's short snippet. Returns {"url", "title", "text", "from"} or {"error": "..."}.
    """
    url = (url or "").strip()
    with closing(_connect()) as con:
        row = con.execute(
            "SELECT title, description, source FROM postings WHERE url = ? AND description IS NOT NULL",
            (url,),
        ).fetchone()
    if row and row[2] != "Adzuna":
        _, text = to_text(row[1])
        if text:
            return {"url": url, "title": row[0], "text": text, "from": "stored posting"}

    def snippet_or(error: str) -> dict:   # couldn't read the page: Adzuna's stored snippet beats nothing
        if row:
            return {"url": url, "title": row[0], "text": to_text(row[1])[1], "from": "stored snippet (page unreadable)"}
        return {"error": error}

    error = _public_url_error(url)
    if error:
        return snippet_or(error)
    def check_redirect(request: httpx.Request):   # a public page could redirect to a private address
        problem = _public_url_error(str(request.url))
        if problem:
            raise httpx.RequestError(problem, request=request)

    try:
        with httpx.Client(headers={**HEADERS, "Accept": "text/html"}, timeout=TIMEOUT, follow_redirects=True,
                          event_hooks={"request": [check_redirect]}) as client:
            response = client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as err:
        return snippet_or(f"couldn't read that page: {err}"[:200])
    if "html" not in response.headers.get("content-type", "html"):
        return snippet_or("that link isn't a web page")
    title, text = to_text(response.text)
    if not text:   # pages built entirely in JavaScript have no text to read
        return snippet_or("the page has no readable text (it may need JavaScript)")
    return {"url": url, "title": row[0] if row else title, "text": text, "from": "page"}
