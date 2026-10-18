"""Email: "email me my plan" and reminders when plan steps and practice sessions are due.

Sent through Resend (RESEND_API_KEY in .env; the jobtransit.org domain is verified there). Plans live in the
browser, so for reminders the server keeps only what it needs to send them: the email address, the step titles and
their dates, in data/cache/reminders.sqlite (REMINDERS_DB to move it). Every email has an unsubscribe link that
deletes all of it. A background thread sends what's due once a day, from 07:00 UTC (09:00 in Berlin in summer).
"""
import html
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

FROM = os.getenv("EMAIL_FROM", "Job Transit <plan@jobtransit.org>")
API_URL = os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/")   # for unsubscribe links
APP_URL = os.getenv("PUBLIC_APP_URL", "").rstrip("/")                         # link back to the app, if set
DB = Path(os.getenv("REMINDERS_DB", Path(__file__).resolve().parent.parent / "data" / "cache" / "reminders.sqlite"))
SEND_HOUR_UTC = 7
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_lock = threading.Lock()
_recent: dict[str, list[float]] = {}   # rate limiting: key -> send times


class EmailError(Exception):
    pass


def _connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=15)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS subscribers (token TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, occupation TEXT,
                                                created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS reminders (token TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
                                              due TEXT NOT NULL, sent_at REAL);
        CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due, sent_at);
    """)
    return con


def allowed(key: str, limit: int, per_seconds: int) -> bool:
    """A simple in-memory rate limit, so the endpoint can't be used to send mail in bulk."""
    now = time.time()
    with _lock:
        times = [t for t in _recent.get(key, []) if now - t < per_seconds]
        if len(times) >= limit:
            _recent[key] = times
            return False
        _recent[key] = times + [now]
        return True


def valid_email(address: str) -> bool:
    return bool(EMAIL_RE.match(address or "")) and len(address) <= 200


def send(to: str, subject: str, html_body: str, text_body: str):
    key = os.getenv("RESEND_API_KEY")
    if not key:
        raise EmailError("Email isn't set up: RESEND_API_KEY is missing.")
    response = httpx.post("https://api.resend.com/emails", timeout=15,
                          headers={"Authorization": f"Bearer {key}"},
                          json={"from": FROM, "to": [to], "subject": subject, "html": html_body, "text": text_body})
    if response.status_code >= 400:
        raise EmailError(f"The email service refused it ({response.status_code}): {response.text[:200]}")


# ---- rendering ----------------------------------------------------------------------------------
LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def _html_text(text: str) -> str:
    """Escaped text with Markdown links as real links and line breaks kept."""
    out, last = [], 0
    for m in LINK.finditer(text or ""):
        out.append(html.escape(text[last:m.start()]))
        out.append(f'<a href="{html.escape(m.group(2))}">{html.escape(m.group(1))}</a>')
        last = m.end()
    out.append(html.escape((text or "")[last:]))
    return "".join(out).replace("\n", "<br>")


def _plain(text: str) -> str:
    return LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text or "")


def _nice_date(iso: str) -> str:
    try:
        return datetime.strptime(str(iso), "%Y-%m-%d").strftime("%a %d %b")
    except (TypeError, ValueError):
        return str(iso or "")


def _footer(token: str | None) -> tuple[str, str]:
    parts_html, parts_text = [], []
    if APP_URL:
        parts_html.append(f'<a href="{APP_URL}">Open Job Transit</a>')
        parts_text.append(f"Open Job Transit: {APP_URL}")
    if token:
        link = f"{API_URL}/email/unsubscribe?token={token}"
        parts_html.append(f'<a href="{link}">Stop reminders and delete my email</a>')
        parts_text.append(f"Stop reminders and delete your email: {link}")
    return (f'<p style="color:#6b7480;font-size:13px;margin-top:24px">{" · ".join(parts_html)}</p>',
            "\n\n" + "\n".join(parts_text) if parts_text else "")


def plan_email(plan: dict, token: str | None) -> tuple[str, str, str]:
    occupation = str(plan.get("occupation") or "your next job")
    steps = [s for s in plan.get("steps") or [] if s.get("title")]
    rows_html, rows_text = [], []
    for s in steps:
        done = " (done)" if s.get("done") else ""
        practice = ""
        sessions = [x for x in s.get("sessions") or [] if not x.get("done")]
        if sessions and not s.get("done"):
            practice = f"Practice sessions: {', '.join(_nice_date(x.get('due', '')) for x in sessions)}"
        rows_html.append(
            f'<li style="margin:0 0 12px"><strong>{html.escape(s["title"])}</strong>{done}<br>'
            + (f'{_html_text(s.get("detail", ""))}<br>' if s.get("detail") else "")
            + "".join(f"&bull; {_html_text(r)}<br>" for r in (s.get("resources") or [])[:5])
            + f'<span style="color:#6b7480">By {_nice_date(s.get("due", ""))}'
            + (f" · {practice}" if practice else "") + "</span></li>")
        resources = "".join(f"\n  * {_plain(r)}" for r in (s.get("resources") or [])[:5])
        rows_text.append(f"- {s['title']}{done}\n  {_plain(s.get('detail', ''))}{resources}\n  By {_nice_date(s.get('due', ''))}"
                         + (f"\n  {practice}" if practice else ""))
    footer_html, footer_text = _footer(token)
    intro = ("Reminders are on. You'll get a short email on the day each step or practice session below is due."
             if token else "")
    subject = f"Reminders on: your plan toward {occupation}" if token else f"Your plan: {occupation}"
    body_html = (f'<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#15191e;max-width:560px">'
                 f'<h2 style="margin:0 0 4px">Your plan toward {html.escape(occupation)}</h2>'
                 + (f"<p>{html.escape(intro)}</p>" if intro else "")
                 + f'<p style="color:#4a525c">{_html_text(plan.get("summary", ""))}</p>'
                 f'<ol style="padding-left:20px">{"".join(rows_html)}</ol>{footer_html}</div>')
    body_text = (f"Your plan toward {occupation}\n\n" + (f"{intro}\n\n" if intro else "")
                 + f"{_plain(plan.get('summary', ''))}\n\n" + "\n\n".join(rows_text) + footer_text)
    return subject, body_html, body_text


def reminder_email(items: list[tuple[str, str, str]], occupation: str, token: str) -> tuple[str, str, str]:
    """items: (kind, title, due)."""
    def line(kind, title):
        return f"Practice session (10 min): {title}" if kind == "practice" else title
    footer_html, footer_text = _footer(token)
    subject = f"Due now: {line(*items[0][:2])}" + (f" and {len(items) - 1} more" if len(items) > 1 else "")
    body_html = (f'<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#15191e;max-width:560px">'
                 f'<p>From your plan toward {html.escape(occupation)}, due now:</p><ul>'
                 + "".join(f"<li>{html.escape(line(k, t))}</li>" for k, t, _ in items)
                 + "</ul><p>Practice sessions are short: test yourself or do one small exercise. The guide can quiz you "
                   "(Practise now in your plan).</p>" + footer_html + "</div>")
    body_text = f"From your plan toward {occupation}, due now:\n" + "\n".join(f"- {line(k, t)}" for k, t, _ in items) + footer_text
    return subject, body_html, body_text


# ---- storing reminders --------------------------------------------------------------------------
def _reminder_rows(token: str, plan: dict):
    today = date.today().isoformat()
    rows = []
    for s in plan.get("steps") or []:
        if s.get("done") or not s.get("title"):
            continue
        due = str(s.get("due") or "")
        if due >= today:
            rows.append((token, "step", str(s["title"])[:120], due))
        for x in s.get("sessions") or []:
            when = str(x.get("due") or "")
            if not x.get("done") and when >= today:
                rows.append((token, "practice", str(s["title"])[:120], when))
    return rows[:200]


def _replace_unsent(con, token: str, plan: dict):
    """Swap the unsent reminders for the plan's current ones, leaving out any already sent (a reminder sent this
    morning must not go out again because the plan was edited this afternoon)."""
    con.execute("DELETE FROM reminders WHERE token = ? AND sent_at IS NULL", (token,))
    sent = {tuple(r) for r in con.execute(
        "SELECT kind, title, due FROM reminders WHERE token = ? AND sent_at IS NOT NULL", (token,))}
    rows = [r for r in _reminder_rows(token, plan) if (r[1], r[2], r[3]) not in sent]
    con.executemany("INSERT INTO reminders (token, kind, title, due) VALUES (?, ?, ?, ?)", rows)


def subscribe(email: str, plan: dict) -> str:
    """Start (or restart) reminders for this address; returns the token for syncing and unsubscribing."""
    with _lock, closing(_connect()) as con, con:
        # always a new token: handing back an existing one would let anyone who knows an address take over its
        # reminders. An earlier subscription for the same address is replaced (its browser sees reminders off).
        for (old,) in con.execute("SELECT token FROM subscribers WHERE email = ?", (email,)).fetchall():
            con.execute("DELETE FROM reminders WHERE token = ?", (old,))
            con.execute("DELETE FROM subscribers WHERE token = ?", (old,))
        token = secrets.token_urlsafe(24)
        con.execute("INSERT OR REPLACE INTO subscribers VALUES (?, ?, ?, ?)",
                    (token, email, str(plan.get("occupation", ""))[:120], time.time()))
        _replace_unsent(con, token, plan)
    return token


def sync(token: str, plan: dict) -> bool:
    """The plan changed in the app: replace the unsent reminders. False if the token is unknown."""
    with _lock, closing(_connect()) as con, con:
        if not con.execute("SELECT 1 FROM subscribers WHERE token = ?", (token,)).fetchone():
            return False
        con.execute("UPDATE subscribers SET occupation = ? WHERE token = ?", (str(plan.get("occupation", ""))[:120], token))
        _replace_unsent(con, token, plan)
    return True


def unsubscribe(token: str) -> bool:
    with _lock, closing(_connect()) as con, con:
        found = con.execute("DELETE FROM subscribers WHERE token = ?", (token,)).rowcount
        con.execute("DELETE FROM reminders WHERE token = ?", (token,))
    return bool(found)


# ---- sending what's due -------------------------------------------------------------------------
def send_due(today: str | None = None) -> int:
    """Send one email per person with everything due today or earlier; returns how many emails went out."""
    today = today or date.today().isoformat()
    with closing(_connect()) as con:
        due = con.execute("""SELECT r.rowid, r.token, r.kind, r.title, r.due, s.email, s.occupation
                             FROM reminders r JOIN subscribers s ON s.token = r.token
                             WHERE r.sent_at IS NULL AND r.due <= ? ORDER BY r.due""", (today,)).fetchall()
    by_person: dict[str, list] = {}
    for row in due:
        by_person.setdefault(row[1], []).append(row)
    sent = 0
    for token, rows in by_person.items():
        email, occupation = rows[0][5], rows[0][6] or "your next job"
        subject, body_html, body_text = reminder_email([(r[2], r[3], r[4]) for r in rows], occupation, token)
        try:
            send(email, subject, body_html, body_text)
        except Exception as error:   # try again next round
            print(f"reminder to {email[:3]}… failed: {error}")
            continue
        with _lock, closing(_connect()) as con, con:
            con.executemany("UPDATE reminders SET sent_at = ? WHERE rowid = ?", [(time.time(), r[0]) for r in rows])
        sent += 1
    return sent


_sender_started = False


def start_reminder_sender(every_seconds: int = 900):
    global _sender_started
    if _sender_started or os.getenv("REMINDERS_SEND", "1") == "0" or not os.getenv("RESEND_API_KEY"):
        return
    _sender_started = True

    def loop():
        while True:
            try:
                if datetime.now(timezone.utc).hour >= SEND_HOUR_UTC:
                    send_due()
            except Exception as error:
                print(f"reminder sender: {error}")
            time.sleep(every_seconds)

    threading.Thread(target=loop, name="reminder-sender", daemon=True).start()
