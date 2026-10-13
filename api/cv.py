"""Reads a CV with Claude and turns it into planner inputs (job, education, skill ratings, tools).

The model fills a fixed JSON schema through a forced tool call, so the output is always structured.
Configure with ANTHROPIC_API_KEY (required) and ANTHROPIC_MODEL (optional) in the repo's .env file.
"""
import base64
import os
from functools import lru_cache

import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5")
MAX_PDF_BYTES = 8 * 1024 * 1024


def _schema(items, education_ladder):
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "One sentence on the person's career so far, in plain words."},
            "jobs": {
                "type": "array",
                "description": ("Roles from the CV, most recent first, max 6. Include full-time training programmes "
                                "(bootcamps, intensive courses) as kind 'program'; leave out degrees."),
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "Role as a short, common job title (e.g. 'Frontend developer'). For a programme, the field it trains for (e.g. 'Machine learning engineer')."},
                        "years": {"type": "number", "description": "Approximate years in this role."},
                        "current": {"type": "boolean", "description": "True if the role is ongoing ('present')."},
                        "kind": {"type": "string", "enum": ["job", "program"]},
                        "label": {"type": "string", "description": "How the CV names it, short (e.g. 'Engineering Manager, Wire')."},
                    },
                    "required": ["title", "current", "kind"],
                },
            },
            "education": {"type": "string", "enum": education_ladder + ["Unknown"],
                          "description": "Highest education completed."},
            "education_field": {"type": "string", "description": "Main field of study, or empty."},
            "years_experience": {"type": "number", "description": "Total years of work experience."},
            "activities": {"type": "array", "items": {"type": "string"},
                           "description": ("5-15 short statements of what the person actually does or did in recent "
                                           "roles, each starting with a verb, in plain words (e.g. 'Build internal "
                                           "dashboards for sales teams', 'Mentor junior engineers'). Most recent work first.")},
            "tools": {"type": "array", "items": {"type": "string"},
                      "description": "Software, tools, equipment or methods named in the CV. Max 15."},
            "skill_ratings": {
                "type": "object",
                "description": ("How important each item is in the person's most recent job, 1 (not important) to 5 "
                                "(extremely important). Only include items the CV gives real evidence for."),
                "properties": {item["key"]: {"type": "integer", "minimum": 1, "maximum": 5} for item in items},
            },
        },
        "required": ["summary", "jobs", "education", "activities", "skill_ratings"],
    }


def _item_guide(items):
    lines = []
    for item in items:
        label = f"Knowledge of {item['name']}" if item["kind"] == "knowledge" else item["name"]
        lines.append(f"- {item['key']}: {label}. {item['description']}")
    return "\n".join(lines)


def read_cv(items, education_ladder, text: str | None = None, pdf_base64: str | None = None):
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY is not set. Add it to .env in the repo root.")
    if pdf_base64 and len(base64.b64decode(pdf_base64)) > MAX_PDF_BYTES:
        raise ValueError("PDF is larger than 8 MB.")

    instructions = (
        "Read this CV and fill in the record_cv tool. Be conservative: rate a skill item only when the CV shows "
        "it matters in their most recent work, and rate it the way the person would if asked how important it "
        "is to their job. 'Engineering and Technology' means engineering of physical products or systems, not "
        "software development in general. 'Therapy and Counseling' means clinical or counseling work, not "
        "mentoring colleagues.\n\nSkill items:\n" + _item_guide(items)
    )
    content = []
    if pdf_base64:
        content.append({"type": "document",
                        "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_base64}})
    if text:
        content.append({"type": "text", "text": f"<cv>\n{text[:30000]}\n</cv>"})
    if not content:
        raise ValueError("Send CV text or a PDF.")
    content.append({"type": "text", "text": instructions})

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        tools=[{"name": "record_cv", "description": "Record what the CV says.",
                "input_schema": _schema(items, education_ladder)}],
        tool_choice={"type": "tool", "name": "record_cv"},
        messages=[{"role": "user", "content": content}],
    )
    for block in response.content:
        if block.type == "tool_use":
            return block.input
    raise RuntimeError("The model did not return a CV record.")


@lru_cache(maxsize=512)
def activities_from_text(text: str) -> tuple[str, ...]:
    """Rewrite a free-text description of someone's work as short task-like statements.

    Task statements in O*NET are verb-first ("Write supporting code for Web applications"); terse or chatty
    descriptions ("coding, infra stuff, slack") embed poorly against them, so this puts them in the same form.
    Raises RuntimeError without an API key; callers fall back to splitting the text as-is.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY is not set.")
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=600,
        tools=[{"name": "record_activities", "description": "Record the activities.", "input_schema": {
            "type": "object",
            "properties": {"activities": {"type": "array", "items": {"type": "string"},
                                          "description": "3-10 short statements, each starting with a verb, in plain words."}},
            "required": ["activities"]}}],
        tool_choice={"type": "tool", "name": "record_activities"},
        messages=[{"role": "user", "content": (
            "Rewrite this description of someone's work as short statements of what they actually do, "
            "each starting with a verb (e.g. 'Write code for web applications', 'Mentor junior engineers'). "
            "Keep their specifics (domain, tools, who they work with); don't invent anything.\n\n"
            f"<description>\n{text[:4000]}\n</description>")}],
    )
    for block in response.content:
        if block.type == "tool_use":
            return tuple(a for a in block.input.get("activities", []) if a.strip())
    return ()


@lru_cache(maxsize=512)
def describe_hobbies(text: str) -> tuple[str, ...]:
    """One plain sentence per hobby saying what doing it involves ('Bouldering: climbing short walls; a physical,
    problem-solving sport, often social'). Single words embed poorly; a sentence lets the embedding model match
    the hobby to O*NET interest areas. Raises RuntimeError without an API key."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY is not set.")
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=600,
        tools=[{"name": "record_hobbies", "description": "Record the hobbies.", "input_schema": {
            "type": "object",
            "properties": {"hobbies": {"type": "array", "items": {"type": "string"},
                                       "description": "One sentence per hobby: '<hobby>: what doing it involves'."}},
            "required": ["hobbies"]}}],
        tool_choice={"type": "tool", "name": "record_hobbies"},
        messages=[{"role": "user", "content": (
            "For each hobby or interest below, write one short sentence describing what doing it involves "
            "(activity, setting, skills used). Keep the person's own hobbies; don't add new ones.\n\n"
            f"<hobbies>\n{text[:2000]}\n</hobbies>")}],
    )
    for block in response.content:
        if block.type == "tool_use":
            return tuple(h for h in block.input.get("hobbies", []) if h.strip())
    return ()
