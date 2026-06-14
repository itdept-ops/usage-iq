# Usage IQ

A self-hosted dashboard for **filtering and visualizing your AI coding-agent token usage** — your "ccusage", across **multiple tools** (Claude Code + OpenAI Codex), with charts, cost, and drill-down. It reads each tool's local `*.jsonl` logs directly, de-duplicates and prices every message, stores it in **PostgreSQL**, and serves a filterable **Angular** dashboard from a **.NET 9** API.

[![CI](https://github.com/itdept-ops/usage-iq/actions/workflows/ci.yml/badge.svg)](https://github.com/itdept-ops/usage-iq/actions/workflows/ci.yml)

> Built with Angular 21 · .NET 9 · EF Core · PostgreSQL · Docker · ECharts.

![Usage IQ dashboard](docs/screenshots/dashboard.png)

## Screenshots

|  |  |
| --- | --- |
| **Landing** — Google sign-in | **Users & permissions** — per-user matrix |
| ![Landing](docs/screenshots/landing.png) | ![Users](docs/screenshots/users.png) |
| **Pricing** — editable per-model rates | **Settings** — sources, timezone, auto-sync |
| ![Pricing](docs/screenshots/pricing.png) | ![Settings](docs/screenshots/settings.png) |
| **Activity** — request/response action log | **Calendar** — daily heatmap + active hours |
| ![Activity](docs/screenshots/activity.png) | ![Calendar](docs/screenshots/calendar.png) |

---

## Why

Claude Code writes a JSONL transcript for every session under `~/.claude/projects/`. Those files contain per-message token `usage` (input, output, and 5-minute / 1-hour cache writes + cache reads) but **no cost**, and a single API turn is echoed across **many** lines. This app turns that raw firehose into an accurate, filterable picture of where your tokens and dollars go.

It mirrors how the [`ccusage`](https://github.com/ryoppippi/ccusage) CLI computes usage, but as a persistent, queryable web app — no npm dependency, and a pricing table you can edit.

## Sources

Pluggable per-tool parsers (add more by implementing `ISourceParser`):

| Source | Reads | Notes |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | De-dups on `message.id + requestId`; 5m/1h cache-write + cache-read tiers. |
| **Codex** (OpenAI) | `~/.codex/**/rollout-*.jsonl` | One row per `token_count` event using the per-turn `last_token_usage` delta; `cached_input_tokens` → cache-read, reasoning folded into output. |

Each source is enable/disable-able with an editable path on the **Settings** page.

## Features

- **Filter** by date range, project, model, **source**, and main-vs-subagent (sidechain) usage.
- **Quick date presets** — last 7 / 30 / 90 days, month-to-date, or all-time — alongside explicit from/to.
- **Shareable views** — the active filters are encoded in the URL (deep-linkable, restored on load) with a one-click **Copy link**.
- **Usage calendar** — a GitHub-style heatmap (cost / tokens / **active hours**) with estimated time-spent-with-AI per day (gap-based sessionization), busiest-day and session stats.
- **Group** the time series by day, month, project, model, source, or session.
- **Cost in USD** from an **editable per-model pricing table** (5m / 1h cache-write and cache-read tiers priced separately).
- **Charts**: usage-over-time (cost + tokens), top-N by dimension, and a cost-by-model donut (ECharts).
- **Sortable, paged message table** with project, model, token breakdown, and cost.
- **CSV export** of the currently-filtered rows, streamed from the server (no in-memory buffering).
- **One-click Sync** that incrementally re-reads only changed files.
- **Background auto-sync** on a timer (a .NET hosted service) + a live **"Synced Xm ago"** status in the command bar.
- **Audit log** of every user-management change — who did what, to whom, and when — on the Users page.
- **Action log** — every API request & response captured by middleware (truncated, with auth routes / secret fields / query-string tokens redacted; health and polling skipped), browsable and filterable on an admin **Activity** page.
- **Discord notifications** — post daily/weekly spend digests and a daily spend-threshold alert to a channel via an incoming webhook (configured in Settings; URL validated to genuine Discord hosts, stored masked, redacted from the action log).

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

## Authentication & access control

Sign-in is **Google** (Google Identity Services, with the "Continue as…" One-Tap). The server validates the Google ID token's signature, audience (your client id), issuer, and expiry, requires a **verified email**, and **pins each account to its Google subject id** (`sub`) — bound on first login, so a later login with the same email but a different Google account is rejected (a recycled address can't inherit access). Authorization is a **per-user permission set**, enforced **on every request**: the app JWT only proves *who* you are; the server re-loads your user row from the DB on each call and checks `IsEnabled` + the required permission. Disabling a user or removing a permission takes effect on their **next request** — no waiting for a token to expire.

Permission catalog: `dashboard.view`, `sync.run`, `pricing.manage`, `settings.manage`, `users.manage`. Admins manage everyone from the **Users** page (a user × permission matrix, enable toggles, add/remove) — gated by `users.manage`, with last-admin lockout protection.

**Secrets stay out of the repo.** The Google client id/secret, the JWT signing key, and the bootstrap admin/allow lists live in `src/Api/appsettings.Local.json` (git-ignored; copy from `appsettings.Local.example.json`). The API **refuses to start** without a strong `Jwt:Key`. Bootstrap: `Auth:AdminEmails` are seeded once as full admins; `Auth:AllowedEmails` as dashboard viewers.

> Google setup: in the OAuth client (Web application), add your origin (e.g. `http://localhost:4200`) to **Authorized JavaScript origins**, and make sure each user is allowed by the consent screen (test users / internal).

## Reliability & testing

- **Automated test suite** (`tests/Ccusage.Api.Tests`, run by CI): fast **unit tests** for the parsers, project resolver, pricing matcher, and permission catalog, plus **integration tests** that boot the real API against a throwaway PostgreSQL (**Testcontainers**) and assert the genuine auth/permission pipeline end-to-end — including *"disabling a user revokes access on the next request"*, last-admin-lockout, CSV-export gating, and audit-log writes. `dotnet test` runs everything.
- **Per-request authorization** — the JWT only proves identity; permissions are re-read from the DB on every call (see above).
- **Hardening**: a global exception handler (RFC 7807 problem-details, no stack traces leaked), a fixed-window **rate limiter** on the Google sign-in endpoint, **transient-fault retries** on the database connection (Npgsql resiliency; the transactional user-management paths run inside the execution strategy), and **liveness/readiness health checks** at `/api/health` and `/health/ready`.
- **Web tier**: nginx adds security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), gzip, and immutable caching of fingerprinted assets. The API image ships a container `HEALTHCHECK`, and Compose gates the web service on the API being healthy.

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
- Tests: `dotnet test` (the integration tests need a running Docker daemon for Testcontainers).

## Quick start (dev)

```bash
git clone https://github.com/itdept-ops/usage-iq.git
cd usage-iq
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
| `POST` | `/api/auth/google` | Exchange a Google ID token for an app JWT (allowlist enforced). |
| `GET` | `/api/auth/me`, `/api/auth/config` | Current user + live permissions / public Google client id. |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/users`, `/api/permissions` | User management (requires `users.manage`). |
| `POST` | `/api/sync` | Ingest new/changed JSONL files; returns counts + timing. |
| `GET` | `/api/sync/status` | Last-sync time + counts, whether a sync is running, and the auto-sync cadence. |
| `GET` | `/api/usage/summary` | Aggregates; params: `from,to,projectId[],model[],includeSidechain,groupBy`. |
| `GET` | `/api/usage/records` | Paged, sortable messages (same filters). |
| `GET` | `/api/usage/records.csv` | Streamed CSV of the filtered rows (requires `dashboard.view`). |
| `GET` | `/api/usage/calendar` | Per-day cost/tokens/messages + estimated active minutes & sessions. |
| `GET` / `PUT` / `POST` | `/api/notifications`, `/api/notifications/test` | Discord webhook config + test (requires `settings.manage`). |
| `GET` | `/api/audit` | Recent user-management audit entries (requires `users.manage`). |
| `GET` | `/api/logs` | Recent request/response action log; filter by `method`/`status`/`q` (requires `users.manage`). |
| `GET` | `/api/projects`, `/api/models`, `/api/sources` | Filter options with totals. |
| `GET` | `/api/health`, `/health/ready` | Liveness (anonymous) and readiness (DB connectivity) probes. |
| `PUT` | `/api/sources/{id}` | Edit a source's path / enabled flag. |
| `GET` / `PUT` | `/api/pricing`, `/api/pricing/{id}` | View / edit per-model rates. |
| `POST` | `/api/pricing/recompute` | Re-price stored rows from current rates (no file re-read). |
| `GET` / `PUT` | `/api/settings` | Display timezone + projects path. |

## Configuration

Set via `.env`, environment variables, or `src/Api/appsettings.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `ConnectionStrings__Default` | `Host=localhost;Port=5433;…` | Postgres connection. |
| `Ingestion__ClaudeProjectsPath` | `<UserProfile>/.claude/projects` | Claude Code logs (editable in Settings). |
| `Ingestion__CodexPath` | `<UserProfile>/.codex` | Codex logs (editable in Settings). |
| `Ingestion__DisplayTimeZone` | `America/New_York` | IANA zone for day/month bucketing. |
| `AutoSync__Enabled` | `true` | Run the background incremental sync on a timer. |
| `AutoSync__IntervalSeconds` | `300` | Auto-sync cadence (min 30s). |
| `Cors__AllowedOrigin` | `http://localhost:4200` | Angular dev origin. |

## A note on `claude-fable-5` pricing

`claude-fable-5` has no public price, so it ships with a **placeholder** rate (flagged in the UI). Set the real rate on the **Pricing** page and hit **Recompute** — all stored rows re-price instantly. The known Opus / Haiku rates are best-effort defaults and equally editable.

## Project structure

```
usage-iq/
├─ docker-compose.yml        # db (default) + api/web (--profile full)
├─ .github/workflows/ci.yml  # build API + Angular, run dotnet test
├─ tests/
│  └─ Ccusage.Api.Tests/     # xUnit: unit + Testcontainers integration tests
└─ src/
   ├─ Api/                   # .NET 9 minimal API
   │  ├─ Data/               # EF entities, DbContext, pricing seed
   │  ├─ Ingestion/          # JSONL parse, dedup, cost, project/timezone resolve
   │  ├─ Services/           # queries, recompute, sync coordinator, audit, Discord notifier
   │  ├─ Auth/               # JWT, per-request permission filter
   │  ├─ Infrastructure/     # global exception handler, request-logging middleware
   │  └─ Endpoints/          # API surface
   └─ Web/                   # Angular 21 (standalone + signals, ECharts)
      └─ src/app/{features/{dashboard,calendar,pricing,settings,users,logs,login},core,shared}
```

## License

[MIT](LICENSE)
