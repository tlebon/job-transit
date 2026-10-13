.PHONY: dev api web assets

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
