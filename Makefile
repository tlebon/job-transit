.PHONY: dev api web assets deploy-api deploy-web

# Start the API (port 8000) and the web app (port 3000) together; Ctrl+C stops both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) api & \
	$(MAKE) web & \
	wait

api:
	uv run uvicorn api.app:app --reload --port 8000

web:
	cd web && npm run dev

# Rebuild api/assets after the notebooks change
assets:
	uv run python api/build_assets.py

# Deploy to Railway. Run from the repo root. The web app needs --path-as-root so web/ is the top of the upload
# and Railway builds web/Dockerfile; without it Railway builds the root Dockerfile (the API) for the web service.
deploy-api:
	railway up --service api

deploy-web:
	railway up web --path-as-root --service web
