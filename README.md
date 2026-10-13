# Job Transit

Suggests realistic next jobs from your skills, interests and where people actually move between occupations
(US CPS ASEC 2015–2025, O*NET 31.0, BLS 2025–35 projections, AI exposure from Anthropic and Eloundou et al.).

## Layout

- `notebooks/01–06` — data prep, crosswalks, transitions, ranker, survey, outlook
- `data/derived/` — committed outputs the app reads (models, crosswalks, aggregates)
- `data/interim/`, `data/raw/` — not committed (IPUMS person rows, large rebuildable files, raw downloads)
- `api/` — FastAPI service that scores moves (`engine.py`) and serves the UI's data
- `web/` — Next.js app

## Run it locally

1. API (from the repo root):

   ```bash
   uv sync
   uv run python api/build_assets.py      # only after notebooks change
   uv run uvicorn api.app:app --reload --port 8000
   ```

2. Web app (second terminal):

   ```bash
   cd web
   npm install
   npm run dev
   ```

   Open http://localhost:3000. The app expects the API at http://localhost:8000; set
   `NEXT_PUBLIC_API_URL` in `web/.env.local` to point elsewhere.

## How a recommendation is made

1. With a job (typed or read from a CV), the starting point is that occupation. Answered skill questions move its
   O*NET profile a quarter of the way toward the person's ratings (self-ratings are noisy: ~1.2 points off O*NET).
2. Without a job, the answers place the person near their 5 closest occupations (cosine similarity plus Spearman
   rank correlation on the answered items), and the ranker's predictions from those stations are averaged.
3. Pair features (size, wage and zone differences, same major group, skill similarity) go into the ranker:
   LightGBM blended with observed 2015–2021 moves (k = 100) for a known job, Poisson for answer-based stations.
4. Interest fit comes from the chips (O*NET interest areas) and the activity quiz (RIASEC), as percentiles.
5. "Best fit" combines a log-scaled reach score with interest fit; growth, wage, education and AI exposure are shown per stop.
