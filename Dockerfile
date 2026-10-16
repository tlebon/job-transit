# The API (FastAPI + the planner engine). The web app has its own Dockerfile in web/.
FROM python:3.13-slim

# LightGBM needs OpenMP at runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

# Only what the API reads: its code and assets, and the committed model files in data/derived.
# Nothing else under data/ (person-level CPS rows must never leave Tim's machine).
COPY api/ api/
COPY data/derived/ data/derived/

ENV PATH="/app/.venv/bin:$PATH"
CMD ["sh", "-c", "uvicorn api.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
