# =============================================================================
# Pikly Enterprise — Developer Makefile  (cloud-first, no local Docker needed)
# =============================================================================
# QUICK START:
#   1. Copy .env.example → .env  and fill in DATABASE_URL etc.
#   2. make install
#   3. make db:migrate
#   4. make seed:python           (place products_cleaned in data/)
#   5. make sync
#   6. make dev
#
# DEPLOY (zero local server needed):
#   make deploy:api               Railway (free)
#   make deploy:proxy             Fly.io  (free)
#   git push origin main          GitHub Actions auto-deploys on every push
# =============================================================================
.PHONY: help install dev build lint format test test-api test-pipeline \
        db-migrate db-check seed-python seed-ts seed-categories seed-all \
        sync build-native build-go deploy-api deploy-proxy clean env-check

SHELL   := /bin/bash
API     := ./api
PL      := ./pipeline
PROXY   := ./services/cache-proxy
RANKER  := ./native/ranker

help:
	@echo ""
	@echo "Pikly Enterprise v4.0.0 — cloud-first (Neon + Upstash + Railway + Fly.io)"
	@echo ""
	@echo "Setup:     make install | make env-check"
	@echo "Dev:       make dev | make build"
	@echo "DB:        make db-migrate | make db-check"
	@echo "Seed:      make seed-python | make seed-ts | make seed-all"
	@echo "Search:    make sync"
	@echo "Test:      make test | make test-api | make test-pipeline"
	@echo "Optional:  make build-native | make build-go"
	@echo "Deploy:    make deploy-api | make deploy-proxy"
	@echo ""
	@echo "See DEPLOYMENT.md for full free-cloud setup guide."

env-check:
	@[ -n "$$DATABASE_URL" ] && echo "OK: DATABASE_URL" || echo "MISSING: DATABASE_URL"
	@[ -n "$$REDIS_URL" ]    && echo "OK: REDIS_URL"    || echo "WARN: REDIS_URL (Redis disabled)"
	@[ -n "$$JWT_SECRET" ]   && echo "OK: JWT_SECRET"   || echo "MISSING: JWT_SECRET"
	@[ -n "$$ALGOLIA_APP_ID" ] && echo "OK: ALGOLIA_APP_ID" || echo "WARN: ALGOLIA_APP_ID (search fallback)"

install:
	cd $(API) && npm install
	cd $(PL)  && pip install -r requirements.txt --quiet
	@echo "Done."

dev:
	cd $(API) && npm run start:dev

build:
	cd $(API) && npm run build

lint:
	cd $(API) && npm run lint

format:
	cd $(API) && npm run format

test: test-api test-pipeline

test-api:
	cd $(API) && npm test -- --passWithNoTests

test-pipeline:
	cd $(PL) && python -c "\
from validate import EnrichedProduct; \
from transform import compute_discount, slugify; \
assert compute_discount(21.99, 25.70) == 14; \
assert slugify('Hello World!') == 'hello-world'; \
print('Pipeline tests: PASS')"

db-migrate:
	@[ -n "$$DATABASE_URL" ] || (echo "Set DATABASE_URL first" && exit 1)
	psql "$$DATABASE_URL" -f $(API)/sql/001_schema_neon.sql 2>&1 | tail -3
	psql "$$DATABASE_URL" -f $(API)/sql/002_cil_schema.sql  2>&1 | tail -3
	psql "$$DATABASE_URL" -f $(API)/sql/003_app_schema.sql  2>&1 | tail -3
	psql "$$DATABASE_URL" -f $(API)/sql/004_new_dataset_columns.sql 2>&1 | tail -3
	@echo "Schema applied."

db-check:
	psql "$$DATABASE_URL" -c "SELECT COUNT(*) AS cols FROM information_schema.columns WHERE table_schema='store' AND table_name='products'"

seed-categories:
	cd $(API) && npx ts-node scripts/seed-categories-pg.ts

seed-python:
	@[ -n "$$DATABASE_URL" ] || (echo "Set DATABASE_URL first" && exit 1)
	@JSONL=$$(ls $(API)/data/products_cleaned.jsonl data/products_cleaned.jsonl 2>/dev/null | head -1); \
	[ -n "$$JSONL" ] || (echo "Put products_cleaned.jsonl in api/data/ or data/" && exit 1); \
	cd $(PL) && python ingest.py $$JSONL --batch 300

seed-ts:
	cd $(API) && npx ts-node scripts/seed-pg.ts

seed-all: seed-categories seed-python sync

sync:
	cd $(API) && npx ts-node scripts/sync-algolia-pg.ts

build-native:
	cd $(RANKER) && npm install && npm run build:release

build-go:
	cd $(PROXY) && go mod tidy && \
	  CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/cache-proxy ./cmd/server

deploy-api:
	@which railway > /dev/null 2>&1 || npm install -g @railway/cli
	cd $(API) && railway up --service pikly-api

deploy-proxy:
	@which flyctl > /dev/null 2>&1 || (echo "Install flyctl: curl -L https://fly.io/install.sh | sh" && exit 1)
	cd $(PROXY) && flyctl deploy --remote-only

clean:
	rm -rf $(API)/dist $(RANKER)/build
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
