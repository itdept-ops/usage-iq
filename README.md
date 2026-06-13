# ccusage-dashboard

A self-hosted dashboard for **filtering and visualizing your Claude Code token usage** — your "ccusage", with charts, cost, and drill-down. It reads Claude Code's local `*.jsonl` transcripts directly, de-duplicates and prices every message, stores it in **PostgreSQL**, and serves a filterable **Angular** dashboard from a **.NET 9** API.

[![CI](https://github.com/itdept-ops/ccusage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/itdept-ops/ccusage-dashboard/actions/workflows/ci.yml)

> Built with Angular 21 · .NET 9 · EF Core · PostgreSQL · Docker · ECharts.

---

## Why

Claude Code writes a JSONL transcript for every session under `~/.claude/projects/`. Those files contain per-message token `usage` (input, output, and 5-minute / 1-hour cache writes + cache reads) but **no cost**, and a single API turn is echoed across **many** lines. This app turns that raw firehose into an accurate, filterable picture of where your tokens and dollars go.

It mirrors how the [`ccusage`](https://github.com/ryoppippi/ccusage) CLI computes usage, but as a persistent, queryable web app — no npm dependency, and a pricing table you can edit.

## Features

- **Filter** by date range, project, model, and main-vs-subagent (sidechain) usage.
- **Group** the time series by day, month, project, model, or session.
- **Cost in USD** from an **editable per-model pricing table** (5m / 1h cache-write and cache-read tiers priced separately).
- **Charts**: usage-over-time (cost + tokens), top-N by dimension, and a cost-by-model donut (ECharts).
- **Sortable, paged message table** with project, model, token breakdown, and cost.
- **One-click Sync** that incrementally re-reads only changed files.

## How it handles the data correctly

These are the traps the ingestion pipeline is built around (validated against a real 2,264-file / 218k-line corpus):

| Reality | Handling |
| --- | --- |
| ~52% of raw assistant lines are **intra-file duplicates** (one turn → many lines, same `usage`) | De-duplicate on `message.id + requestId`; keep one row. Counting raw would ~double everything. |
| **5 models** with inconsistent ids (`claude-opus-4-8` vs `claude-haiku-4-5-20251001`) | Pricing lookup is exact → longest-prefix → `*` fallback; unpriced models are surfaced, never silently $0. |
| **5m vs 1h cache writes** are priced differently; cache reads dominate volume (~11B tokens) | Each tier stored and priced independently; rollups use 64-bit sums. |
| **Subagent / sidechain** turns are ~68% of spend, in nested `subagents/` folders | Counted by default, with a UI toggle to exclude. |
| Folder names are a **lossy** path encoding | Project identity is derived from each record's `cwd`; worktrees collapse to their parent repo. |
| Timestamps are **UTC** | Bucketed into days/months in a configurable display timezone (default `America/New_York`). |
| Re-running sync | Incremental: unchanged files (same size + mtime) are skipped; only grown/rotated files are reparsed; inserts are idempotent. |

## Architecture

```
┌─────────────┐     /api (proxy)     ┌──────────────┐   EF Core / Npgsql   ┌────────────┐
│  Angular 21 │ ───────────────────▶ │   .NET 9 API │ ───────────────────▶ │ PostgreSQL │
│  (ECharts)  │                      │  ingest+query│                      │  (Docker)  │
└─────────────┘                      └──────┬───────┘                      └────────────┘
                                            │ reads *.jsonl
                                            ▼
                                 ~/.claude/projects/**/*.jsonl
```

- **Dev**: Postgres in Docker; API (`dotnet run`) and Angular (`ng serve`) on the host so the API can read your local `.claude` folder.
- **Full stack**: `docker compose --profile full up` runs all three; the API container reads the logs from a read-only bind mount.

## Prerequisites

- .NET SDK 9, Node 20+ / Angular CLI, Docker Desktop. (`dotnet ef` tool for migrations: `dotnet tool install --global dotnet-ef`.)

## Quick start (dev)

```bash
git clone https://github.com/itdept-ops/ccusage-dashboard.git
cd ccusage-dashboard
cp .env.example .env            # adjust if needed

# 1. Database
docker compose up -d db         # Postgres on host port 5433

# 2. API (applies migrations + seeds pricing on startup)
cd src/Api
dotnet run --urls http://localhost:5180
#   Swagger:  http://localhost:5180/swagger

# 3. Web (in another terminal)
cd src/Web
npm install
npm start                       # http://localhost:4200  (proxies /api → :5180)
```

Open <http://localhost:4200>, click **Sync** to ingest your usage, then filter away.

## Full Docker stack

```bash
docker compose --profile full up --build
# web → http://localhost:4200 , api → http://localhost:5180/swagger
```

The API container mounts `${CLAUDE_PROJECTS_PATH}` (from `.env`) read-only at `/data/claude`.

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/sync` | Ingest new/changed JSONL files; returns counts + timing. |
| `GET` | `/api/usage/summary` | Aggregates; params: `from,to,projectId[],model[],includeSidechain,groupBy`. |
| `GET` | `/api/usage/records` | Paged, sortable messages (same filters). |
| `GET` | `/api/projects`, `/api/models` | Filter options with totals. |
| `GET` / `PUT` | `/api/pricing`, `/api/pricing/{id}` | View / edit per-model rates. |
| `POST` | `/api/pricing/recompute` | Re-price stored rows from current rates (no file re-read). |
| `GET` / `PUT` | `/api/settings` | Display timezone + projects path. |

## Configuration

Set via `.env`, environment variables, or `src/Api/appsettings.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `ConnectionStrings__Default` | `Host=localhost;Port=5433;…` | Postgres connection. |
| `Ingestion__ClaudeProjectsPath` | `<UserProfile>/.claude/projects` | Source of JSONL logs (editable in Settings). |
| `Ingestion__DisplayTimeZone` | `America/New_York` | IANA zone for day/month bucketing. |
| `Cors__AllowedOrigin` | `http://localhost:4200` | Angular dev origin. |

## A note on `claude-fable-5` pricing

`claude-fable-5` has no public price, so it ships with a **placeholder** rate (flagged in the UI). Set the real rate on the **Pricing** page and hit **Recompute** — all stored rows re-price instantly. The known Opus / Haiku rates are best-effort defaults and equally editable.

## Project structure

```
ccusage-dashboard/
├─ docker-compose.yml        # db (default) + api/web (--profile full)
├─ .github/workflows/ci.yml  # build API + Angular
└─ src/
   ├─ Api/                   # .NET 9 minimal API
   │  ├─ Data/               # EF entities, DbContext, pricing seed
   │  ├─ Ingestion/          # JSONL parse, dedup, cost, project/timezone resolve
   │  ├─ Services/           # queries + recompute
   │  └─ Endpoints/          # API surface
   └─ Web/                   # Angular 21 (standalone + signals, ECharts)
      └─ src/app/{features/dashboard,features/pricing,features/settings,core,shared}
```

## License

[MIT](LICENSE)
