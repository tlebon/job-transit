"""Save / Not for me on job openings, kept as labels for a later model of which openings to show first.

Each row is one click: the label (the status the person chose), the move it was for, and a snapshot of the
posting's features taken now, since the openings cache is rebuilt and postings expire. Anonymous: the browser
sends a random id (not an email or name) so rows from one person can be grouped, nothing else about them.

Lives in data/cache next to the reminders, which is the volume on Railway, so it survives deploys. The openings
cache in the same folder gets rebuilt; this file is separate and never is.
Export: GET /feedback/export?token=$FEEDBACK_EXPORT_TOKEN (CSV).
"""
import csv
import io
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from api.openings import _connect as _openings_db, needs_german, posting_language

DB = Path(os.getenv("FEEDBACK_DB", Path(__file__).resolve().parent.parent / "data" / "cache" / "feedback.sqlite"))
LABELS = ("interested", "applied", "interview", "offer", "no", "hidden", "found")
COLUMNS = ["at", "browser", "label", "previous", "via", "move_census", "move", "url", "title", "company", "location",
           "where_", "source", "posting_census", "match_score", "needs_german", "language", "pay", "career_changer",
           "home_office", "description"]


def _connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=15)
    con.execute(f"""CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY, {", ".join(f"{c} {'REAL' if c in ('at', 'match_score') else 'TEXT'}" for c in COLUMNS)})""")
    return con


def _posting(url: str) -> dict:
    """What the openings cache knows about this posting right now (empty if it's gone)."""
    try:
        with closing(_openings_db()) as con:
            row = con.execute(
                "SELECT source, title, company, location, census, score, description, extra FROM postings "
                "WHERE url = ? ORDER BY fetched_at DESC LIMIT 1", (url,)).fetchone()
    except sqlite3.Error:
        return {}
    if not row:
        return {}
    source, title, company, location, census, score, description, extra = row
    extra = json.loads(extra) if extra else {}
    return {
        "source": source, "title": title, "company": company, "location": location, "posting_census": census,
        "match_score": score, "needs_german": needs_german(f"{title} {description or ''}"),
        "language": None if source == "Arbeitsagentur" else posting_language(title, description),
        "pay": extra.get("pay"), "career_changer": extra.get("career_changer"), "home_office": extra.get("home_office"),
        "description": (description or "")[:20000],
    }


def record(browser: str, label: str, url: str, previous: str | None = None, via: str | None = None,
           move_census: int | None = None, move: str | None = None, title: str | None = None,
           company: str | None = None, location: str | None = None, where: str | None = None):
    """One label. The client's title/company/location fill in when the cache no longer has the posting."""
    row = {"title": title, "company": company, "location": location, **_posting(url)}
    row.update({"at": time.time(), "browser": browser, "label": label, "previous": previous, "via": via,
                "move_census": move_census, "move": move, "url": url, "where_": where})
    values = [row.get(c) for c in COLUMNS]
    values = [json.dumps(v) if isinstance(v, (dict, list)) else (str(v) if isinstance(v, bool) else v) for v in values]
    with closing(_connect()) as con, con:
        con.execute(f"INSERT INTO labels ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})", values)


def export_csv() -> str:
    with closing(_connect()) as con:
        rows = con.execute(f"SELECT {', '.join(COLUMNS)} FROM labels ORDER BY at").fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([c.rstrip("_") for c in COLUMNS])
    writer.writerows(rows)
    return out.getvalue()


def count() -> int:
    with closing(_connect()) as con:
        return con.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
